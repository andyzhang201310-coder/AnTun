//! WARP 凭证身份管理
//!
//! 背景：内置凭证是硬编码在安装包里的共享设备密钥（公开可提取），多人共用同一身份时
//! Cloudflare 会把所有安装视为同一台设备，可能互相顶掉。这里在首次启动时为**本机**
//! 匿名注册一把独享密钥：
//!
//! - 注册接口匿名、免费，不需要邮箱/手机号，只换取一对设备密钥 + 隧道地址；
//! - 注册失败（无网络、接口变更等）不会影响使用，继续回退内置凭证；
//! - 用户手动导入的凭证始终优先，`source = "user"`，不会被自动覆盖。
//!
//! 密钥对用 X25519 本地生成（私钥永不出本机），只把公钥交给服务端。

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Serialize;
use std::path::Path;
use tauri::{AppHandle, Emitter};
use x25519_dalek::{PublicKey, StaticSecret};

use crate::core::{
    cred_path, fill_defaults, proxy_free_command, WarpCredential, BUILTIN_INNER_HOST, BUILTIN_INNER_KEY,
    BUILTIN_MASQUE_KEY, BUILTIN_MASQUE_PEER, BUILTIN_OUTER_KEY,
};

/// Cloudflare WARP 匿名注册端点（与主流第三方客户端一致）
const REG_URL: &str = "https://api.cloudflareclient.com/v0a2158/reg";
/// 注册接口要求的客户端版本头，过旧会被拒
const CF_CLIENT_VERSION: &str = "a-6.30-3596";

/// 凭证来源：用户导入 / 本机自动注册 / 内置共享
pub fn source_of(cred: &WarpCredential) -> &'static str {
    if cred.source == "user" {
        return "user";
    }
    if cred.source == "auto" {
        return "auto";
    }
    if cred.private_key.is_empty() || cred.private_key == BUILTIN_OUTER_KEY {
        "builtin"
    } else {
        // 老版本存档没有 source 字段，但密钥不是内置的 → 视为用户自备
        "user"
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialInfo {
    /// user / auto / builtin
    pub source: String,
    /// 是否为本机独享身份（user 或 auto）
    pub unique: bool,
    pub address_v4: String,
    pub address_v6: String,
    pub endpoint: String,
}

/// 查询当前凭证身份（设置页用于显示"独享 / 共享"）
#[tauri::command]
pub fn credential_info(app: AppHandle) -> Result<CredentialInfo, String> {
    let path = cred_path(&app)?;
    let cred = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<WarpCredential>(&t).ok())
        .map(fill_defaults)
        .unwrap_or_else(crate::core::builtin_credential);
    let src = source_of(&cred).to_string();
    Ok(CredentialInfo {
        unique: src != "builtin",
        source: src,
        address_v4: cred.address_v4.clone(),
        address_v6: cred.address_v6.clone(),
        endpoint: format!("{}:{}", cred.endpoint_host, cred.endpoint_port),
    })
}

fn b64(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

/// 本地生成一对 X25519 密钥（WireGuard 规格），私钥不离开本机
pub fn gen_keypair() -> Result<(String, String), String> {
    let mut seed = [0u8; 32];
    getrandom::getrandom(&mut seed).map_err(|e| format!("生成随机数失败: {}", e))?;
    let secret = StaticSecret::from(seed);
    let public = PublicKey::from(&secret);
    Ok((b64(&secret.to_bytes()), b64(public.as_bytes())))
}

struct Registered {
    private_key: String,
    peer_public_key: String,
    address_v4: String,
    address_v6: String,
    endpoint_host: String,
}

/// 调一次注册接口，换回该设备的地址与对端公钥
fn register_once() -> Result<Registered, String> {
    let (private_key, public_key) = gen_keypair()?;
    let body = serde_json::json!({
        "key": public_key,
        "install_id": "",
        "fcm_token": "",
        "tos": "2021-09-14T10:00:00.000+08:00",
        "model": "PC",
        "type": "Windows",
        "locale": "en_US",
    });
    let out = proxy_free_command("curl.exe")
        .args([
            "-s",
            "-m",
            "20",
            "-X",
            "POST",
            REG_URL,
            "-H",
            &format!("CF-Client-Version: {}", CF_CLIENT_VERSION),
            "-H",
            "Accept: application/json",
            "-H",
            "Content-Type: application/json",
            "-H",
            "User-Agent: okhttp/3.12.1",
            "--data-binary",
            &body.to_string(),
        ])
        .output()
        .map_err(|e| format!("调用 WARP 注册接口失败: {}", e))?;

    let text = String::from_utf8_lossy(&out.stdout).to_string();
    if text.trim().is_empty() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("注册接口无响应: {}", err.trim()));
    }
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("注册响应解析失败: {}", e))?;

    let peer = v["config"]["peers"][0]["public_key"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("注册响应缺少 peer 公钥: {}", text.chars().take(120).collect::<String>()))?
        .to_string();
    let v4 = v["config"]["interface"]["addresses"]["v4"]
        .as_str()
        .unwrap_or_default()
        .split('/')
        .next()
        .unwrap_or_default()
        .to_string();
    let v6 = v["config"]["interface"]["addresses"]["v6"]
        .as_str()
        .unwrap_or_default()
        .split('/')
        .next()
        .unwrap_or_default()
        .to_string();
    // 注册响应里的 endpoint.v4 形如 "162.159.192.10:0"，只取 IP
    let endpoint_host = v["config"]["peers"][0]["endpoint"]["v4"]
        .as_str()
        .and_then(|s| s.split(':').next())
        .filter(|s| !s.is_empty())
        .unwrap_or("162.159.192.1")
        .to_string();

    if v4.is_empty() || peer.is_empty() {
        return Err("注册响应字段不完整".into());
    }

    Ok(Registered {
        private_key,
        peer_public_key: peer,
        address_v4: v4,
        address_v6: v6,
        endpoint_host,
    })
}

/// 注册一份完整凭证：外层 + 内层（GOOL 双层 WARP 需要两套设备身份）
fn register_identity() -> Result<WarpCredential, String> {
    let outer = register_once()?;
    // 内层失败不阻断：仍然可以用外层身份
    let inner = register_once().ok();
    Ok(WarpCredential {
        private_key: outer.private_key,
        peer_public_key: outer.peer_public_key,
        address_v4: outer.address_v4,
        address_v6: outer.address_v6,
        endpoint_host: outer.endpoint_host,
        endpoint_port: 2408,
        inner_private_key: inner
            .as_ref()
            .map(|i| i.private_key.clone())
            .unwrap_or_else(|| BUILTIN_INNER_KEY.to_string()),
        inner_endpoint_host: inner
            .as_ref()
            .map(|i| i.endpoint_host.clone())
            .unwrap_or_else(|| BUILTIN_INNER_HOST.to_string()),
        inner_endpoint_port: 2408,
        // MASQUE 使用独立的 ECDSA 身份，注册流程不同，暂时沿用内置密钥
        masque_private_key: BUILTIN_MASQUE_KEY.to_string(),
        masque_public_key: BUILTIN_MASQUE_PEER.to_string(),
        source: "auto".into(),
    })
}

fn write_cred(path: &Path, cred: &WarpCredential) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(
        path,
        serde_json::to_string_pretty(cred).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("保存凭证: {}", e))
}

/// 首次启动时确保本机有独享身份：
/// - 已有用户自备凭证 → 原样保留
/// - 只有内置凭证（含旧版本复制过来的内置密钥）→ 注册新身份，旧文件备份为 `.builtin-backup`
/// - 注册失败 → 继续用内置凭证，不影响连接
pub fn ensure_identity(app: &AppHandle) -> Result<String, String> {
    let path = cred_path(app)?;
    let result = ensure_identity_with(&path, register_identity);
    match &result {
        Ok(src) => {
            let _ = app.emit(
                "antun-credential",
                serde_json::json!({ "kind": "registered", "source": src, "ok": true }),
            );
        }
        Err(e) => {
            let _ = app.emit(
                "antun-credential",
                serde_json::json!({ "kind": "registered", "source": "builtin", "ok": false, "error": e }),
            );
        }
    }
    result
}

/// 与 `ensure_identity` 同逻辑，但把"注册"抽象成回调，便于单测不依赖网络。
pub fn ensure_identity_with(
    path: &Path,
    register: impl FnOnce() -> Result<WarpCredential, String>,
) -> Result<String, String> {
    if let Ok(text) = std::fs::read_to_string(path) {
        if let Ok(mut cred) = serde_json::from_str::<WarpCredential>(&text) {
            let src = source_of(&cred);
            if src == "user" || src == "auto" {
                if cred.source.is_empty() {
                    cred.source = src.into();
                    let _ = write_cred(path, &cred);
                }
                return Ok(src.into());
            }
            // 内置密钥：备份后升级为本机独享身份
            let _ = std::fs::rename(path, path.with_extension("json.builtin-backup"));
        }
    }

    let cred = register()?;
    write_cred(path, &cred)?;
    Ok(cred.source.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::BUILTIN_WARP_PEER;

    #[test]
    fn keypair_is_valid_wireguard_size() {
        let (priv_b64, pub_b64) = gen_keypair().unwrap();
        let p = B64.decode(priv_b64.as_bytes()).unwrap();
        let q = B64.decode(pub_b64.as_bytes()).unwrap();
        assert_eq!(p.len(), 32, "X25519 私钥必须是 32 字节");
        assert_eq!(q.len(), 32, "X25519 公钥必须是 32 字节");
        // 每次生成必须不同，否则等于所有人共用一把
        let (priv2, _) = gen_keypair().unwrap();
        assert_ne!(priv_b64, priv2);
    }

    #[test]
    fn source_classification() {
        let mut c = WarpCredential::default();
        c.private_key = BUILTIN_OUTER_KEY.into();
        assert_eq!(source_of(&c), "builtin");

        c.private_key = "AO9FFXpvI2abd29iiuIskLoRg3nkT3j1VGs1M/1cj4=".into();
        assert_eq!(source_of(&c), "user");

        c.source = "auto".into();
        assert_eq!(source_of(&c), "auto");

        c.source = "user".into();
        assert_eq!(source_of(&c), "user");
    }

    fn tmp_path(tag: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("antun-cred-test-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p.join("warp-credential.json")
    }

    fn fake_cred(source: &str) -> WarpCredential {
        WarpCredential {
            private_key: "ZmFrZS1wcml2YXRlLWtleS0zMmJ5dGVzLWxvbmchIQ==".into(),
            peer_public_key: BUILTIN_WARP_PEER.into(),
            address_v4: "172.16.0.2".into(),
            source: source.into(),
            ..Default::default()
        }
    }

    #[test]
    fn registers_when_no_credential_exists() {
        let path = tmp_path("fresh");
        let src = ensure_identity_with(&path, || Ok(fake_cred("auto"))).unwrap();
        assert_eq!(src, "auto");
        assert!(path.exists());
        let saved: WarpCredential =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved.source, "auto");
    }

    #[test]
    fn migrates_builtin_credential_to_unique_identity() {
        let path = tmp_path("builtin");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut builtin = fake_cred("");
        builtin.private_key = BUILTIN_OUTER_KEY.into();
        std::fs::write(&path, serde_json::to_string(&builtin).unwrap()).unwrap();

        let src = ensure_identity_with(&path, || Ok(fake_cred("auto"))).unwrap();
        assert_eq!(src, "auto", "内置身份应被升级为本机独享");
        let backup = path.with_extension("json.builtin-backup");
        assert!(backup.exists(), "旧文件应备份，便于回滚");
        let saved: WarpCredential =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_ne!(saved.private_key, BUILTIN_OUTER_KEY);
    }

    #[test]
    fn keeps_user_credential_untouched() {
        let path = tmp_path("user");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut user = fake_cred("user");
        user.private_key = "dXNlci1vd24ta2V5LTMyLWJ5dGVzLWxvbmchISE=".into();
        std::fs::write(&path, serde_json::to_string(&user).unwrap()).unwrap();

        let src = ensure_identity_with(&path, || panic!("用户自备凭证时不应再注册")).unwrap();
        assert_eq!(src, "user");
        let saved: WarpCredential =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved.private_key, user.private_key);
    }

    #[test]
    fn registration_failure_keeps_builtin_usable() {
        let path = tmp_path("fail");
        let r = ensure_identity_with(&path, || Err("network down".into()));
        assert!(r.is_err());
        // 没有写出半成品凭证：上层 load_credential 会回退内置凭证
        assert!(!path.exists());
    }

    /// 真实调用注册接口：验证"每台机器一把独享密钥"确实拿得到地址与对端公钥。
    /// 需要外网，属于集成测试，默认不随 `cargo test` 的快速用例混跑时可用 --ignored 单独执行。
    #[test]
    #[ignore]
    fn registers_real_identity() {
        let cred = register_identity().expect("注册失败");
        assert!(!cred.private_key.is_empty());
        assert!(!cred.address_v4.is_empty());
        assert_eq!(cred.source, "auto");
        // 注册回来的地址必须是本机自己的，不能等于内置凭证的身份
        assert_ne!(cred.private_key, BUILTIN_OUTER_KEY);
    }
}
