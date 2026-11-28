//! WARP 端点探测（两条路径，快的在前）
//!
//! 1. **纯握手**（默认）：`wg_handshake` 用 boringtun 发一次 Noise IK 握手，
//!    活端点 ≈ 一个 RTT，死端点最多等 2s。不起核心、不发业务数据、不占端口。
//! 2. **组延迟回退**：本机网络把 WARP 的 UDP 全掐了、或纯握手一个都没通时，
//!    起一个 mihomo 实例，把所有端点写成 WireGuard 出站 + 一个 `PROBE` 组，
//!    调一次 `/group/PROBE/delay` 让核心内部并发测，按结果如实标记不可用。
//!
//! 两条路径都不碰主隧道、不改系统代理。

use crate::core::{app_dir, download_core, proxy_free_command, WarpCredential};
use crate::wg_handshake;
use serde::Serialize;
use std::collections::HashMap;
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

/// 回退路径的探测目标：204 端点，成功判定只看状态码，不下载任何内容
const PROBE_URL: &str = "https://www.gstatic.com/generate_204";
/// 回退路径每个端点的超时（核心内 unified-delay 口径）
const GROUP_TIMEOUT_MS: u32 = 3_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointProbe {
    pub host: String,
    pub port: u16,
    /// 毫秒；-1 表示不可用
    pub rtt: i64,
    pub ok: bool,
    pub error: String,
}

fn free_port() -> Option<u16> {
    TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
}

fn port_ready(port: u16) -> bool {
    let addr = match format!("127.0.0.1:{}", port).parse() {
        Ok(a) => a,
        Err(_) => return false,
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

/// 回退路径的配置：每个端点一条 WireGuard 出站 + 一个 select 组。
/// 组延迟由核心自己调度，不再为每个端点开本地入口、也不再用 N 个 curl。
fn render_config(cred: &WarpCredential, hosts: &[(String, u16)], api_port: u16, mtu: u16) -> String {
    let mut proxies = String::new();
    let mut group = String::new();
    for (idx, (host, port)) in hosts.iter().enumerate() {
        proxies.push_str(&format!(
            r#"  - name: "P{idx}"
    type: wireguard
    private-key: "{key}"
    ip: {ip}
    peers:
      - server: {host}
        port: {port}
        public-key: "{peer}"
        allowed-ips: ['0.0.0.0/0']
        persistent-keepalive: 25
    mtu: {mtu}
    udp: true
"#,
            idx = idx,
            key = cred.private_key,
            ip = cred.address_v4,
            host = host,
            port = port,
            peer = cred.peer_public_key,
            mtu = mtu,
        ));
        group.push_str(&format!("      - \"P{}\"\n", idx));
    }
    format!(
        "# AnTun 端点探测专用配置（临时文件）\nmode: rule\nlog-level: warning\nipv6: false\nunified-delay: true\nexternal-controller: 127.0.0.1:{api}\n\ndns:\n  enable: true\n  ipv6: false\n  nameserver:\n    - 1.1.1.1\n    - 8.8.8.8\n  proxy-server-nameserver:\n    - 1.1.1.1\n    - 8.8.8.8\n\nproxies:\n{proxies}\nproxy-groups:\n  - name: PROBE\n    type: select\n    proxies:\n{group}\nrules:\n  - MATCH,DIRECT\n",
        api = api_port,
        proxies = proxies,
        group = group,
    )
}

/// 最小 URL 编码：只保留 RFC 3986 的 unreserved 字符，其余按 %XX 转义。
pub(crate) fn url_encode(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len() * 3);
    for b in raw.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// 一次组延迟调用：核心内部并发测完整组，返回 {代理名: 毫秒}。
fn group_delay(api_port: u16, timeout_ms: u32) -> Result<HashMap<String, i64>, String> {
    let url = format!(
        "http://127.0.0.1:{}/group/PROBE/delay?url={}&timeout={}",
        api_port,
        url_encode(PROBE_URL),
        timeout_ms
    );
    // 整组可能在最后一个代理的超时之后才返回，给足余量
    let max_time = (timeout_ms / 1000 + 15).to_string();
    let out = proxy_free_command("curl.exe")
        .args(["-sS", "--max-time", &max_time, &url])
        .output()
        .map_err(|e| format!("curl 启动失败: {}", e))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let body = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str::<HashMap<String, i64>>(body.trim())
        .map_err(|e| format!("组延迟响应无法解析: {} ({})", e, body.chars().take(80).collect::<String>()))
}

/// 起一次临时核心，跑一次组延迟，然后关掉。
fn group_probe_with_exe(
    exe: &std::path::Path,
    cred: &WarpCredential,
    hosts: &[String],
    port: u16,
    mtu: u16,
    dir: &std::path::Path,
) -> Result<Vec<EndpointProbe>, String> {
    if hosts.is_empty() {
        return Ok(Vec::new());
    }
    let dir = dir.to_path_buf();
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建探测目录失败: {}", e))?;

    let api_port = free_port().ok_or_else(|| "没有可用的本地端口".to_string())?;
    let items: Vec<(String, u16)> = hosts.iter().map(|h| (h.clone(), port)).collect();
    let cfg = render_config(cred, &items, api_port, mtu);
    let cfg_path = dir.join("config.yaml");
    std::fs::write(&cfg_path, &cfg).map_err(|e| format!("写探测配置失败: {}", e))?;

    let mut child: Child = proxy_free_command(exe)
        .args([
            "-f",
            cfg_path.to_string_lossy().as_ref(),
            "-d",
            dir.to_string_lossy().as_ref(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("启动探测核心失败: {}", e))?;

    // 探测核心也放进 Job：主程序异常退出时不会留下孤儿进程
    let job = crate::core::bind_child_to_job(&child);

    // 等 REST 控制器就绪（最多 10 秒）
    let deadline = Instant::now() + Duration::from_secs(10);
    while !port_ready(api_port) {
        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(120));
    }
    let ready = port_ready(api_port);

    let mapped = if ready {
        group_delay(api_port, GROUP_TIMEOUT_MS).map(|map| {
            hosts
                .iter()
                .enumerate()
                .map(|(idx, host)| {
                    let ms = map.get(&format!("P{}", idx)).copied().unwrap_or(-1);
                    EndpointProbe {
                        host: host.clone(),
                        port,
                        rtt: if ms > 0 { ms } else { -1 },
                        ok: ms > 0,
                        error: if ms > 0 { String::new() } else { "组延迟未返回结果（握手超时或不可达）".into() },
                    }
                })
                .collect::<Vec<EndpointProbe>>()
        })
    } else {
        Err("探测核心启动失败".to_string())
    };

    let _ = child.kill();
    let _ = child.wait();
    if let Some(h) = job {
        crate::core::close_job_handle(h);
    }
    std::thread::sleep(Duration::from_millis(120));
    let _ = std::fs::remove_dir_all(&dir);
    mapped
}

/// 探测候选端点。`hosts` 为 IP 列表，`port` 为 WARP 端口（通常 2408）。
#[tauri::command]
pub async fn endpoint_probe(
    app: tauri::AppHandle,
    cred: WarpCredential,
    hosts: Vec<String>,
    port: u16,
    mtu: u16,
) -> Result<Vec<EndpointProbe>, String> {
    let hosts: Vec<String> = hosts
        .into_iter()
        .map(|h| h.trim().to_string())
        .filter(|h| !h.is_empty())
        .take(24)
        .collect();
    if hosts.is_empty() {
        return Ok(Vec::new());
    }
    if cred.private_key.is_empty() || cred.peer_public_key.is_empty() || cred.address_v4.is_empty() {
        return Err("凭证不完整，无法探测端点".into());
    }
    let mtu = if mtu > 0 { mtu } else { 1280 };
    let exe = download_core(&app)?;
    let dir = app_dir(&app)?.join("endpoint-probe");
    // 探测要等握手超时/回退核心，放到阻塞线程池，别占住 async 运行时
    tauri::async_runtime::spawn_blocking(move || probe_endpoints(&exe, &cred, &hosts, port, mtu, &dir))
        .await
        .map_err(|e| format!("端点探测任务失败: {}", e))?
}

/// 探测主体：纯握手优先，一个都没通时回退到组延迟。
pub(crate) fn probe_endpoints(
    exe: &std::path::Path,
    cred: &WarpCredential,
    hosts: &[String],
    port: u16,
    mtu: u16,
    dir: &std::path::Path,
) -> Result<Vec<EndpointProbe>, String> {
    let t0 = Instant::now();
    let fast = wg_handshake::probe_hosts(
        cred,
        hosts,
        port,
        Duration::from_millis(wg_handshake::DEFAULT_TIMEOUT_MS),
        wg_handshake::CONCURRENCY,
    );
    let fast_ms = t0.elapsed().as_millis();
    if fast.iter().any(|p| p.ok) {
        return Ok(fast
            .into_iter()
            .map(|p| EndpointProbe {
                host: p.host,
                port: p.port,
                rtt: p.rtt,
                ok: p.ok,
                error: p.error,
            })
            .collect());
    }

    // 纯握手全失败：可能是端点都没了，也可能是本机网络掐了 WARP 的 UDP。
    // 回退到完整隧道探测再确认一次，避免把"本地被墙"误报成"端点不可用"。
    match group_probe_with_exe(exe, cred, hosts, port, mtu, dir) {
        Ok(list) if list.iter().any(|p| p.ok) => Ok(list),
        Ok(list) => Ok(list
            .into_iter()
            .map(|p| EndpointProbe {
                error: if p.error.is_empty() {
                    format!("纯握手与组延迟均未通过（纯握手耗时 {}ms）", fast_ms)
                } else {
                    format!("{}（纯握手耗时 {}ms）", p.error, fast_ms)
                },
                ..p
            })
            .collect()),
        Err(e) => {
            // 连回退核心都起不来：如实返回纯握手的结果，不伪造可用
            let _ = e;
            Ok(fast
                .into_iter()
                .map(|p| EndpointProbe {
                    host: p.host,
                    port: p.port,
                    rtt: p.rtt,
                    ok: p.ok,
                    error: if p.error.is_empty() { "不可用".into() } else { p.error },
                })
                .collect())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cred() -> WarpCredential {
        WarpCredential {
            private_key: "priv".into(),
            peer_public_key: "peer".into(),
            address_v4: "172.16.0.2/32".into(),
            ..Default::default()
        }
    }

    #[test]
    fn render_config_has_probe_group_and_no_listeners() {
        let items = vec![
            ("162.159.192.1".to_string(), 2408u16),
            ("162.159.193.7".to_string(), 2408u16),
        ];
        let cfg = render_config(&cred(), &items, 39999, 1280);
        assert!(cfg.contains("server: 162.159.192.1"));
        assert!(cfg.contains("server: 162.159.193.7"));
        assert_eq!(cfg.matches("type: wireguard").count(), 2);
        assert!(cfg.contains("proxy-groups:\n  - name: PROBE\n    type: select"));
        assert!(cfg.contains("      - \"P1\""));
        assert!(cfg.contains("external-controller: 127.0.0.1:39999"));
        assert!(!cfg.contains("listeners:"), "回退路径不再为每个端点开入口");
        assert!(cfg.contains("unified-delay: true"));
        assert!(cfg.contains("nameserver:"));
    }

    #[test]
    fn group_delay_fails_without_core() {
        // 没有核心监听：必须报错，而不是返回假的可用结果
        let port = free_port().unwrap_or(40009);
        assert!(group_delay(port, 500).is_err());
    }

    #[test]
    fn probe_endpoints_reports_all_failed_without_network() {
        // 127.0.0.1:1 不会响应 WireGuard 握手；回退核心也不可用（exe 不存在）。
        // 结果必须是 ok=false，绝不伪造延迟。
        let out = probe_endpoints(
            std::path::Path::new("definitely-missing-core.exe"),
            &cred(),
            &["127.0.0.1".to_string()],
            1,
            1280,
            &std::env::temp_dir().join("antun-ep-probe-test"),
        )
        .expect("不应返回 Err");
        assert_eq!(out.len(), 1);
        assert!(!out[0].ok);
        assert!(out[0].rtt <= 0);
    }

    /// 真实探测（需要本机已安装核心与凭证）：
    /// `cargo test --lib probes_real_endpoints -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn probes_real_endpoints() {
        let base = std::env::var("APPDATA").expect("APPDATA 未设置");
        let dir = std::path::PathBuf::from(base).join("com.antun.client");
        let exe = dir.join("mihomo.exe");
        assert!(exe.exists(), "未找到核心: {:?}", exe);
        let raw = std::fs::read_to_string(dir.join("warp-credential.json")).expect("凭证文件缺失");
        let cred: WarpCredential = serde_json::from_str(&raw).expect("凭证解析失败");
        let hosts: Vec<String> = [
            "162.159.192.1",
            "162.159.193.1",
            "162.159.195.1",
            "188.114.96.1",
            "188.114.97.1",
            "188.114.99.1",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let work = std::env::temp_dir().join("antun-ep-probe");
        let t0 = Instant::now();
        let out = probe_endpoints(&exe, &cred, &hosts, 2408, 1280, &work).expect("探测失败");
        println!("总耗时 {:?}", t0.elapsed());
        for p in &out {
            println!("{}:{} rtt={} ok={} {}", p.host, p.port, p.rtt, p.ok, p.error);
        }
        assert_eq!(out.len(), 6);
    }
}
