//! AnTun 真实连接核心管理
//!
//! 设计原则：
//! 1. 安装包不含 mihomo 二进制（保持轻量），首次连接时按需从镜像下载到用户数据目录
//! 2. 所有"已连接"状态必须基于真实出口探测（HTTP 请求经本地代理拿到公网 IP）
//! 3. 任何失败都如实返回错误，绝不返回伪造的出口 IP / 延迟

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use windows_sys::Win32::Networking::WinInet::{
    InternetSetOptionW, INTERNET_OPTION_REFRESH, INTERNET_OPTION_SETTINGS_CHANGED,
};
#[cfg(windows)]
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
#[cfg(windows)]
use winreg::RegKey;

const MIHOMO_VERSION: &str = "v1.19.34";
const GH_PROXY: &str = "https://ghfast.top/";
const GH_ORIGIN: &str = "https://github.com/MetaCubeX/mihomo/releases/download/";

#[derive(Default)]
pub struct CoreState {
    child: Mutex<Option<Child>>,
}

#[derive(Default, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct WarpCredential {
    /// WireGuard 私钥（base64）
    pub private_key: String,
    /// WARP 服务端公钥（base64）
    pub peer_public_key: String,
    /// 分配的客户端 IPv4 地址
    pub address_v4: String,
    /// 分配的客户端 IPv6 地址（可选）
    pub address_v6: String,
    /// 服务端地址
    pub endpoint_host: String,
    /// 服务端 UDP 端口（通常 2408）
    pub endpoint_port: u16,
    /// GOOL（两层 WARP）所需的内层私钥
    pub inner_private_key: String,
    /// 内层 WARP 端点主机
    pub inner_endpoint_host: String,
    /// 内层 WARP 端点端口
    pub inner_endpoint_port: u16,
    /// MASQUE 协议所需 ECDSA 私钥（base64 DER）
    pub masque_private_key: String,
    /// MASQUE 协议所需服务端公钥（base64 DER，已去掉 PEM 头尾）
    pub masque_public_key: String,
}

const MASQUE_SERVER: &str = "162.159.198.1";
const MASQUE_SNI: &str = "consumer-masque.cloudflareclient.com";
const MASQUE_PORT: u16 = 500;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CoreResult {
    pub ok: bool,
    pub exit_ip: String,
    pub country: String,
    pub city: String,
    pub colo: String,
    pub latency: u32,
    pub error: String,
}

impl CoreResult {
    fn fail(msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            exit_ip: String::new(),
            country: String::new(),
            city: String::new(),
            colo: String::new(),
            latency: 0,
            error: msg.into(),
        }
    }
}

/// Windows 下所有子进程都隐藏控制台窗口：
/// mihomo / curl / powershell 都是控制台程序，直接 Command::new 会闪出黑框。
fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd
}

fn app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {}", e))
}

fn core_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_dir(app)?.join("mihomo.exe"))
}

fn cred_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_dir(app)?.join("warp-credential.json"))
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_dir(app)?.join("config.yaml"))
}

fn proxy_snapshot_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_dir(app)?.join("proxy-snapshot.json"))
}

const PROXY_BYPASS: &str = "<local>;127.0.0.1;localhost;*.local";

/// 系统代理原始状态快照。只在本 App 成功设置代理时写入，断开时据此还原。
#[derive(Default, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProxySnapshot {
    enabled: u32,
    server: String,
    had_server: bool,
    bypass: String,
    had_bypass: bool,
}

fn load_snapshot(app: &AppHandle) -> Result<Option<ProxySnapshot>, String> {
    let path = proxy_snapshot_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(serde_json::from_str(&text).ok())
}

fn save_snapshot(app: &AppHandle, snapshot: &ProxySnapshot) -> Result<(), String> {
    let path = proxy_snapshot_path(app)?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(path, serde_json::to_string_pretty(snapshot).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

#[cfg(windows)]
fn current_proxy_snapshot() -> Result<ProxySnapshot, String> {
    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
        .map_err(|e| format!("打开代理设置: {}", e))?;
    let enabled = key.get_value("ProxyEnable").unwrap_or(0u32);
    let server: String = key.get_value("ProxyServer").unwrap_or_default();
    let bypass: String = key.get_value("ProxyOverride").unwrap_or_default();
    Ok(ProxySnapshot {
        enabled,
        had_server: !server.is_empty(),
        server,
        had_bypass: !bypass.is_empty(),
        bypass,
    })
}

#[cfg(not(windows))]
fn current_proxy_snapshot() -> Result<ProxySnapshot, String> {
    Ok(ProxySnapshot::default())
}

#[cfg(windows)]
fn apply_proxy_snapshot(s: &ProxySnapshot) -> Result<(), String> {
    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(
            "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
            KEY_READ | KEY_WRITE,
        )
        .map_err(|e| format!("打开代理设置: {}", e))?;
    key.set_value("ProxyEnable", &s.enabled).map_err(|e| e.to_string())?;
    if s.had_server {
        key.set_value("ProxyServer", &s.server).map_err(|e| e.to_string())?;
    } else {
        let _ = key.delete_value("ProxyServer");
    }
    if s.had_bypass {
        key.set_value("ProxyOverride", &s.bypass).map_err(|e| e.to_string())?;
    } else {
        let _ = key.delete_value("ProxyOverride");
    }
    Ok(())
}

#[cfg(not(windows))]
fn apply_proxy_snapshot(_s: &ProxySnapshot) -> Result<(), String> {
    Ok(())
}

/// 通知 WinINET / 浏览器立即刷新代理设置，无需重启浏览器。
#[cfg(windows)]
fn refresh_proxy_settings() {
    unsafe {
        InternetSetOptionW(
            std::ptr::null(),
            INTERNET_OPTION_SETTINGS_CHANGED,
            std::ptr::null(),
            0,
        );
        InternetSetOptionW(std::ptr::null(), INTERNET_OPTION_REFRESH, std::ptr::null(), 0);
    }
}

#[cfg(not(windows))]
fn refresh_proxy_settings() {}

/// 连接成功后把浏览器/系统流量切到本地 mihomo 端口。
fn set_system_proxy(app: &AppHandle, port: u16) -> Result<(), String> {
    // 已保存过快照说明本 App 正在管理代理，不覆盖用户原始状态
    if load_snapshot(app)?.is_none() {
        save_snapshot(app, &current_proxy_snapshot()?)?;
    }
    #[cfg(windows)]
    {
        let key = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(
                "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
                KEY_READ | KEY_WRITE,
            )
            .map_err(|e| format!("打开代理设置: {}", e))?;
        key.set_value("ProxyEnable", &1u32).map_err(|e| e.to_string())?;
        key.set_value("ProxyServer", &format!("127.0.0.1:{}", port))
            .map_err(|e| e.to_string())?;
        key.set_value("ProxyOverride", &PROXY_BYPASS).map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    let _ = port;
    refresh_proxy_settings();
    Ok(())
}

/// 恢复连接前的系统代理状态。
fn restore_system_proxy(app: &AppHandle) -> Result<(), String> {
    let Some(snapshot) = load_snapshot(app)? else {
        return Ok(());
    };
    apply_proxy_snapshot(&snapshot)?;
    refresh_proxy_settings();
    let _ = std::fs::remove_file(proxy_snapshot_path(app)?);
    Ok(())
}

/// 上次异常退出留下的代理快照：启动时自动还原，避免指向已死掉的本地端口。
pub fn restore_orphan_proxy(app: &AppHandle) {
    if proxy_snapshot_path(app).map(|p| p.exists()).unwrap_or(false) {
        let _ = restore_system_proxy(app);
    }
}

/// 统一停止核心子进程。
fn stop_child(state: &tauri::State<'_, CoreState>) {
    if let Ok(mut guard) = state.child.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// 供内核更新命令判断是否有正在运行的隧道，避免替换被占用的 exe。
pub fn is_running(state: &tauri::State<'_, CoreState>) -> bool {
    state.child.lock().map(|guard| guard.is_some()).unwrap_or(false)
}

/// 查找随安装包内置的资源文件（兼容 resources/ 子目录与根目录两种布局）
fn bundled_resource(app: &AppHandle, name: &str) -> Option<PathBuf> {
    let base = app.path().resource_dir().ok()?;
    [base.join("resources").join(name), base.join(name)]
        .into_iter()
        .find(|p| p.is_file())
}

/// 把内置的 Psiphon 配套文件复制到用户数据目录，供后续启用 Psiphon 出口时直接使用。
pub fn ensure_bundled_extras(app: &AppHandle) {
    let Ok(dir) = app_dir(app) else { return };
    for name in ["psiphon.exe", "client.config", "server_list.dat", "GPL-3.0.txt"] {
        let dest = dir.join(name);
        if dest.exists() {
            continue;
        }
        if let Some(src) = bundled_resource(app, name) {
            let _ = std::fs::copy(src, dest);
        }
    }
}

/// 取得 mihomo 核心：优先用安装包内置文件，缺失时才走网络下载。
fn download_core(app: &AppHandle) -> Result<PathBuf, String> {
    let dest = core_path(app)?;
    if dest.exists() {
        return Ok(dest);
    }
    let dir = app_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create dir: {}", e))?;

    if let Some(src) = bundled_resource(app, "mihomo.exe") {
        std::fs::copy(src, &dest).map_err(|e| format!("复制内置核心: {}", e))?;
        return Ok(dest);
    }

    let name = format!("mihomo-windows-amd64-compatible-{}.zip", MIHOMO_VERSION);
    let file_name = format!("mihomo-{}.zip", MIHOMO_VERSION);
    let zip_path = dir.join(&file_name);
    let url_origin = format!("{}{}/{}", GH_ORIGIN, MIHOMO_VERSION, name);
    let url_proxy = format!("{}{}", GH_PROXY, url_origin);

    let curl = || -> Result<bool, String> {
        let status = hidden_command("curl.exe")
            .args([
                "-sL", "--fail", "--max-time", "180", "--retry", "2",
                "-o", zip_path.to_string_lossy().as_ref(),
                url_proxy.as_str(),
            ])
            .status()
            .map_err(|e| format!("curl: {}", e))?;
        Ok(status.success())
    };

    if !curl()? {
        // 镜像失败回退源站
        let status = hidden_command("curl.exe")
            .args([
                "-sL", "--fail", "--max-time", "180", "--retry", "2",
                "-o", zip_path.to_string_lossy().as_ref(),
                url_origin.as_str(),
            ])
            .status()
            .map_err(|e| format!("curl origin: {}", e))?;
        if !status.success() {
            return Err("核心下载失败：镜像与源站均不可达，请检查网络后重试".into());
        }
    }

    // 解压出 exe（仅用 PowerShell 内置 Expand-Archive，无第三方依赖）
    let extract_dir = dir.join("core-extract");
    let _ = std::fs::remove_dir_all(&extract_dir);
    let ps = format!(
        "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
        zip_path.to_string_lossy(),
        extract_dir.to_string_lossy(),
    );
    let status = hidden_command("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
        .status()
        .map_err(|e| format!("unzip: {}", e))?;
    if !status.success() {
        return Err("核心解压失败".into());
    }

    // 找到 exe 并搬到目标位置
    let mut found: Option<PathBuf> = None;
    if let Ok(entries) = std::fs::read_dir(&extract_dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().map(|x| x == "exe").unwrap_or(false) {
                found = Some(p);
                break;
            }
        }
    }
    let exe = found.ok_or("解压后未找到 mihomo.exe")?;
    std::fs::copy(&exe, &dest).map_err(|e| format!("copy core: {}", e))?;
    let _ = std::fs::remove_dir_all(&extract_dir);
    let _ = std::fs::remove_file(&zip_path);
    Ok(dest)
}

/// 生成一条 WireGuard 出站。dialer-proxy 非空时即为内层隧道。
fn wg_proxy(
    name: &str,
    private_key: &str,
    peer: &str,
    ip: &str,
    host: &str,
    port: u16,
    mtu: u16,
    dialer: Option<&str>,
) -> String {
    let mut s = format!(
        r#"  - name: "{name}"
    type: wireguard
    private-key: "{private_key}"
    ip: {ip}
    peers:
      - server: {host}
        port: {port}
        public-key: "{peer}"
        allowed-ips: ['0.0.0.0/0']
        persistent-keepalive: 25
    mtu: {mtu}
    udp: true
"#
    );
    if let Some(d) = dialer {
        s.push_str(&format!(
            "    dialer-proxy: \"{}\"\n    remote-dns-resolve: true\n    dns: ['8.8.8.8', '1.1.1.1', '1.0.0.1']\n",
            d
        ));
    }
    s
}

/// 生成一条 MASQUE 出站。network=h2 对应 MASQUE H2，否则为 H3/QUIC。
fn masque_proxy(name: &str, cred: &WarpCredential, mtu: u16, network_h2: bool, dialer: Option<&str>) -> String {
    let mut s = format!(
        r#"  - name: "{name}"
    type: masque
    server: {server}
    port: {mport}
    sni: {sni}
    private-key: "{private_key}"
    public-key: "{public_key}"
    ip: {v4}
    congestion-controller: bbr
    ip-stack:
      mode: gvisor
    handshake-timeout: 5
    mtu: {mtu}
    udp: true
    remote-dns-resolve: true
    dns: ['8.8.8.8', '1.1.1.1', '1.0.0.1']
"#,
        server = MASQUE_SERVER,
        sni = MASQUE_SNI,
        mport = MASQUE_PORT,
        private_key = cred.masque_private_key,
        public_key = cred.masque_public_key,
        v4 = cred.address_v4,
    );
    if network_h2 {
        s.push_str("    network: h2\n");
    }
    if let Some(d) = dialer {
        s.push_str(&format!("    dialer-proxy: \"{}\"\n", d));
    }
    s
}

/// 渲染 mihomo 配置：支持 WG / AWG / GOOL / MASQUE H3 / H2 / in-MASQUE。
/// 不依赖 GEOSITE/GEOIP 数据文件，避免首次下载失败。
fn render_config(
    cred: &WarpCredential,
    protocol: &str,
    port: u16,
    api_port: u16,
    mtu: u16,
    allow_lan: bool,
    front_config: Option<&str>,
) -> String {
    let effective_mtu = if mtu > 0 { mtu } else { 1280 };
    let allow_lan_str = if allow_lan { "true" } else { "false" };
    // 订阅模式的节点固定命名为 SUB-NODE，作为最外层 dialer-proxy
    let front_name = front_config.map(|_| "SUB-NODE");
    let (mut proxies, outbound) = match protocol {
        // GOOL = XEHN 的 wwarp：两层 WARP 隧道，内层通过 dialer-proxy 走外层
        "gool" => (
            format!(
                "{}{}",
                wg_proxy(
                    "WARP OUTER", &cred.private_key, &cred.peer_public_key, &cred.address_v4,
                    &cred.endpoint_host, cred.endpoint_port, effective_mtu, front_name,
                ),
                wg_proxy(
                    "WARP INNER", &cred.inner_private_key, &cred.peer_public_key, &cred.address_v4,
                    &cred.inner_endpoint_host, cred.inner_endpoint_port, 1220, Some("WARP OUTER"),
                ),
            ),
            "WARP INNER",
        ),
        // MASQUE in MASQUE：外层 H3 承载内层 H3
        "masque-mm" => (
            format!(
                "{}{}",
                masque_proxy("MASQUE OUTER", cred, effective_mtu, false, front_name),
                masque_proxy("MASQUE INNER", cred, effective_mtu, false, Some("MASQUE OUTER")),
            ),
            "MASQUE INNER",
        ),
        "masque" => (masque_proxy("WARP", cred, effective_mtu, false, front_name), "WARP"),
        "masque-h2" => (masque_proxy("WARP", cred, effective_mtu, true, front_name), "WARP"),
        _ => (
            wg_proxy(
                "WARP", &cred.private_key, &cred.peer_public_key, &cred.address_v4,
                &cred.endpoint_host, cred.endpoint_port, effective_mtu, front_name,
            ),
            "WARP",
        ),
    };

    if let Some(front) = front_config {
        proxies = format!("{}\n{}", front.trim_end(), proxies);
    }

    format!(
        r#"# AnTun 自动生成的配置（请勿手动修改）· protocol={protocol}
mixed-port: {port}
bind-address: 127.0.0.1
allow-lan: {allow_lan_str}
mode: rule
log-level: info
ipv6: false
external-controller: 127.0.0.1:{api_port}
tcp-concurrent: true

dns:
  enable: true
  ipv6: false
  respect-rules: true
  proxy-server-nameserver:
    - 8.8.8.8
    - 1.1.1.1
    - 1.0.0.1
  nameserver:
    - 8.8.8.8
    - 1.1.1.1
    - 1.0.0.1

proxies:
{proxies}
proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - {outbound}

rules:
  - IP-CIDR,10.0.0.0/8,DIRECT,no-resolve
  - IP-CIDR,172.16.0.0/12,DIRECT,no-resolve
  - IP-CIDR,192.168.0.0/16,DIRECT,no-resolve
  - IP-CIDR,100.64.0.0/10,DIRECT,no-resolve
  - IP-CIDR,127.0.0.0/8,DIRECT,no-resolve
  - DOMAIN-SUFFIX,local,DIRECT
  - MATCH,PROXY
"#,
        protocol = protocol,
        port = port,
        api_port = api_port,
        proxies = proxies,
        outbound = outbound,
        allow_lan_str = allow_lan_str,
    )
}

/// 停止核心进程
#[tauri::command]
pub fn core_stop(app: AppHandle, state: tauri::State<'_, CoreState>) -> Result<(), String> {
    stop_child(&state);
    let _ = restore_system_proxy(&app);
    Ok(())
}

/// 检查核心是否已下载
#[tauri::command]
pub fn core_status(app: AppHandle, state: tauri::State<'_, CoreState>) -> Result<bool, String> {
    let exists = core_path(&app)?.exists();
    let running = state
        .child
        .lock()
        .map(|g| g.as_ref().map(|c| c.id() > 0).unwrap_or(false))
        .unwrap_or(false);
    Ok(exists || running)
}

/// mihomo 实时流量快照（累计字节数）
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CoreTraffic {
    /// 当前上传速率，bytes/s
    pub up: u64,
    /// 当前下载速率，bytes/s
    pub down: u64,
    /// 累计上传字节数
    pub up_total: u64,
    /// 累计下载字节数
    pub down_total: u64,
}

/// 读取核心 REST API 的流量快照。/traffic 是流式接口，只取第一行即可。
#[tauri::command]
pub fn core_traffic(api_port: u16) -> Result<CoreTraffic, String> {
    let url = format!("http://127.0.0.1:{}/traffic", api_port);
    let out = hidden_command("curl.exe")
        .args(["-s", "--max-time", "2", &url])
        .output()
        .map_err(|e| format!("读取流量失败: {}", e))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        return Err("核心流量接口不可用".into());
    }
    let value: serde_json::Value =
        serde_json::from_str(line).map_err(|e| format!("流量数据解析失败: {}", e))?;
    Ok(CoreTraffic {
        up: value.get("up").and_then(|v| v.as_u64()).unwrap_or(0),
        down: value.get("down").and_then(|v| v.as_u64()).unwrap_or(0),
        up_total: value.get("upTotal").and_then(|v| v.as_u64()).unwrap_or(0),
        down_total: value.get("downTotal").and_then(|v| v.as_u64()).unwrap_or(0),
    })
}

/// 保存 WARP 凭证
#[tauri::command]
pub fn save_credential(app: AppHandle, cred: WarpCredential) -> Result<(), String> {
    let path = cred_path(&app)?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(path, serde_json::to_string_pretty(&cred).map_err(|e| e.to_string())?)
        .map_err(|e| format!("保存凭证: {}", e))
}

/// 内置默认凭证：来自公开 WARP 注册端点生成的免费账户，经本机实测可建立隧道。
/// 作用：新用户安装后无需任何配置即可连接；用户导入自己的凭证后会覆盖它。
const BUILTIN_OUTER_KEY: &str = "AO9FFXpvI2abd29iiuIskLoRg3nkT3j1VGs1M/1cj3s=";
const BUILTIN_WARP_PEER: &str = "bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=";
const BUILTIN_INNER_KEY: &str = "4FC385+GIJMWmOwT9e8NcD6WozjEyZePpV2uxhVE3k0=";
const BUILTIN_INNER_HOST: &str = "8.34.70.19";
const BUILTIN_MASQUE_KEY: &str = "MHcCAQEEIOiNkR2CFenP3pkGT6gKbMXdWSEA95DclNVCKs3wP089oAoGCCqGSM49AwEHoUQDQgAEqSoE25D8CGO4Wyb5NdDx0/t+2mPRZN0QALyEsMI4a17HXxzu4Lt4+bB0PsCNeQGAWAvGYpQ/G6Elqn7XCGiZow==";
const BUILTIN_MASQUE_PEER: &str = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEIaU7MToJm9NKp8YfGxR6r+/h4mcG7SxI8tsW8OR1A5tv/zCzVbCRRh2t87/kxnP6lAy0lkr7qYwu+ox+k3dr6w==";

/// 用内置凭证补齐缺失字段，保证嵌套协议开箱可用。
fn fill_defaults(mut cred: WarpCredential) -> WarpCredential {
    if cred.private_key.is_empty() { cred.private_key = BUILTIN_OUTER_KEY.into(); }
    if cred.peer_public_key.is_empty() { cred.peer_public_key = BUILTIN_WARP_PEER.into(); }
    if cred.address_v4.is_empty() { cred.address_v4 = "172.16.0.2".into(); }
    if cred.endpoint_host.is_empty() { cred.endpoint_host = "8.35.211.178".into(); }
    if cred.endpoint_port == 0 { cred.endpoint_port = 2408; }
    if cred.inner_private_key.is_empty() { cred.inner_private_key = BUILTIN_INNER_KEY.into(); }
    if cred.inner_endpoint_host.is_empty() { cred.inner_endpoint_host = BUILTIN_INNER_HOST.into(); }
    if cred.inner_endpoint_port == 0 { cred.inner_endpoint_port = 2408; }
    if cred.masque_private_key.is_empty() { cred.masque_private_key = BUILTIN_MASQUE_KEY.into(); }
    if cred.masque_public_key.is_empty() { cred.masque_public_key = BUILTIN_MASQUE_PEER.into(); }
    cred
}

fn builtin_credential() -> WarpCredential {
    fill_defaults(WarpCredential::default())
}

/// 读取凭证：优先用户导入的，否则返回内置默认
#[tauri::command]
pub fn load_credential(app: AppHandle) -> Result<WarpCredential, String> {
    let path = cred_path(&app)?;
    if path.exists() {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(cred) = serde_json::from_str::<WarpCredential>(&text) {
                return Ok(fill_defaults(cred));
            }
        }
    }
    Ok(builtin_credential())
}

/// 真正建立连接：下载核心 → 写配置 → 启动 → 通过代理探测出口
#[tauri::command]
pub async fn core_connect(
    app: AppHandle,
    state: tauri::State<'_, CoreState>,
    cred: WarpCredential,
    protocol: String,
    port: u16,
    api_port: u16,
    mtu: u16,
    timeout_sec: u32,
    allow_lan: bool,
    front_config: Option<String>,
) -> Result<CoreResult, String> {
    let cred = fill_defaults(cred);
    // 1. 先把之前的核心停掉并还原系统代理，避免端口冲突与旧代理残留
    stop_child(&state);
    let _ = restore_system_proxy(&app);

    // 2. 确保核心存在
    let exe = match download_core(&app) {
        Ok(p) => p,
        Err(e) => return Ok(CoreResult::fail(e)),
    };
    ensure_bundled_extras(&app);

    // 3. 写配置
    let cfg = render_config(&cred, &protocol, port, api_port, mtu, allow_lan, front_config.as_deref());
    let cfg_path = match config_path(&app) {
        Ok(p) => p,
        Err(e) => return Ok(CoreResult::fail(e)),
    };
    if let Err(e) = std::fs::write(&cfg_path, &cfg) {
        return Ok(CoreResult::fail(format!("写配置: {}", e)));
    }

    // 4. 启动前先校验配置，配置非法直接返回具体错误（避免"正在连接"卡死）
    if let Ok(check) = hidden_command(&exe)
        .args(["-t", "-f", cfg_path.to_string_lossy().as_ref()])
        .output()
    {
        let err_text = String::from_utf8_lossy(&check.stderr);
        if err_text.contains("failed") || err_text.contains("error") {
            return Ok(CoreResult::fail(format!("核心配置校验失败：{}", err_text.trim())));
        }
    }

    // 5. 启动核心
    let child = match hidden_command(&exe)
        .args(["-f", cfg_path.to_string_lossy().as_ref()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return Ok(CoreResult::fail(format!("启动核心: {}", e))),
    };
    if let Ok(mut guard) = state.child.lock() {
        *guard = Some(child);
    }

    // 5. 等待核心就绪 + 真实出口探测（轮询，直到成功或超时）
    let started = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // MASQUE H3 / in-MASQUE 使用 gvisor + bbr，首次握手与双重出口探测
    // 可能接近 10 秒，5 秒兜底会把可用隧道误判为失败，因此下限设为 30 秒。
    let max_wait = timeout_sec.max(30) as u64;
    let proxy_url = format!("http://127.0.0.1:{}", port);
    let mut last_err = String::new();

    loop {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        if now.saturating_sub(started) >= max_wait {
            break;
        }
        std::thread::sleep(Duration::from_millis(600));

        match probe_exit(&proxy_url) {
            Ok(info) => {
                // 隧道已验证可用：把系统代理指向本地核心，浏览器才会真正走 WARP
                if let Err(e) = set_system_proxy(&app, port) {
                    stop_child(&state);
                    let _ = restore_system_proxy(&app);
                    return Ok(CoreResult::fail(format!("设置系统代理失败：{}", e)));
                }
                return Ok(info);
            }
            Err(e) => last_err = e,
        }
    }

    // 超时：停掉核心，如实返回失败
    stop_child(&state);
    Ok(CoreResult::fail(format!(
        "连接超时：{}（请确认 WARP 凭证有效，且当前网络可访问 Cloudflare）",
        last_err
    )))
}

/// 通过本地代理真实探测出口（这是判断"已连接"的唯一依据）
///
/// 用 Cloudflare trace 同时拿到出口 IP 与国家（经隧道请求，能通即证明隧道可用），
/// 再用 gstatic generate_204 做连通性二次确认——两者都通过才算真正连上。
fn probe_exit(proxy_url: &str) -> Result<CoreResult, String> {
    let t0 = SystemTime::now();

    // 1. Cloudflare trace：经隧道请求，返回 ip= / loc= 字段
    let trace = hidden_command("curl.exe")
        .args([
            "-s", "--max-time", "8", "-x", proxy_url,
            "-w", "\n__ANTUN_MS__%{time_total}",
            "https://www.cloudflare.com/cdn-cgi/trace",
        ])
        .output()
        .map_err(|e| format!("trace 请求: {}", e))?;
    let trace_text = String::from_utf8_lossy(&trace.stdout);
    if !trace.status.success() || !trace_text.contains("warp=") {
        return Err("Cloudflare trace 不可达（隧道未建立）".into());
    }

    let mut ip = String::new();
    let mut loc = String::new();
    let mut warp = String::new();
    let mut elapsed_ms = 0u32;
    for line in trace_text.lines() {
        if let Some(v) = line.strip_prefix("ip=") { ip = v.to_string(); }
        if let Some(v) = line.strip_prefix("loc=") { loc = v.to_string(); }
        if let Some(v) = line.strip_prefix("warp=") { warp = v.to_string(); }
        if let Some(v) = line.strip_prefix("__ANTUN_MS__") {
            elapsed_ms = (v.trim().parse::<f64>().unwrap_or(0.0) * 1000.0) as u32;
        }
    }
    if ip.is_empty() {
        return Err("未获取到出口 IP".into());
    }

    // 2. 二次确认：gstatic 204（YouTube 系服务，能通即证明可访问外网）
    let check = hidden_command("curl.exe")
        .args([
            "-s", "-o", "NUL", "-w", "%{http_code}", "--max-time", "8",
            "-x", proxy_url, "http://www.gstatic.com/generate_204",
        ])
        .output()
        .map_err(|e| format!("连通性检查: {}", e))?;
    let code = String::from_utf8_lossy(&check.stdout);
    if !code.trim().starts_with('2') {
        return Err(format!("外网连通性检查失败（HTTP {}）", code.trim()));
    }

    let latency = if elapsed_ms > 0 {
        elapsed_ms
    } else {
        SystemTime::now().duration_since(t0).unwrap_or_default().as_millis() as u32
    };

    Ok(CoreResult {
        ok: true,
        exit_ip: ip,
        country: loc,
        city: String::new(),
        colo: if warp == "on" || warp == "plus" { format!("WARP {}", warp) } else { "WARP".into() },
        latency,
        error: String::new(),
    })
}

/// 独立探测命令（供前端定时调用，验证隧道是否仍可用）
#[tauri::command]
pub async fn probe_status(
    app: AppHandle,
    state: tauri::State<'_, CoreState>,
    port: u16,
) -> Result<CoreResult, String> {
    // 核心意外退出时立即还原系统代理，否则浏览器会一直指向死端口
    let mut child_gone = false;
    if let Ok(mut guard) = state.child.lock() {
        if let Some(child) = guard.as_mut() {
            if matches!(child.try_wait(), Ok(Some(_))) {
                child_gone = true;
            }
        }
        if child_gone {
            *guard = None;
        }
    }
    if child_gone {
        let _ = restore_system_proxy(&app);
        return Ok(CoreResult::fail("核心进程已退出，系统代理已还原"));
    }

    let proxy_url = format!("http://127.0.0.1:{}", port);
    match probe_exit(&proxy_url) {
        Ok(r) => Ok(r),
        Err(e) => Ok(CoreResult::fail(e)),
    }
}
