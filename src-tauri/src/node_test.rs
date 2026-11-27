//! 订阅节点一键测速（延迟 + 下载速度）。
//!
//! 原理：另起一个独立的 mihomo 实例，为每个节点开一个本地 HTTP 入口
//! （`listeners[].proxy` 强制走指定出站），再用 curl 多线程并发测延迟/下载速度。
//! 与主隧道完全隔离：不连接也能测，测速不会影响已建立的连接和系统代理。

use crate::core::{app_dir, download_core, hidden_command};
use crate::subscription::SubNode;
use serde::Serialize;
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

/// 最近一次配置校验失败的原因（供界面提示，不再只是"无法加载"）
static LAST_FAIL: Mutex<Option<String>> = Mutex::new(None);
use std::time::{Duration, Instant};

const DELAY_URL: &str = "https://www.gstatic.com/generate_204";
/// 下载测速源：按可用性排序，逐个回退（Cloudflare speed 端点会按出口 IP 返回 403）
const SPEED_URLS: [&str; 3] = [
    "https://ash-speed.hetzner.com/100MB.bin",
    "https://proof.ovh.net/files/100Mb.dat",
    "https://speed.cloudflare.com/__down?bytes=104857600",
];
const MAX_NODES: usize = 400;

/// 每个节点的测速结果；delay / speed 为 0 且 error 非空表示失败。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeStat {
    pub id: String,
    /// 毫秒；-1 表示未测
    pub delay: i64,
    /// bytes/s
    pub speed: u64,
    /// 本次测速实际下载字节数
    pub bytes: u64,
    pub error: String,
}

impl NodeStat {
    fn fail(id: &str, msg: impl Into<String>) -> Self {
        NodeStat { id: id.to_string(), delay: -1, speed: 0, bytes: 0, error: msg.into() }
    }
}

/// 启动结果：哪些节点被核心接受、哪些被跳过。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestStart {
    pub tested: usize,
    /// 配置无法被核心加载的节点 id
    pub skipped: Vec<String>,
}

struct TestSession {
    child: Child,
    dir: PathBuf,
    ports: Vec<(String, u16)>,
    /// 节点 id，顺序与配置里的 N0..N{n} 一致（组延迟结果按名字映射回 id）
    ids: Vec<String>,
    /// 核心 REST 端口（组延迟调用入口）
    api_port: u16,
}

#[derive(Default)]
pub struct NodeTestState(Mutex<Option<TestSession>>);

fn null_dev() -> &'static str {
    if cfg!(windows) {
        "NUL"
    } else {
        "/dev/null"
    }
}

fn stop_session(state: &NodeTestState) {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(mut s) = guard.take() {
            let _ = s.child.kill();
            let _ = s.child.wait();
            std::thread::sleep(Duration::from_millis(120));
            let _ = std::fs::remove_dir_all(&s.dir);
        }
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

/// 把订阅解析出的 `SUB-NODE` 出站块改名为唯一名字，避免同批测速重名。
fn rename_node(cfg: &str, name: &str) -> String {
    let mut out = String::with_capacity(cfg.len() + 16);
    for (idx, line) in cfg.lines().enumerate() {
        if idx == 0 && line.trim_start().starts_with("- name:") {
            out.push_str(&format!("  - name: \"{}\"\n", name));
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

/// 测速专用配置。
///
/// - `listeners`：每个节点一个本地 HTTP 入口，只给**下载测速**用（同一时刻只测几路，
///   需要把流量精确归到某个节点）；
/// - `PROBE` 组：延迟测试走一次 `/group/PROBE/delay`，由核心内部并发调度，
///   不再从外面套 8 路 curl；
/// - dns 段是必需的：缺了它 mihomo 会用系统 DNS 解析 CDN 前置域名，
///   经常解析到不通的边缘地址，节点成片假超时。
fn render_config(items: &[(SubNode, u16)], api_port: u16) -> String {
    let mut proxies = String::new();
    let mut listeners = String::new();
    let mut group = String::new();
    for (idx, (node, port)) in items.iter().enumerate() {
        proxies.push_str(&rename_node(&node.config, &format!("N{}", idx)));
        listeners.push_str(&format!(
            "  - name: nt{}\n    type: http\n    port: {}\n    listen: 127.0.0.1\n    proxy: \"N{}\"\n",
            idx, port, idx
        ));
        group.push_str(&format!("      - \"N{}\"\n", idx));
    }
    format!(
        "# AnTun 节点测速专用配置（临时文件）\nmode: rule\nlog-level: warning\nipv6: false\nunified-delay: true\ntcp-concurrent: true\nexternal-controller: 127.0.0.1:{api}\n\ndns:\n  enable: true\n  ipv6: false\n  use-hosts: false\n  nameserver:\n    - 8.8.8.8\n    - 1.1.1.1\n  proxy-server-nameserver:\n    - 8.8.8.8\n    - 1.1.1.1\n\nproxies:\n{proxies}\nlisteners:\n{listeners}\nproxy-groups:\n  - name: PROBE\n    type: select\n    proxies:\n{group}\nrules:\n  - MATCH,DIRECT\n",
        api = api_port,
        proxies = proxies,
        listeners = listeners,
        group = group,
    )
}

/// 校验配置能否被核心加载（订阅里常混有不被支持的节点参数）。
fn config_ok(exe: &Path, dir: &Path, cfg: &str) -> bool {
    static SEQ: AtomicUsize = AtomicUsize::new(0);
    let path = dir.join(format!("probe-{}.yaml", SEQ.fetch_add(1, Ordering::Relaxed)));
    if std::fs::write(&path, cfg).is_err() {
        return false;
    }
    let out = hidden_command(exe)
        .args(["-t", "-f", path.to_string_lossy().as_ref(), "-d", dir.to_string_lossy().as_ref()])
        .output();
    let ok = out.as_ref().map(|o| o.status.success()).unwrap_or(false);
    if !ok {
        let text = out
            .as_ref()
            .map(|o| {
                let mut t = String::from_utf8_lossy(&o.stdout).to_string();
                t.push_str(&String::from_utf8_lossy(&o.stderr));
                t
            })
            .unwrap_or_default();
        let reason = text
            .lines()
            .rev()
            .find(|l| l.contains("level=error") || l.contains("failed"))
            .map(|l| l.trim().to_string())
            .or_else(|| out.as_ref().err().map(|e| e.to_string()))
            .unwrap_or_else(|| "核心校验未通过".to_string());
        if let Ok(mut guard) = LAST_FAIL.lock() {
            *guard = Some(reason);
        }
        if std::env::var("ANTUN_NT_DEBUG").is_ok() {
            use std::io::Write as _;
            let dump = format!(
                "\n===== {} =====\nstatus={:?}\n{}\n---cfg---\n{}\n",
                path.file_name().unwrap_or_default().to_string_lossy(),
                out.as_ref().map(|o| o.status.code()),
                text,
                cfg
            );
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("validate.log")) {
                let _ = f.write_all(dump.as_bytes());
            }
        }
    }
    let _ = std::fs::remove_file(&path);
    ok
}

/// 二分剔除坏节点：整批不通过就拆半继续校验，最终得到核心能加载的子集。
fn pick_valid(exe: &Path, dir: &Path, items: Vec<(SubNode, u16)>) -> Vec<(SubNode, u16)> {
    if items.is_empty() {
        return items;
    }
    if config_ok(exe, dir, &render_config(&items, 39999)) {
        return items;
    }
    if items.len() == 1 {
        return vec![];
    }
    let mut head = items;
    let tail = head.split_off(head.len() / 2);
    let mut out = pick_valid(exe, dir, head);
    out.extend(pick_valid(exe, dir, tail));
    out
}

/// 一次组延迟调用：`GET /group/PROBE/delay?url=…&timeout=5000`。
/// 返回 {代理名: 毫秒}；没答上来的节点不在 map 里。
fn group_delay(api_port: u16, timeout_ms: u32) -> Result<std::collections::HashMap<String, i64>, String> {
    let url = format!(
        "http://127.0.0.1:{}/group/PROBE/delay?url={}&timeout={}",
        api_port,
        crate::endpoint_probe::url_encode(DELAY_URL),
        timeout_ms
    );
    // 整组结束时间晚于单个节点的超时，留足余量
    let max_time = (timeout_ms / 1000 + 20).to_string();
    let out = hidden_command("curl.exe")
        .args(["-sS", "--max-time", &max_time, &url])
        .output()
        .map_err(|e| format!("curl 启动失败: {}", e))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let body = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str::<std::collections::HashMap<String, i64>>(body.trim())
        .map_err(|e| format!("组延迟响应无法解析: {} ({})", e, body.chars().take(80).collect::<String>()))
}

fn curl_speed_url(port: u16, seconds: u32, url: &str) -> (u64, u64, String) {
    let out = hidden_command("curl.exe")
        .args([
            "-sS",
            "-o",
            null_dev(),
            "--connect-timeout",
            "3",
            "--max-time",
            &seconds.to_string(),
            "-x",
            &format!("http://127.0.0.1:{}", port),
            "-w",
            "%{speed_download} %{size_download}",
            url,
        ])
        .output();
    let Ok(out) = out else {
        return (0, 0, "curl 启动失败".into());
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut it = text.split_whitespace();
    let speed: f64 = it.next().and_then(|v| v.parse().ok()).unwrap_or(0.0);
    let bytes: u64 = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    if bytes < 32 * 1024 {
        return (0, bytes, "下载失败或速度过低".into());
    }
    ((speed.round() as u64).max(1), bytes, String::new())
}

/// 依次尝试多个测速源，任一源拿到数据即返回（单个源被风控时自动回退）。
fn curl_speed(port: u16, seconds: u32) -> (u64, u64, String) {
    let mut last = (0u64, 0u64, "下载失败".to_string());
    for url in SPEED_URLS {
        let (speed, bytes, err) = curl_speed_url(port, seconds, url);
        if bytes >= 32 * 1024 {
            return (speed, bytes, String::new());
        }
        last = (speed, bytes, err);
    }
    last
}

/// 按并发数分批执行，避免一次性拉起上百个 curl。
fn run_batch<F>(jobs: Vec<(String, u16)>, concurrency: usize, f: F) -> Vec<NodeStat>
where
    F: Fn(&str, u16) -> NodeStat + Sync,
{
    let mut out = Vec::with_capacity(jobs.len());
    for chunk in jobs.chunks(concurrency.max(1)) {
        let mut part: Vec<NodeStat> = std::thread::scope(|scope| {
            let f = &f;
            chunk
                .iter()
                .map(|(id, port)| {
                    let id = id.as_str();
                    let port = *port;
                    scope.spawn(move || f(id, port))
                })
                .collect::<Vec<_>>()
                .into_iter()
                .filter_map(|h| h.join().ok())
                .collect()
        });
        out.append(&mut part);
    }
    out
}

/// 准备测速会话：写临时配置、拉起独立核心、等待各节点入口就绪。
#[tauri::command]
pub async fn node_test_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, NodeTestState>,
    nodes: Vec<SubNode>,
) -> Result<TestStart, String> {
    stop_session(&state);
    if nodes.is_empty() {
        return Err("没有可测速的节点".into());
    }
    let exe = download_core(&app)?;
    let base = app_dir(&app)?.join("node-test");
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).map_err(|e| format!("创建测速目录失败: {}", e))?;

    let nodes: Vec<SubNode> = nodes.into_iter().take(MAX_NODES).collect();
    let total = nodes.len();
    let mut all_ids: Vec<String> = Vec::with_capacity(total);
    let mut items: Vec<(SubNode, u16)> = Vec::with_capacity(total);
    let mut skipped: Vec<String> = Vec::new();
    for node in nodes {
        all_ids.push(node.id.clone());
        match free_port() {
            Some(port) => items.push((node, port)),
            None => skipped.push(node.id),
        }
    }

    let valid = pick_valid(&exe, &base, items);
    let valid_ids: std::collections::HashSet<String> =
        valid.iter().map(|(n, _)| n.id.clone()).collect();
    // 校验阶段被剔除的节点
    skipped.extend(all_ids.iter().filter(|id| !valid_ids.contains(*id)).cloned());

    if valid.is_empty() {
        let reason = LAST_FAIL
            .lock()
            .ok()
            .and_then(|g| g.clone())
            .unwrap_or_else(|| "核心拒绝加载所有节点".to_string());
        if std::env::var("ANTUN_NT_DEBUG").is_err() {
            let _ = std::fs::remove_dir_all(&base);
        }
        return Err(format!("订阅节点配置均无法被核心加载（{}）", reason));
    }

    let api_port = free_port().ok_or_else(|| "没有可用的本地端口".to_string())?;
    let cfg = render_config(&valid, api_port);
    let cfg_path = base.join("config.yaml");
    std::fs::write(&cfg_path, &cfg).map_err(|e| format!("写测速配置失败: {}", e))?;

    let child = hidden_command(&exe)
        .args([
            "-f",
            cfg_path.to_string_lossy().as_ref(),
            "-d",
            base.to_string_lossy().as_ref(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("启动测速核心失败: {}", e))?;

    let ports: Vec<(String, u16)> = valid.iter().map(|(n, p)| (n.id.clone(), *p)).collect();
    let ids: Vec<String> = valid.iter().map(|(n, _)| n.id.clone()).collect();
    let session = TestSession { child, dir: base.clone(), ports, ids, api_port };

    // 等待入口监听：全部就绪即返回，最多 12 秒
    let deadline = Instant::now() + Duration::from_secs(12);
    loop {
        if session.ports.iter().all(|(_, p)| port_ready(*p)) {
            break;
        }
        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(150));
    }

    let live: Vec<(String, u16)> = session
        .ports
        .iter()
        .filter(|(_, p)| port_ready(*p))
        .cloned()
        .collect();
    if live.is_empty() {
        let _ = std::fs::remove_dir_all(&base);
        return Err("测速核心启动失败，请检查订阅节点".into());
    }

    let tested = live.len();
    let live_ids: std::collections::HashSet<String> = live.iter().map(|(id, _)| id.clone()).collect();
    // 校验通过的节点里，若入口没起来也算跳过
    skipped.extend(valid_ids.iter().filter(|id| !live_ids.contains(*id)).cloned());
    if let Ok(mut guard) = state.0.lock() {
        *guard = Some(session);
    }

    Ok(TestStart { tested, skipped })
}

/// 延迟测试：一次组延迟调用，核心内部并发探测所有节点。
///
/// 之前是「每节点 8 路 curl、每节点测两次取较小」，400 个节点要几分钟；
/// 现在整组交给 mihomo 调度，且 `unified-delay: true` 让数字只含连接建立时间，
/// 和 Clash / Mihomo Party 的口径一致（不再把 DNS + TLS 折进去）。
#[tauri::command]
pub async fn node_test_delay(state: tauri::State<'_, NodeTestState>) -> Result<Vec<NodeStat>, String> {
    let (api_port, ids) = {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        match guard.as_ref() {
            Some(s) => (s.api_port, s.ids.clone()),
            None => return Err("测速会话未启动".into()),
        }
    };
    // 整组延迟可能要十几秒，放阻塞线程池，避免占住 async 运行时
    let map = tauri::async_runtime::spawn_blocking(move || group_delay(api_port, 5000))
        .await
        .map_err(|e| format!("延迟测试任务失败: {}", e))??;
    Ok(ids
        .iter()
        .enumerate()
        .map(|(idx, id)| {
            let ms = map.get(&format!("N{}", idx)).copied().unwrap_or(-1);
            if ms > 0 {
                NodeStat { id: id.clone(), delay: ms, speed: 0, bytes: 0, error: String::new() }
            } else {
                NodeStat { id: id.clone(), delay: -1, speed: 0, bytes: 0, error: "超时".into() }
            }
        })
        .collect())
}

/// 并发测下载速度（默认 3 路，同时下载会互相抢带宽，所以并发不宜过高）。
#[tauri::command]
pub async fn node_test_speed(
    state: tauri::State<'_, NodeTestState>,
    ids: Vec<String>,
    seconds: Option<u32>,
    concurrency: Option<u16>,
) -> Result<Vec<NodeStat>, String> {
    let ports: Vec<(String, u16)> = {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        let ports = match guard.as_ref() {
            Some(s) => s.ports.clone(),
            None => return Err("测速会话未启动".into()),
        };
        if ids.is_empty() {
            ports
        } else {
            ports.into_iter().filter(|(id, _)| ids.contains(id)).collect()
        }
    };
    if ports.is_empty() {
        return Err("测速会话中找不到这些节点".into());
    }
    let secs = seconds.unwrap_or(6).clamp(2, 20);
    let conc = concurrency.unwrap_or(3).clamp(1, 8) as usize;
    Ok(run_batch(ports, conc, move |id, port| {
        let (speed, bytes, error) = curl_speed(port, secs);
        NodeStat { speed, bytes, error, ..NodeStat::fail(id, "") }
    }))
}

/// 结束测速会话，清理临时目录与核心进程。
#[tauri::command]
pub fn node_test_stop(state: tauri::State<'_, NodeTestState>) -> Result<(), String> {
    stop_session(&state);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const WG_CFG: &str = r#"  - name: "SUB-NODE"
    type: "wireguard"
    private-key: "AO9FFXpvI2abd29iiuIskLoRg3nkT3j1VGs1M/1cj3s="
    ip: 172.16.0.2
    peers:
      - server: 8.35.211.178
        port: 2408
        public-key: "bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo="
        allowed-ips: ['0.0.0.0/0']
        persistent-keepalive: 25
    mtu: 1280
    udp: true
"#;

    fn node(id: &str, cfg: &str) -> SubNode {
        SubNode {
            id: id.into(),
            sub_id: "s".into(),
            name: id.into(),
            node_type: "wireguard".into(),
            server: "8.35.211.178".into(),
            port: 2408,
            config: cfg.into(),
        }
    }

    #[test]
    fn rename_keeps_fields_and_replaces_name() {
        let out = rename_node(WG_CFG, "N7");
        assert!(out.starts_with("  - name: \"N7\"\n"));
        assert!(out.contains("type: \"wireguard\""));
        assert!(!out.contains("SUB-NODE"));
    }

    /// 需要真实核心的校验测试：
    /// `ANTUN_CORE=src-tauri/resources/mihomo.exe cargo test -- --ignored`
    #[test]
    #[ignore]
    fn validates_generated_config_with_real_core() {
        let Ok(path) = std::env::var("ANTUN_CORE") else { return };
        let exe = std::path::PathBuf::from(path);
        if !exe.exists() {
            return;
        }
        let dir = std::env::temp_dir().join("antun-nt-test");
        std::fs::create_dir_all(&dir).unwrap();
        let items = vec![(node("a", WG_CFG), 21041u16), (node("b", WG_CFG), 21042)];
        let kept = pick_valid(&exe, &dir, items);
        // 保留现场，便于失败时人工复核
        let cfg = render_config(&[(node("a", WG_CFG), 21041u16)], 39998);
        std::fs::write(dir.join("debug-single.yaml"), cfg).unwrap();
        assert_eq!(kept.len(), 2, "valid nodes must pass core validation");
    }

    #[test]
    fn config_binds_each_node_to_its_own_listener() {
        let cfg = render_config(&[(node("a", WG_CFG), 21001)], 29999);
        assert!(cfg.contains("port: 21001"));
        assert!(cfg.contains("proxy: \"N0\""));
        assert!(cfg.contains("external-controller: 127.0.0.1:29999"));
    }

    #[test]
    fn config_exposes_probe_group_and_dns() {
        let items = vec![(node("a", WG_CFG), 21001u16), (node("b", WG_CFG), 21002)];
        let cfg = render_config(&items, 29999);
        // 延迟测试走一次组调用，组里必须包含全部节点
        assert!(cfg.contains("proxy-groups:\n  - name: PROBE\n    type: select"));
        assert!(cfg.contains("      - \"N0\""));
        assert!(cfg.contains("      - \"N1\""));
        // 缺 dns 段会让 CDN 前置域名走系统 DNS，集体假超时
        assert!(cfg.contains("proxy-server-nameserver:"));
        // unified-delay 决定数字口径（连接建立时间，不含 DNS/TLS）
        assert!(cfg.contains("unified-delay: true"));
        // 下载测速仍靠 listeners
        assert!(cfg.contains("listeners:"));
    }

    #[test]
    fn group_delay_fails_without_core() {
        let port = free_port().unwrap_or(40009);
        assert!(group_delay(port, 300).is_err(), "没有核心时必须报错，不能返回空 map 冒充成功");
    }
}
