//! 纯 WireGuard 握手探测（不建隧道、不发业务数据）
//!
//! 目的：把端点延迟测量降成「一次握手 = 1 个 RTT」。
//!
//! 之前的实现是「起 mihomo → 每个端点一个本地 HTTP 入口 → curl 访问 204」：
//! 一次测量要走 DNS + TCP + TLS + HTTP，还要为每个端点占端口、拉进程，
//! 失败端点得等满 connect-timeout。实测每个端点 0.9–1.2s，端点多时很难受。
//!
//! 这里直接用 boringtun 生成 Noise IK 握手发起包，UDP 发出去后等响应，
//! 用 `Tunn::time_since_last_handshake()` 判定完成时间：
//! 活端点 ≈ 一个 RTT，死端点最多等超时（默认 2s），没有 TLS/HTTP 的额外往返。
//! WARP 的握手就是标准 WireGuard（本机凭证已在真实隧道里验证可用），
//! 不需要 reserved / junk 参数。

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use boringtun::noise::{Tunn, TunnResult};
use serde::Serialize;
use std::net::{SocketAddr, UdpSocket};
use std::time::{Duration, Instant};
use x25519_dalek::{PublicKey, StaticSecret};

use crate::core::WarpCredential;

/// 一次握手的默认超时：与 XEHN 的 `-timeout 2` 对齐
pub const DEFAULT_TIMEOUT_MS: u64 = 2_000;
/// 同时握手的端点数（每个端点一个 UdpSocket + 一个 Tunn，开销很小）
pub const CONCURRENCY: usize = 16;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandshakeProbe {
    pub host: String,
    pub port: u16,
    /// 握手往返毫秒；-1 表示失败
    pub rtt: i64,
    pub ok: bool,
    pub error: String,
}

fn key32(b64: &str) -> Option<[u8; 32]> {
    let raw = B64.decode(b64.trim()).ok()?;
    if raw.len() != 32 {
        return None;
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&raw);
    Some(out)
}

/// 端点地址解析：`host` 一般是 IP 字面量（v4/v6），也允许域名。
fn resolve(host: &str, port: u16) -> Result<SocketAddr, String> {
    if let Ok(ip) = host.trim_matches(|c| c == '[' || c == ']').parse::<std::net::IpAddr>() {
        return Ok(SocketAddr::new(ip, port));
    }
    use std::net::ToSocketAddrs;
    let with_port = format!("{}:{}", host, port);
    with_port
        .to_socket_addrs()
        .ok()
        .and_then(|mut it| it.next())
        .ok_or_else(|| format!("无法解析端点 {}", with_port))
}

/// 对单个端点做一次真实握手。返回 (毫秒, 错误)。
pub fn handshake_once(cred: &WarpCredential, host: &str, port: u16, timeout: Duration) -> (i64, String) {
    let Some(private) = key32(&cred.private_key) else {
        return (-1, "凭证私钥不是 32 字节".into());
    };
    let Some(peer) = key32(&cred.peer_public_key) else {
        return (-1, "服务端公钥不是 32 字节".into());
    };
    let addr = match resolve(host, port) {
        Ok(a) => a,
        Err(e) => return (-1, e),
    };

    let sock = match UdpSocket::bind("0.0.0.0:0") {
        Ok(s) => s,
        Err(e) => return (-1, format!("UDP 套接字创建失败: {}", e)),
    };
    // connect 之后只收该端点的包，避免共享端口上的杂包干扰
    if let Err(e) = sock.connect(addr) {
        return (-1, format!("UDP connect 失败: {}", e));
    }

    let sk = StaticSecret::from(private);
    let pk = PublicKey::from(peer);
    // index 只在同一条 tunnel 内唯一；每次探测都是新的 Tunn，取随机值即可
    let index = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(1);
    let mut tunn = Tunn::new(sk, pk, None, None, index, None);

    let start = Instant::now();
    let deadline = start + timeout;
    let mut send_buf = [0u8; 2048];
    let init = match tunn.format_handshake_initiation(&mut send_buf, false) {
        TunnResult::WriteToNetwork(p) => p.to_vec(),
        TunnResult::Err(e) => return (-1, format!("握手包生成失败: {:?}", e)),
        _ => return (-1, "握手包生成失败".into()),
    };
    if let Err(e) = sock.send(&init) {
        return (-1, format!("发送握手失败: {}", e));
    }

    let mut recv_buf = [0u8; 2048];
    let mut scratch = [0u8; 2048];
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return (-1, "握手超时".into());
        }
        if let Err(e) = sock.set_read_timeout(Some(left)) {
            return (-1, format!("设置超时失败: {}", e));
        }
        let n = match sock.recv(&mut recv_buf) {
            Ok(n) => n,
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
                return (-1, "握手超时".into());
            }
            // Windows 上 ICMP 端口不可达会表现为 ConnectionReset
            Err(e) => return (-1, format!("接收失败: {}", e)),
        };
        match tunn.decapsulate(None, &recv_buf[..n], &mut scratch) {
            TunnResult::Err(e) => return (-1, format!("握手响应无效: {:?}", e)),
            // 对端可能先回 cookie（限速/负载保护），需要把核心生成的新握手包发回去
            TunnResult::WriteToNetwork(p) => {
                let _ = sock.send(p);
            }
            _ => {}
        }
        if tunn.time_since_last_handshake().is_some() {
            let ms = (start.elapsed().as_millis() as i64).max(1);
            return (ms, String::new());
        }
    }
}

/// 并发探测一组端点。结果顺序与输入一致。
pub fn probe_hosts(
    cred: &WarpCredential,
    hosts: &[String],
    port: u16,
    timeout: Duration,
    concurrency: usize,
) -> Vec<HandshakeProbe> {
    let conc = concurrency.max(1);
    let mut out: Vec<HandshakeProbe> = Vec::with_capacity(hosts.len());
    for chunk in hosts.chunks(conc) {
        let part: Vec<HandshakeProbe> = std::thread::scope(|scope| {
            let handles: Vec<_> = chunk
                .iter()
                .map(|host| {
                    let host = host.clone();
                    scope.spawn(move || {
                        let (rtt, error) = handshake_once(cred, &host, port, timeout);
                        HandshakeProbe { host, port, rtt, ok: rtt > 0, error }
                    })
                })
                .collect();
            handles.into_iter().filter_map(|h| h.join().ok()).collect()
        });
        out.extend(part);
    }
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn real_cred() -> Option<WarpCredential> {
        let base = std::env::var("APPDATA").ok()?;
        let path = std::path::PathBuf::from(base)
            .join("com.antun.client")
            .join("warp-credential.json");
        let raw = std::fs::read_to_string(path).ok()?;
        serde_json::from_str(&raw).ok()
    }

    #[test]
    fn rejects_bad_keys() {
        let cred = WarpCredential {
            private_key: "not-base64".into(),
            peer_public_key: "bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=".into(),
            ..Default::default()
        };
        let (rtt, err) = handshake_once(&cred, "162.159.192.1", 2408, Duration::from_millis(200));
        assert_eq!(rtt, -1);
        assert!(err.contains("私钥"));
    }

    /// 真实握手（需要本机凭证）：
    /// `cargo test --lib wg_handshake -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn handshakes_real_endpoints() {
        let Some(cred) = real_cred() else {
            panic!("找不到真实凭证")
        };
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
        let t0 = Instant::now();
        let out = probe_hosts(&cred, &hosts, 2408, Duration::from_millis(DEFAULT_TIMEOUT_MS), CONCURRENCY);
        let elapsed = t0.elapsed();
        for p in &out {
            println!("{}:{} rtt={} ok={} {}", p.host, p.port, p.rtt, p.ok, p.error);
        }
        println!("6 个端点耗时 {:?}", elapsed);
        assert_eq!(out.len(), 6);
        assert!(out.iter().any(|p| p.ok), "所有端点握手都失败，请检查网络与凭证");
    }
    /// 回环对拍：本机起一个 boringtun 服务端，验证「生成握手 → 发 UDP → 收响应 →
    /// 判定完成 → 计时」整条代码路径。实网被阻断时这是唯一能验证客户端逻辑的办法。
    #[test]
    fn handshake_completes_over_loopback() {
        fn rand_key() -> [u8; 32] {
            let mut b = [0u8; 32];
            getrandom::getrandom(&mut b).expect("随机数失败");
            b
        }
        let server_priv = StaticSecret::from(rand_key());
        let client_priv = StaticSecret::from(rand_key());
        let server_pub = PublicKey::from(&server_priv);
        let client_pub = PublicKey::from(&client_priv);

        let server_sock = UdpSocket::bind("127.0.0.1:0").expect("bind");
        let port = server_sock.local_addr().unwrap().port();
        let sock = server_sock.try_clone().unwrap();
        let mut server = Tunn::new(server_priv, client_pub, None, None, 99, None);
        let handle = std::thread::spawn(move || {
            sock.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut buf = [0u8; 2048];
            let mut out = [0u8; 2048];
            let mut replied = false;
            for _ in 0..4 {
                let Ok((n, peer)) = sock.recv_from(&mut buf) else { return replied };
                // 响应方发出握手响应即算应答（它自己的 last_handshake 要等首个数据包才更新）
                if let TunnResult::WriteToNetwork(p) = server.decapsulate(None, &buf[..n], &mut out) {
                    let _ = sock.send_to(p, peer);
                    replied = true;
                }
                if replied {
                    break;
                }
            }
            replied
        });

        let cred = WarpCredential {
            private_key: B64.encode(client_priv.to_bytes()),
            peer_public_key: B64.encode(server_pub.to_bytes()),
            ..Default::default()
        };
        let (rtt, err) = handshake_once(&cred, "127.0.0.1", port, Duration::from_millis(1200));
        assert!(rtt > 0, "回环握手失败: {}", err);
        assert!(handle.join().unwrap(), "服务端没有发出握手响应");
        assert!(rtt < 600, "rtt 应为真实往返而非超时值: {}", rtt);
    }
}
