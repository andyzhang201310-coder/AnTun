//! 备份与局域网同步
//!
//! 设计取舍：一份备份包含订阅链接、几十个节点与收藏，序列化后动辄几十 KB，
//! 直接塞进二维码必然超出容量上限（QR 最大约 2953 字节二进制）。所以二维码只承载
//! 一个局域网 URL：本机临时起一个只读 HTTP 服务，对端扫码用浏览器打开即可下载，
//! 或者把链接粘进 AnTun 的「从链接导入」由应用自己拉取。两条路都不需要对方装额外软件，
//! 也不经过任何第三方服务器。
//!
//! 安全边界：
//! - 只监听生成分享期间，最长 1 小时，到期线程自动退出、端口释放；
//! - URL 里带 128 位随机 token，且只允许 GET，没有写入接口；
//! - 备份内容由前端组装，不包含 WARP 私钥（见 src/backup.ts 的说明）。

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::State;

/// 备份上限：正常一份几十 KB，给到 8 MB 足够容错，也避免被塞进巨型文件。
const MAX_PAYLOAD: usize = 8 * 1024 * 1024;
const DEFAULT_TTL: u64 = 600;

#[derive(Default)]
pub struct ShareState {
    inner: Mutex<Option<Share>>,
}

struct Share {
    url: String,
    token: String,
    port: u16,
    ips: Vec<String>,
    expires_at: u64,
    bytes: usize,
    stop: Arc<AtomicBool>,
    hits: Arc<AtomicU64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareInfo {
    /// 二维码内容，形如 http://192.168.3.7:53211/p/<token>
    pub url: String,
    pub token: String,
    pub port: u16,
    /// 本机局域网地址；首项用于生成二维码，其余仅作展示
    pub ips: Vec<String>,
    /// 过期时间（Unix 秒）
    pub expires_at: u64,
    pub bytes: usize,
    /// 被访问次数（下载页 + JSON 都算）
    pub hits: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportInfo {
    pub path: String,
    pub size: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFile {
    pub name: String,
    pub path: String,
    pub size: u64,
    /// 修改时间（Unix 秒）
    pub modified: u64,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn random_token() -> Result<String, String> {
    let mut buf = [0u8; 16];
    getrandom::getrandom(&mut buf).map_err(|e| format!("随机数生成失败：{e}"))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// 探测本机在局域网里的地址。
/// 用 UDP connect 拿默认路由出口地址：UDP connect 不发包，只做路由选择，
/// 因此不需要任何外部依赖，也不会因为断网卡住。
fn lan_ips() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Ok(sock) = UdpSocket::bind("0.0.0.0:0") {
        if sock.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = sock.local_addr() {
                let ip = addr.ip();
                if !ip.is_loopback() && !ip.is_unspecified() {
                    out.push(ip.to_string());
                }
            }
        }
    }
    out
}

/// Unix 秒 → (年, 月, 日, 时, 分)，UTC。只为文件名好看，不引第三方日期库。
fn civil(secs: u64) -> (i64, u32, u32, u32, u32) {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, m) = ((rem / 3600) as u32, ((rem % 3600) / 60) as u32);
    // Howard Hinnant 的 civil_from_days
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as i64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let mth = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = if mth <= 2 { y + 1 } else { y };
    (year, mth, d, h, m)
}

fn stamp_compact() -> String {
    let (y, mo, d, h, mi) = civil(now_secs());
    format!("{y:04}{mo:02}{d:02}-{h:02}{mi:02}")
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

fn downloads_dir() -> Option<PathBuf> {
    let home = home_dir()?;
    let dl = home.join("Downloads");
    if dl.is_dir() {
        Some(dl)
    } else {
        Some(home)
    }
}

#[cfg(windows)]
fn hidden_cmd(program: impl AsRef<std::ffi::OsStr>) -> Command {
    use std::os::windows::process::CommandExt;
    let mut cmd = Command::new(program);
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd
}

#[cfg(not(windows))]
fn hidden_cmd(program: impl AsRef<std::ffi::OsStr>) -> Command {
    Command::new(program)
}

// ============ 局域网共享服务 ============

fn read_request(stream: &mut TcpStream) -> Option<String> {
    let mut data: Vec<u8> = Vec::new();
    let mut buf = [0u8; 1024];
    loop {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                data.extend_from_slice(&buf[..n]);
                if data.windows(4).any(|w| w == b"\r\n\r\n") || data.len() > 8192 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    String::from_utf8(data).ok()
}

fn respond(stream: &mut TcpStream, status: &str, ctype: &str, body: &str, extra: &str) {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\n{extra}Cache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.as_bytes().len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
}

fn page_html(bytes: usize, url: &str) -> String {
    let kb = format!("{:.1} KB", bytes as f64 / 1024.0);
    format!(
        r#"<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AnTun 配置备份</title>
<style>
:root{{color-scheme:light}}
*{{box-sizing:border-box}}
body{{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#f4f5f7;color:#17181a;font:15px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;padding:20px}}
.card{{width:100%;max-width:420px;background:#fff;border:1px solid #e3e5e9;border-radius:16px;
padding:24px;box-shadow:0 8px 28px rgba(17,19,23,.07)}}
h1{{margin:0 0 6px;font-size:19px}}
p{{margin:8px 0;color:#5b6069;font-size:13.5px}}
.meta{{display:flex;gap:14px;flex-wrap:wrap;font-size:12.5px;color:#8a8f98;margin:14px 0 18px}}
a.btn{{display:block;text-align:center;text-decoration:none;background:#2b6fff;color:#fff;
font-weight:600;padding:12px 16px;border-radius:10px}}
code{{display:block;word-break:break-all;background:#f4f5f7;border:1px solid #e3e5e9;border-radius:8px;
padding:9px 11px;font-size:12px;color:#3c4148;margin-top:6px}}
.tip{{margin-top:16px;font-size:12.5px;color:#8a8f98}}
</style></head><body>
<div class="card">
<h1>AnTun 配置备份</h1>
<p>这是另一台设备通过 AnTun「备份与同步」共享出来的配置快照。</p>
<div class="meta"><span>大小 {kb}</span><span>仅本次共享有效</span><span>局域网直连</span></div>
<a class="btn" href="{doc}">下载备份文件</a>
<p style="margin-top:18px">也可以把下面的地址粘贴到 AnTun → 设置 → 备份与同步 → 从链接导入：</p>
<code>{url}</code>
<div class="tip">链接包含一次性 token，别转发到公开渠道。传输只发生在局域网内，不经过服务器。</div>
</div></body></html>"#,
        kb = kb,
        url = url,
        doc = doc_path(url),
    )
}

/// 从分享 URL 推出 JSON 下载地址（URL 是 http://ip:port/p/<token>）。
fn doc_path(url: &str) -> String {
    url.trim_end_matches('/').to_string() + "/antun-backup.json"
}

fn handle_conn(mut stream: TcpStream, token: &str, payload: &str, url: &str, hits: &AtomicU64) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(15)));
    let req = read_request(&mut stream).unwrap_or_default();
    let raw = req
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .unwrap_or("/");
    let path = raw.split('?').next().unwrap_or("/").to_string();

    let root = format!("/p/{token}");
    let doc = format!("{root}/antun-backup.json");

    if path == doc {
        hits.fetch_add(1, Ordering::Relaxed);
        let name = format!("antun-backup-{}.json", stamp_compact());
        let extra = format!(
            "Content-Disposition: attachment; filename=\"{name}\"\r\nAccess-Control-Allow-Origin: *\r\n"
        );
        respond(&mut stream, "200 OK", "application/json; charset=utf-8", payload, &extra);
    } else if path == root || path == format!("{root}/") {
        hits.fetch_add(1, Ordering::Relaxed);
        let body = page_html(payload.len(), url);
        respond(&mut stream, "200 OK", "text/html; charset=utf-8", &body, "");
    } else {
        respond(
            &mut stream,
            "404 Not Found",
            "text/plain; charset=utf-8",
            "404 链接已失效，请在 AnTun 里重新生成二维码",
            "",
        );
    }
}

fn stop_share(state: &ShareState) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    if let Some(share) = guard.take() {
        share.stop.store(true, Ordering::Relaxed);
    }
    Ok(())
}

fn info_of(share: &Share) -> ShareInfo {
    ShareInfo {
        url: share.url.clone(),
        token: share.token.clone(),
        port: share.port,
        ips: share.ips.clone(),
        expires_at: share.expires_at,
        bytes: share.bytes,
        hits: share.hits.load(Ordering::Relaxed),
    }
}

#[tauri::command]
pub fn sync_share_start(
    state: State<'_, ShareState>,
    payload: String,
    ttl_secs: Option<u64>,
) -> Result<ShareInfo, String> {
    if payload.trim().is_empty() {
        return Err("备份内容为空".into());
    }
    if payload.len() > MAX_PAYLOAD {
        return Err("备份内容超过 8 MB，无法共享".into());
    }
    // 同一时刻只保留一个分享：重新生成二维码即替换旧的，避免残留监听
    stop_share(&state)?;

    let listener = TcpListener::bind(("0.0.0.0", 0u16))
        .map_err(|e| format!("局域网端口监听失败：{e}（可能被防火墙拦截）"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = random_token()?;
    let ips = lan_ips();
    let ip = ips.first().cloned().unwrap_or_else(|| "127.0.0.1".into());
    let ttl = ttl_secs.unwrap_or(DEFAULT_TTL).clamp(30, 3600);
    let expires_at = now_secs() + ttl;
    let url = format!("http://{ip}:{port}/p/{token}");

    let stop = Arc::new(AtomicBool::new(false));
    let hits = Arc::new(AtomicU64::new(0));
    let bytes = payload.len();
    let payload_arc = Arc::new(payload);

    {
        let stop = stop.clone();
        let hits = hits.clone();
        let token = token.clone();
        let url = url.clone();
        let payload = payload_arc.clone();
        // 到期或被手动停止后线程自行退出，listener 随之 drop，端口立刻释放
        std::thread::spawn(move || {
            let _ = listener.set_nonblocking(true);
            let deadline = Instant::now() + Duration::from_secs(ttl);
            while !stop.load(Ordering::Relaxed) && Instant::now() < deadline {
                match listener.accept() {
                    Ok((stream, _peer)) => {
                        // 单连接串行处理：备份只有几十 KB，没有必要并发
                        handle_conn(stream, &token, &payload, &url, &hits);
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(80));
                    }
                    Err(_) => break,
                }
            }
        });
    }

    let info = ShareInfo {
        url,
        token,
        port,
        ips,
        expires_at,
        bytes,
        hits: 0,
    };
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    *guard = Some(Share {
        url: info.url.clone(),
        token: info.token.clone(),
        port: info.port,
        ips: info.ips.clone(),
        expires_at: info.expires_at,
        bytes: info.bytes,
        stop,
        hits,
    });
    Ok(info)
}

#[tauri::command]
pub fn sync_share_stop(state: State<'_, ShareState>) -> Result<(), String> {
    stop_share(&state)
}

/// 前端用它刷新「已下载次数」与过期状态。
#[tauri::command]
pub fn sync_share_status(state: State<'_, ShareState>) -> Result<Option<ShareInfo>, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let Some(share) = guard.as_ref() else {
        return Ok(None);
    };
    let expired = now_secs() >= share.expires_at;
    if expired {
        if let Some(s) = guard.take() {
            s.stop.store(true, Ordering::Relaxed);
        }
        return Ok(None);
    }
    let info = info_of(share);
    Ok(Some(info))
}

// ============ 文件备份 ============

#[tauri::command]
pub fn backup_export(payload: String) -> Result<ExportInfo, String> {
    if payload.trim().is_empty() {
        return Err("备份内容为空".into());
    }
    let dir = downloads_dir().ok_or("找不到下载目录")?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败：{e}"))?;
    let path = dir.join(format!("antun-backup-{}.json", stamp_compact()));
    fs::write(&path, payload.as_bytes()).map_err(|e| format!("写入失败：{e}"))?;
    let size = fs::metadata(&path).map(|m| m.len() as usize).unwrap_or(0);
    Ok(ExportInfo {
        path: path.to_string_lossy().to_string(),
        size,
    })
}

/// 列出「下载」与「桌面」里最近的备份文件，供设置页直接点选导入，
/// 免去手输路径（应用没有文件选择器依赖）。
#[tauri::command]
pub fn backup_list() -> Vec<BackupFile> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(dl) = downloads_dir() {
        dirs.push(dl);
    }
    if let Some(home) = home_dir() {
        dirs.push(home.join("Desktop"));
        dirs.push(home.join("OneDrive").join("Desktop"));
    }
    let mut out: Vec<BackupFile> = Vec::new();
    for dir in dirs {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let lower = name.to_ascii_lowercase();
            if !lower.starts_with("antun-backup") || !lower.ends_with(".json") {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_file() || meta.len() > MAX_PAYLOAD as u64 {
                continue;
            }
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            out.push(BackupFile {
                name,
                path: path.to_string_lossy().to_string(),
                size: meta.len(),
                modified,
            });
        }
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    out.truncate(12);
    out
}

#[tauri::command]
pub fn backup_read(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    let lower = path.to_ascii_lowercase();
    if !lower.ends_with(".json") {
        return Err("只接受 .json 备份文件".into());
    }
    let meta = fs::metadata(&p).map_err(|e| format!("文件不可读：{e}"))?;
    if meta.len() as usize > MAX_PAYLOAD {
        return Err("文件超过 8 MB，不是 AnTun 备份".into());
    }
    fs::read_to_string(&p).map_err(|e| format!("读取失败：{e}"))
}

/// 在资源管理器里定位文件。
#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        let _ = hidden_cmd("explorer.exe").arg(format!("/select,{path}")).spawn();
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = &path;
        Err("当前平台未实现".into())
    }
}

/// 从局域网链接拉取备份。
/// 必须显式 --noproxy：共享端就在同网段，走系统代理会绕一大圈甚至直接失败。
///
/// 二维码里编的是「给人看的下载页」，直接 GET 会拿到 HTML。所以只要链接不是 .json，
/// 就先试着拼上 /antun-backup.json；拼不出 JSON 再回退原始地址
/// （对端可能是个直接吐 JSON 的简单服务）。
#[tauri::command]
pub fn sync_fetch_url(url: String) -> Result<String, String> {
    let lower = url.to_ascii_lowercase();
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return Err("链接需以 http:// 或 https:// 开头".into());
    }
    let base = url.trim().trim_end_matches('/').to_string();
    let mut candidates: Vec<String> = Vec::new();
    if !base.to_ascii_lowercase().ends_with(".json") {
        candidates.push(format!("{base}/antun-backup.json"));
    }
    candidates.push(base);

    let mut last_err = String::from("对端没有返回可用的备份内容");
    for target in candidates {
        match curl_text(&target) {
            Ok(text) => {
                if text.trim_start().starts_with('{') {
                    return Ok(text);
                }
                last_err = format!("{target} 返回的不是备份 JSON");
            }
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}

fn curl_text(url: &str) -> Result<String, String> {
    let out = hidden_cmd("curl.exe")
        .args([
            "-sSfL",
            "--noproxy",
            "*",
            "--max-time",
            "20",
            "--max-filesize",
            "8388608",
            "-A",
            "AnTun-Sync/1",
            url,
        ])
        .output()
        .map_err(|e| format!("调用 curl 失败：{e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("拉取失败：{}", err.trim()));
    }
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    if text.trim().is_empty() {
        return Err("对端返回了空内容".into());
    }
    Ok(text)
}
