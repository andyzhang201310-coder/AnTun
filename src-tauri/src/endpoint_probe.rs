//! WARP 端点真实探测
//!
//! 目的：让首页「自动择优」有真实依据，而不是随机数。
//!
//! 原理：另起一个独立的 mihomo 实例，为每个候选端点建一条 WireGuard 出站
//! （用本机凭证，真实握手），每个端点配一个本地 HTTP 入口（`listeners[].proxy`
//! 强制走该出站），再用 curl 并发访问 204 探测页拿到端到端 RTT。
//!
//! 与主隧道完全隔离：不连接也能测，也不会改动系统代理。
//! 握手失败的端点（UDP 被封、端点下线）会如实返回 ok=false，前端据此把它排到最后。

use crate::core::{app_dir, download_core, hidden_command, WarpCredential};
use serde::Serialize;
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

/// 探测用的目标：204 端点，成功判定只看状态码，不下载任何内容
const PROBE_URL: &str = "https://www.gstatic.com/generate_204";
/// 单个端点最多正式测量两次（取较小值）
const PROBE_TRIES: usize = 2;
/// 并发数：与节点测速一致，避免同时拉起过多 curl
const CONCURRENCY: usize = 8;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointProbe {
    pub host: String,
    pub port: u16,
    /// 端到端毫秒；-1 表示不可用
    pub rtt: i64,
    pub ok: bool,
    pub error: String,
}

fn null_dev() -> &'static str {
    if cfg!(windows) {
        "NUL"
    } else {
        "/dev/null"
    }
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

/// 生成探测专用配置：每个端点一条 WireGuard 出站 + 一个专属 HTTP 入口。
/// 不写 proxy-groups / 规则分流，出口由 listener 的 `proxy` 字段直接钉死。
fn render_config(cred: &WarpCredential, items: &[(String, u16, u16)], mtu: u16) -> String {
    let mut proxies = String::new();
    let mut listeners = String::new();
    for (idx, (host, port, listen)) in items.iter().enumerate() {
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
        listeners.push_str(&format!(
            "  - name: pl{}\n    type: http\n    port: {}\n    listen: 127.0.0.1\n    proxy: \"P{}\"\n",
            idx, listen, idx
        ));
    }
    format!(
        "# AnTun 端点探测专用配置（临时文件）\nmode: rule\nlog-level: warning\nipv6: false\nunified-delay: true\n\ndns:\n  enable: true\n  ipv6: false\n  nameserver:\n    - 1.1.1.1\n    - 8.8.8.8\n  proxy-server-nameserver:\n    - 1.1.1.1\n    - 8.8.8.8\n\nproxies:\n{}\nlisteners:\n{}\nrules:\n  - MATCH,DIRECT\n",
        proxies, listeners
    )
}

/// 经指定本地入口访问探测页，返回 (毫秒, 错误)。
fn curl_rtt(port: u16) -> (i64, String) {
    let out = hidden_command("curl.exe")
        .args([
            "-sS",
            "-o",
            null_dev(),
            "--connect-timeout",
            "4",
            "--max-time",
            "6",
            "-x",
            &format!("http://127.0.0.1:{}", port),
            "-w",
            "%{http_code} %{time_total}",
            PROBE_URL,
        ])
        .output();
    let Ok(out) = out else {
        return (-1, "curl 启动失败".into());
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut it = text.split_whitespace();
    let code = it.next().unwrap_or("").to_string();
    let secs: f64 = it.next().and_then(|v| v.parse().ok()).unwrap_or(0.0);
    if code == "204" || code == "200" {
        let ms = ((secs * 1000.0).round() as i64).max(1);
        (ms, String::new())
    } else if code.is_empty() || code == "000" {
        (-1, "握手超时或不可达".into())
    } else {
        (-1, format!("HTTP {}", code))
    }
}

/// 单端点探测：先暖场一次（首次请求包含 WG 握手 + TLS 建连，耗时不代表链路质量），
/// 再正式测两次取较小值。暖场都失败说明端点不可达，直接返回，避免白等。
fn probe_one(port: u16) -> (i64, String) {
    let (warm, err) = curl_rtt(port);
    if warm <= 0 {
        return (warm, err);
    }
    let mut best = warm;
    let mut last_err = String::new();
    for _ in 0..PROBE_TRIES {
        let (ms, e) = curl_rtt(port);
        if ms > 0 {
            if ms < best {
                best = ms;
            }
        } else {
            last_err = e;
        }
    }
    let _ = last_err;
    (best, String::new())
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
    probe_with_exe(&exe, &cred, &hosts, port, mtu, &dir)
}

/// 探测主体：与 Tauri 无关，便于单独测试与复用。
pub(crate) fn probe_with_exe(
    exe: &std::path::Path,
    cred: &WarpCredential,
    hosts: &[String],
    port: u16,
    mtu: u16,
    dir: &std::path::Path,
) -> Result<Vec<EndpointProbe>, String> {
    let mtu = if mtu > 0 { mtu } else { 1280 };
    if hosts.is_empty() {
        return Ok(Vec::new());
    }
    let dir = dir.to_path_buf();
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建探测目录失败: {}", e))?;

    // 为每个端点分配一个本地入口端口
    let mut items: Vec<(String, u16, u16)> = Vec::with_capacity(hosts.len());
    for host in hosts {
        match free_port() {
            Some(listen) => items.push((host.clone(), port, listen)),
            None => {
                let _ = std::fs::remove_dir_all(&dir);
                return Err("没有可用的本地端口".into());
            }
        }
    }

    let cfg = render_config(cred, &items, mtu);
    let cfg_path = dir.join("config.yaml");
    std::fs::write(&cfg_path, &cfg).map_err(|e| format!("写探测配置失败: {}", e))?;

    let mut child: Child = hidden_command(exe)
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

    // 探测核心也放进 Job：主程序异常退出时不会留下孤儿进程占着随机端口
    let job = crate::core::bind_child_to_job(&child);
    // 等待本地入口就绪（最多 10 秒）
    let deadline = Instant::now() + Duration::from_secs(10);
    while !items.iter().all(|(_, _, p)| port_ready(*p)) {
        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(120));
    }
    // 入口未就绪说明核心没起来，直接放弃，避免对着一堆死端口空等
    if !items.iter().any(|(_, _, p)| port_ready(*p)) {
        let _ = child.kill();
        let _ = child.wait();
        if let Some(h) = job {
            crate::core::close_job_handle(h);
        }
        let _ = std::fs::remove_dir_all(&dir);
        return Err("探测核心启动失败".into());
    }

    // 并发探测
    let mut results: Vec<EndpointProbe> = Vec::with_capacity(items.len());
    for chunk in items.chunks(CONCURRENCY) {
        let part: Vec<EndpointProbe> = std::thread::scope(|scope| {
            let handles: Vec<_> = chunk
                .iter()
                .map(|(host, port, listen)| {
                    let host = host.clone();
                    let port = *port;
                    let listen = *listen;
                    scope.spawn(move || {
                        let (rtt, error) = probe_one(listen);
                        EndpointProbe { host, port, rtt, ok: rtt > 0, error }
                    })
                })
                .collect();
            handles
                .into_iter()
                .filter_map(|h| h.join().ok())
                .collect()
        });
        results.extend(part);
    }

    let _ = child.kill();
    let _ = child.wait();
    if let Some(h) = job {
        crate::core::close_job_handle(h);
    }
    std::thread::sleep(Duration::from_millis(120));
    let _ = std::fs::remove_dir_all(&dir);

    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_config_contains_each_endpoint() {
        let cred = WarpCredential {
            private_key: "priv".into(),
            peer_public_key: "peer".into(),
            address_v4: "172.16.0.2/32".into(),
            ..Default::default()
        };
        let items = vec![
            ("162.159.192.1".to_string(), 2408u16, 40001u16),
            ("162.159.193.7".to_string(), 2408u16, 40002u16),
        ];
        let cfg = render_config(&cred, &items, 1280);
        assert!(cfg.contains("server: 162.159.192.1"));
        assert!(cfg.contains("server: 162.159.193.7"));
        assert!(cfg.contains("port: 40001"));
        assert!(cfg.contains("proxy: \"P1\""));
        assert_eq!(cfg.matches("type: wireguard").count(), 2);
    }

    #[test]
    fn probe_one_reports_failure_without_listener() {
        // 未监听端口：curl 立刻失败，必须返回 -1 而不是伪造延迟
        let (ms, err) = probe_one(free_port().unwrap_or(40009));
        assert!(ms <= 0);
        assert!(!err.is_empty());
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
        let hosts = vec![
            "162.159.192.1".to_string(),
            "162.159.193.1".to_string(),
            "162.159.195.1".to_string(),
            "188.114.96.1".to_string(),
            "188.114.97.1".to_string(),
            "188.114.99.1".to_string(),
        ];
        let work = std::env::temp_dir().join("antun-ep-probe");
        let out = probe_with_exe(&exe, &cred, &hosts, 2408, 1280, &work).expect("探测失败");
        for p in &out {
            println!("{}:{} rtt={} ok={} {}", p.host, p.port, p.rtt, p.ok, p.error);
        }
        assert_eq!(out.len(), 6);
        assert!(out.iter().any(|p| p.ok), "所有端点均不可用，请检查网络与凭证");
    }
}
