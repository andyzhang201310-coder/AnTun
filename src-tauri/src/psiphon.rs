//! Psiphon 出口：拉起官方 tunnel-core 客户端，拿到它的本地 SOCKS 端口，
//! 由 mihomo 把最终出站指过去。
//!
//! 为什么不是「叠加在 WARP 之上」：tunnel-core 自己直连互联网，要让它的流量走 WARP
//! 就得把它的 UpstreamProxy 指回 mihomo，而 mihomo 的出口又是 Psiphon，会形成回环。
//! 做真正的双层必须给 Psiphon 的流量单独开一个强制走 WARP 的入站，复杂度与收益不匹配。
//! 所以这里的语义是明确的：**Psiphon 替代 WARP 作为最终出口**，基础协议不参与。

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Read;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// 总预算。实测 Psiphon 单次连接成功率不稳（同一网络下 89 次 ConnectingServer 全失败，
/// 重启进程后 15 秒就连上了），所以预算要覆盖「下载列表 + 两三次重试」。
pub const DEFAULT_TIMEOUT_SECS: u64 = 150;
/// 单次尝试上限：够下载远程列表并完成一轮连接，失败就重启进程换一批服务器。
const ATTEMPT_TIMEOUT_SECS: u64 = 60;

#[derive(Default)]
pub struct PsiphonState {
    child: Mutex<Option<Child>>,
    /// Windows Job 句柄：主程序被杀时由系统一并结束 Psiphon，不留孤儿进程
    job: Mutex<Option<isize>>,
    socks_port: Mutex<Option<u16>>,
    region: Mutex<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PsiphonStatus {
    pub running: bool,
    pub socks_port: u16,
    pub region: String,
    /// 进程已起但隧道还没建立（bootstrap 中）
    pub ready: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RegionOption {
    code: String,
    name_zh: String,
    name_en: String,
    live: bool,
}

#[derive(Deserialize, Default)]
struct RegionsCache {
    regions: Vec<String>,
}

/// 首次运行、尚无 Psiphon 实时地区缓存时显示的列表（与 XEHN 内置表一致）。
const FALLBACK: &[(&str, &str, &str)] = &[
    ("US", "美国", "United States"),
    ("GB", "英国", "United Kingdom"),
    ("DE", "德国", "Germany"),
    ("FR", "法国", "France"),
    ("NL", "荷兰", "Netherlands"),
    ("CA", "加拿大", "Canada"),
    ("JP", "日本", "Japan"),
    ("KR", "韩国", "South Korea"),
    ("SG", "新加坡", "Singapore"),
    ("HK", "中国香港", "Hong Kong, China"),
    ("IN", "印度", "India"),
    ("AU", "澳大利亚", "Australia"),
    ("RU", "俄罗斯", "Russia"),
    ("TH", "泰国", "Thailand"),
    ("VN", "越南", "Vietnam"),
    ("MY", "马来西亚", "Malaysia"),
    ("ID", "印度尼西亚", "Indonesia"),
    ("PH", "菲律宾", "Philippines"),
    ("TW", "中国台湾", "Taiwan, China"),
    ("MO", "中国澳门", "Macao, China"),
    ("BR", "巴西", "Brazil"),
    ("TR", "土耳其", "Turkey"),
    ("PL", "波兰", "Poland"),
    ("SE", "瑞典", "Sweden"),
    ("CH", "瑞士", "Switzerland"),
    ("IT", "意大利", "Italy"),
    ("ES", "西班牙", "Spain"),
    ("UA", "乌克兰", "Ukraine"),
    ("NZ", "新西兰", "New Zealand"),
    ("ZA", "南非", "South Africa"),
];

fn app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {}", e))
}

/// Psiphon 的独立工作目录：配置、bolt 数据、日志都在这里，和 mihomo 的配置分开
fn work_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_dir(app)?.join("psiphon"))
}

fn log_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(work_dir(app)?.join("psiphon.log"))
}

fn regions_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_dir(app)?.join("psiphon-regions.json"))
}

fn load_live_codes(app: &AppHandle) -> Vec<String> {
    let Ok(path) = regions_path(app) else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(cache) = serde_json::from_str::<RegionsCache>(&text) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for code in cache.regions {
        let code = code.trim().to_ascii_uppercase();
        if code.len() == 2 && !out.contains(&code) {
            out.push(code);
        }
    }
    out
}

fn option(code: &str, name_zh: &str, name_en: &str, live: bool) -> RegionOption {
    RegionOption {
        code: code.to_string(),
        name_zh: name_zh.to_string(),
        name_en: name_en.to_string(),
        live,
    }
}

#[tauri::command]
pub fn psiphon_regions(app: AppHandle) -> Vec<RegionOption> {
    let live_codes = load_live_codes(&app);
    let mut out = vec![option("", "自动选择", "Automatic", false)];
    for (code, zh, en) in FALLBACK {
        out.push(option(code, zh, en, live_codes.iter().any(|c| c == code)));
    }
    let mut extras: Vec<String> = live_codes
        .into_iter()
        .filter(|c| !FALLBACK.iter().any(|(code, _, _)| code == c))
        .collect();
    extras.sort();
    for code in extras {
        out.push(option(&code, &code, &code, true));
    }
    out
}

fn valid_region(region: &str) -> Result<String, String> {
    let r = region.trim().to_ascii_uppercase();
    if !r.is_empty() && (r.len() != 2 || !r.bytes().all(|b| b.is_ascii_uppercase())) {
        return Err("出口地区必须是两位 ISO 国家码或留空自动选择".into());
    }
    Ok(r)
}

/// 设置页改地区：写入 Psiphon 的工作配置。真正生效在下次连接（start 会用设置里的值重写）。
#[tauri::command]
pub fn set_psiphon_region(app: AppHandle, region: String) -> Result<(), String> {
    let region = valid_region(&region)?;
    let dir = work_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create dir: {}", e))?;
    let path = dir.join("client.config");
    if !path.is_file() {
        crate::core::ensure_bundled_extras(&app);
        if !path.is_file() {
            return Err("未找到 Psiphon 官方 client.config".into());
        }
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("read client.config: {}", e))?;
    let mut config: Value = serde_json::from_str(&text).map_err(|e| format!("parse client.config: {}", e))?;
    config["EgressRegion"] = json!(region);
    let updated = serde_json::to_string_pretty(&config).map_err(|e| format!("serialize client.config: {}", e))?;
    std::fs::write(&path, updated).map_err(|e| format!("write client.config: {}", e))
}

fn free_port() -> Result<u16, String> {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .map_err(|e| format!("找不到空闲端口: {}", e))
}

fn hex_decode(s: &str) -> Option<String> {
    if s.len() % 2 != 0 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let bytes: Vec<u8> = (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect::<Option<Vec<u8>>>()?;
    String::from_utf8(bytes).ok()
}

/// 内置的 server_list.dat 是 legacy 格式（每行 `0 0 0 0 {serverEntry}` 的十六进制）。
/// tunnel-core 只认 config 里的 ServerList（base64 的 JSON 数组），所以这里转换注入；
/// 不注入的话首次启动 entries=0，只能等远程列表（实测要 30 秒且经常拿不到）。
fn inject_server_list(cfg: &mut Value, app: &AppHandle) -> bool {
    let Some(path) = crate::core::bundled_resource_path(app, "server_list.dat") else {
        return false;
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    let mut entries: Vec<Value> = Vec::new();
    for line in raw.lines() {
        let s = line.trim();
        if s.is_empty() {
            continue;
        }
        let text = hex_decode(s).unwrap_or_else(|| s.to_string());
        let Some(brace) = text.find('{') else { continue };
        if let Ok(v) = serde_json::from_str::<Value>(&text[brace..]) {
            entries.push(v);
        }
    }
    if entries.is_empty() {
        return false;
    }
    let json_text = serde_json::to_string(&entries).unwrap_or_default();
    cfg["ServerList"] = Value::String(BASE64.encode(json_text.as_bytes()));
    true
}

/// 生成一份可直接启动的 client.config：
/// - DataRootDirectory 换成用户数据目录（内置的是作者机器的绝对路径）
/// - 清掉内置的 UpstreamProxyURL（指向 127.0.0.1:7890，别的机器上没这个代理，会导致完全连不上）
/// - 端口动态分配，避免和其他软件冲突
fn write_config(app: &AppHandle, region: &str, socks: u16, http: u16) -> Result<PathBuf, String> {
    let dir = work_dir(app)?;
    let data = dir.join("data");
    std::fs::create_dir_all(&data).map_err(|e| format!("create psiphon dir: {}", e))?;

    let src = crate::core::bundled_resource_path(app, "client.config")
        .ok_or_else(|| "安装包缺少 Psiphon 的 client.config".to_string())?;
    let text = std::fs::read_to_string(&src).map_err(|e| format!("read client.config: {}", e))?;
    let mut cfg: Value = serde_json::from_str(&text).map_err(|e| format!("parse client.config: {}", e))?;

    cfg["DataRootDirectory"] = json!(data.to_string_lossy());
    cfg["EgressRegion"] = json!(region);
    cfg["LocalSocksProxyPort"] = json!(socks);
    cfg["LocalHttpProxyPort"] = json!(http);
    cfg["UpstreamProxyURL"] = json!("");
    inject_server_list(&mut cfg, app);

    let path = dir.join("client.config");
    std::fs::write(&path, serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?)
        .map_err(|e| format!("write client.config: {}", e))?;
    Ok(path)
}

/// 从日志里判断隧道是否已建立：取最后一条 Tunnels 通知的 count
fn tunnel_up(text: &str) -> bool {
    let Some(p) = text.rfind("\"noticeType\":\"Tunnels\"") else {
        return false;
    };
    let from = p.saturating_sub(96);
    let Some(slice) = text.get(from..p) else {
        return false;
    };
    let Some(c) = slice.rfind("\"count\":") else {
        return false;
    };
    let digits: String = slice[c + 8..].chars().take_while(|ch| ch.is_ascii_digit()).collect();
    digits.parse::<u32>().map(|n| n > 0).unwrap_or(false)
}

/// 从日志里取 Psiphon 当前报告的可用出口地区。
/// 选了地区但该地区不在列表里时，继续等下去只是白等到超时，直接失败更有用。
fn available_regions(text: &str) -> Vec<String> {
    let Some(p) = text.rfind("\"noticeType\":\"AvailableEgressRegions\"") else {
        return Vec::new();
    };
    let from = p.saturating_sub(2048);
    let Some(slice) = text.get(from..p) else {
        return Vec::new();
    };
    let Some(q) = slice.rfind("\"regions\":[") else {
        return Vec::new();
    };
    let rest = &slice[q + 11..];
    let inner = rest.split(']').next().unwrap_or("");
    inner
        .split(',')
        .map(|part| part.trim().trim_matches('"').to_ascii_uppercase())
        .filter(|c| c.len() == 2 && c.bytes().all(|b| b.is_ascii_uppercase()))
        .collect()
}

/// 读日志尾部若干字节，用于错误提示（不一次性读满整个文件）
fn tail_text(path: &std::path::Path, limit: u64) -> String {
    let Ok(mut f) = std::fs::File::open(path) else {
        return String::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    if len > limit {
        use std::io::{Seek, SeekFrom};
        let _ = f.seek(SeekFrom::Start(len - limit));
    }
    let mut buf = String::new();
    let _ = f.read_to_string(&mut buf);
    buf
}

fn last_error_line(text: &str) -> String {
    for line in text.lines().rev() {
        if let Some(p) = line.find("\"message\":\"") {
            let rest = &line[p + 11..];
            // 通知格式是 {"data":{"message":"..."},"noticeType":...}，message 的结尾是 "}
            let msg = rest.split("\"}").next().unwrap_or("").trim();
            if !msg.is_empty() {
                return msg.chars().take(240).collect();
            }
        }
    }
    "未知错误".into()
}

/// 单次尝试的失败原因：Fatal 表示重试也没意义（如所选地区不可用）
enum Fail {
    Retry(String),
    Fatal(String),
}

/// 启动一次 Psiphon 进程并等隧道建立
fn attempt_once(
    app: &AppHandle,
    region: &str,
    timeout: Duration,
    cancel: &AtomicBool,
) -> Result<u16, Fail> {
    crate::core::ensure_bundled_extras(app);

    let dir = work_dir(app).map_err(Fail::Fatal)?;
    std::fs::create_dir_all(&dir).map_err(|e| Fail::Fatal(format!("create psiphon dir: {}", e)))?;
    let exe_dir = app_dir(app).map_err(Fail::Fatal)?;
    let exe = exe_dir.join("psiphon.exe");
    if !exe.is_file() {
        return Err(Fail::Fatal("缺少 psiphon.exe（组件未随包释放）".into()));
    }

    let socks = free_port().map_err(Fail::Fatal)?;
    let http = free_port().map_err(Fail::Fatal)?;
    let cfg = write_config(app, region, socks, http).map_err(Fail::Fatal)?;

    // 每次启动都重写日志，避免把上次的 Tunnels 通知误判成本次已就绪
    let log = log_path(app).map_err(Fail::Fatal)?;
    let out = std::fs::File::create(&log).map_err(|e| Fail::Fatal(format!("create psiphon log: {}", e)))?;
    let err = out.try_clone().map_err(|e| Fail::Fatal(format!("clone log handle: {}", e)))?;

    let child = crate::core::hidden_command(&exe)
        .args(["-config", cfg.to_string_lossy().as_ref()])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::from(out))
        .stderr(std::process::Stdio::from(err))
        .spawn()
        .map_err(|e| Fail::Fatal(format!("启动 Psiphon 失败: {}", e)))?;

    let job = crate::core::bind_child_to_job(&child);
    // 逐次取 State：State 是临时借用，绑成变量会让尾部的 MutexGuard 与它同生命周期冲突
    if let Ok(mut g) = app.state::<PsiphonState>().child.lock() {
        *g = Some(child);
    }
    if let Ok(mut g) = app.state::<PsiphonState>().job.lock() {
        *g = job;
    }
    if let Ok(mut g) = app.state::<PsiphonState>().socks_port.lock() {
        *g = Some(socks);
    }
    if let Ok(mut g) = app.state::<PsiphonState>().region.lock() {
        *g = region.to_string();
    }

    let started = Instant::now();
    loop {
        // 用户点「取消连接」：立刻放弃，不再等隧道建立
        if cancel.load(Ordering::SeqCst) {
            return Err(Fail::Fatal(crate::core::CANCELLED.into()));
        }
        // 进程提前退出（本机观察到过 Go runtime 崩溃）：立刻失败，不要白等到超时
        let exit_code = {
            let st = app.state::<PsiphonState>();
            let mut guard = st.child.lock().map_err(|_| Fail::Retry("Psiphon 状态锁失效".into()))?;
            match guard.as_mut() {
                Some(c) => match c.try_wait() {
                    Ok(Some(status)) => Some(status.code()),
                    _ => None,
                },
                None => None,
            }
        };
        if let Some(code) = exit_code {
            let tail = tail_text(&log, 16 * 1024);
            let reason = last_error_line(&tail);
            return Err(Fail::Retry(format!("进程退出（code={:?}）：{}", code, reason)));
        }

        let text = tail_text(&log, 64 * 1024);
        if tunnel_up(&text) {
            return Ok(socks);
        }
        // 选了具体地区但 Psiphon 报告的可选地区里没有：直接失败，别让用户空等两分钟
        if !region.is_empty() {
            let regions = available_regions(&text);
            if !regions.is_empty() && !regions.iter().any(|r| r == region) {
                return Err(Fail::Fatal(format!(
                    "出口地区 {} 当前不可用。可选地区：{}",
                    region,
                    regions.join("/")
                )));
            }
        }

        if started.elapsed() >= timeout {
            let tail = tail_text(&log, 16 * 1024);
            let reason = last_error_line(&tail);
            return Err(Fail::Retry(format!("{} 秒内未建立隧道（{}）", timeout.as_secs(), reason)));
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// 启动 Psiphon 并等到隧道建立，返回本地 SOCKS 端口。
///
/// 单次尝试不成功就重启进程再试：实测同一网络下第一次可能一轮尝试全部连不上，
/// 重启后换一批服务器往往十几秒就通，所以重试是必要的而不是保险措施。
pub fn start(app: &AppHandle, region: &str, timeout: Duration, cancel: &AtomicBool) -> Result<u16, String> {
    let region = valid_region(region).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + timeout;
    let mut attempt = 0;
    let mut last_err = String::from("Psiphon 未能建立隧道");

    loop {
        attempt += 1;
        // 取消后不再开新一轮尝试
        if cancel.load(Ordering::SeqCst) {
            stop(app);
            return Err(crate::core::CANCELLED.into());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let slice = remaining.min(Duration::from_secs(ATTEMPT_TIMEOUT_SECS));
        stop(app);
        match attempt_once(app, &region, slice, cancel) {
            Ok(port) => return Ok(port),
            Err(Fail::Fatal(msg)) => {
                stop(app);
                return Err(msg);
            }
            Err(Fail::Retry(msg)) => last_err = msg,
        }
        if Instant::now() >= deadline {
            break;
        }
        // 给上一个进程一点退出时间，也避免在网络不好时疯狂重启
        std::thread::sleep(Duration::from_millis(1200));
    }

    stop(app);
    Err(format!("{}（已尝试 {} 次，可换出口地区或稍后重试）", last_err, attempt))
}

/// 结束 Psiphon：先 kill 再关 Job 句柄（双保险，避免残留进程）
pub fn stop(app: &AppHandle) {
    if let Ok(mut g) = app.state::<PsiphonState>().child.lock() {
        if let Some(mut c) = g.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
    if let Ok(mut g) = app.state::<PsiphonState>().job.lock() {
        if let Some(h) = g.take() {
            crate::core::close_job_handle(h);
        }
    }
    if let Ok(mut g) = app.state::<PsiphonState>().socks_port.lock() {
        *g = None;
    }
    if let Ok(mut g) = app.state::<PsiphonState>().region.lock() {
        g.clear();
    }
}

#[tauri::command]
pub fn psiphon_status(app: AppHandle) -> PsiphonStatus {
    let running = app
        .state::<PsiphonState>()
        .child
        .lock()
        .map(|mut g| match g.as_mut() {
            Some(c) => matches!(c.try_wait(), Ok(None)),
            None => false,
        })
        .unwrap_or(false);
    let socks_port = app.state::<PsiphonState>().socks_port.lock().map(|g| g.unwrap_or(0)).unwrap_or(0);
    let region = app.state::<PsiphonState>().region.lock().map(|g| g.clone()).unwrap_or_default();
    let log = log_path(&app).ok();
    let ready = log
        .as_ref()
        .map(|p| tunnel_up(&tail_text(p, 64 * 1024)))
        .unwrap_or(false);
    PsiphonStatus {
        running,
        socks_port,
        region,
        ready: running && ready,
    }
}

#[tauri::command]
pub fn psiphon_stop(app: AppHandle) -> Result<(), String> {
    stop(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_decodes_legacy_server_entry_lines() {
        // "0 0 0 0 {json}" 的十六进制
        let hex = "30203020302030207b226970223a312e327d";
        assert_eq!(hex_decode(hex).as_deref(), Some("0 0 0 0 {\"ip\":1.2}"));
        assert!(hex_decode("abc").is_none());
        assert!(hex_decode("zz").is_none());
    }

    #[test]
    fn tunnel_up_reads_last_count() {
        let up = r#"{"data":{"count":1},"noticeType":"Tunnels","timestamp":"x"}"#;
        assert!(tunnel_up(up));
        let down = r#"{"data":{"count":0},"noticeType":"Tunnels","timestamp":"y"}"#;
        assert!(!tunnel_up(down));
        // 先连后断：以最后一次为准
        let mixed = format!("{}\n{}\n", up, down);
        assert!(!tunnel_up(&mixed));
        assert!(!tunnel_up("no tunnels here"));
    }

    #[test]
    fn region_validation() {
        assert_eq!(valid_region(" us ").unwrap(), "US");
        assert_eq!(valid_region("").unwrap(), "");
        assert!(valid_region("USA").is_err());
        assert!(valid_region("1A").is_err());
    }

    #[test]
    fn last_error_extracts_message() {
        let t = r#"{"data":{"message":"boom happened"},"noticeType":"Error","timestamp":"z"}"#;
        assert_eq!(last_error_line(t), "boom happened");
    }
}
