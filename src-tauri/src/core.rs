//! AnTun 真实连接核心管理
//!
//! 设计原则：
//! 1. 安装包不含 mihomo 二进制（保持轻量），首次连接时按需从镜像下载到用户数据目录
//! 2. 所有"已连接"状态必须基于真实出口探测（HTTP 请求经本地代理拿到公网 IP）
//! 3. 任何失败都如实返回错误，绝不返回伪造的出口 IP / 延迟

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
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

/// TUN 虚拟网卡名。固定成 ASCII 名字，才能在 `netsh interface show interface`
/// 的输出里稳定找到它（系统自带的其它网卡名都是本地化的，不可靠）。
const TUN_DEVICE: &str = "AnTun";

#[derive(Default)]
pub struct CoreState {
    child: Mutex<Option<Child>>,
    /// Windows Job 对象句柄：句柄随进程退出自动关闭，内核子进程被系统一起结束，
    /// 避免主程序被强杀后残留 mihomo 占着 7890/9090，导致下次连接起不来。
    job: Mutex<Option<isize>>,
    /// 取消标志：点「取消连接」时置真。连接链路的每个阻塞点在下一轮轮询里
    /// 看到它就以「已取消」退出，而不是硬等 Psiphon 重试与出口探测跑完。
    cancel: AtomicBool,
}

/// 取消信号：连接链路（含 Psiphon 子模块）统一读这一个标志。
pub(crate) fn cancel_flag(state: &CoreState) -> &AtomicBool {
    &state.cancel
}

/// 是否已被取消。拿不到 State 时按未取消处理，避免误伤正常连接。
fn is_cancelled(app: &AppHandle) -> bool {
    app.state::<CoreState>().cancel.load(Ordering::SeqCst)
}

/// 用户主动取消连接时统一使用的错误文本：前端据此判定「不是失败，是被取消」。
pub(crate) const CANCELLED: &str = "已取消连接";

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
    /// 凭证来源：user（用户导入）/ auto（本机自动注册）/ 空（内置共享）
    pub source: String,
}

const MASQUE_SERVER: &str = "162.159.198.1";
const MASQUE_SNI: &str = "consumer-masque.cloudflareclient.com";
const MASQUE_PORT: u16 = 500;

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct CoreResult {
    pub ok: bool,
    pub exit_ip: String,
    pub country: String,
    pub city: String,
    pub colo: String,
    pub latency: u32,
    pub error: String,
    /// 致命错误（核心进程已退出等），前端据此立即断开而不是继续重试
    #[serde(default)]
    pub fatal: bool,
    /// 本次连接实际使用的凭证来源：user / auto / builtin
    #[serde(default)]
    pub credential_source: String,
    /// 是否发生了"凭证失败 → 回退内置凭证"的自动降级
    #[serde(default)]
    pub fallback: bool,
    /// 降级前那次失败的原因（便于用户在日志里看到根因）
    #[serde(default)]
    pub fallback_reason: String,
    /// 本次连接实际写入配置的出口端点（用于核对"择优/锁定"是否真的生效）
    #[serde(default)]
    pub endpoint_host: String,
    #[serde(default)]
    pub endpoint_port: u16,
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
            ..Default::default()
        }
    }

    fn fail_fatal(msg: impl Into<String>) -> Self {
        let mut r = Self::fail(msg);
        r.fatal = true;
        r
    }
}

/// Windows 下所有子进程都隐藏控制台窗口：
/// mihomo / curl / powershell 都是控制台程序，直接 Command::new 会闪出黑框。
pub(crate) fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd
}

/// 核心链路专用：在隐藏窗口之外，还要剥掉外部代理软件写进环境的
/// HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY 等变量。
/// 这些变量会污染 mihomo 的 DoH、出口探测的 curl、Psiphon 与节点测速，
/// 表现为「同样的配置有时连得上、有时连不上」。核心一律用显式参数，不继承系统代理。
/// 注意：下载 mihomo 核心 / 更新包这类命令不要用这个函数——它们可能需要系统代理才能出网，
/// 应继续用 hidden_command。core_update.rs 自带独立的 hidden_command，不受影响。
pub(crate) fn proxy_free_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = hidden_command(program);
    for k in [
        "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
        "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    ] {
        cmd.env_remove(k);
    }
    cmd
}

pub(crate) fn app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {}", e))
}

fn core_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_dir(app)?.join("mihomo.exe"))
}

pub(crate) fn cred_path(app: &AppHandle) -> Result<PathBuf, String> {
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

// ============ TUN 全局模式 ============

/// 当前进程是否以管理员身份运行。
///
/// TUN 要建 wintun 适配器、改路由表，非提权运行时 mihomo 会静默失败，所以连接前先问一次。
#[cfg(windows)]
pub fn is_elevated() -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return false;
        }
        let mut elevation: TOKEN_ELEVATION = std::mem::zeroed();
        let mut ret_len = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            &mut elevation as *mut _ as *mut std::ffi::c_void,
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut ret_len,
        );
        CloseHandle(token);
        ok != 0 && elevation.TokenIsElevated != 0
    }
}

#[cfg(not(windows))]
pub fn is_elevated() -> bool {
    true
}

/// TUN 网卡是否真的建立起来了。
///
/// 不能用「核心进程还活着」代替：非提权时 mihomo 只打一行
/// `Start TUN listening error: Access is denied.`，混合端口照常监听，
/// 于是出口探测（走 127.0.0.1 代理）依然成功 —— 用户会以为全局模式生效了，
/// 实际上整机流量一点没进隧道。必须看网卡本身。
#[cfg(windows)]
fn tun_adapter_up() -> bool {
    let out = match proxy_free_command("netsh")
        .args(["interface", "show", "interface"])
        .output()
    {
        Ok(o) => o,
        Err(_) => return false,
    };
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines().any(|line| {
        line.contains(TUN_DEVICE)
            && (line.contains("Connected") || line.contains("已连接") || line.contains("已启用"))
    })
}

#[cfg(not(windows))]
fn tun_adapter_up() -> bool {
    false
}

/// 等 TUN 网卡起来（mihomo 建适配器 + 下发路由通常 1~3 秒）
fn wait_tun_adapter(timeout: Duration) -> bool {
    let started = std::time::Instant::now();
    while started.elapsed() < timeout {
        if tun_adapter_up() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    tun_adapter_up()
}

/// 确保 mihomo 找得到 wintun.dll。
///
/// mihomo 自己不内置这个驱动，运行时按「exe 所在目录 → 系统目录 → PATH」找 DLL。
/// AnTun 不重打包 wintun（GPLv2 二进制，不随 MIT 项目分发），而是复用本机已有副本：
/// 装了 Cloudflare WARP / WireGuard 的机器上一定有，复制一份到核心目录即可。
fn ensure_wintun(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_dir(app)?;
    let dst = dir.join("wintun.dll");
    if dst.exists() {
        return Ok(dst);
    }
    #[cfg(windows)]
    {
        let mut candidates: Vec<PathBuf> = Vec::new();
        for var in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
            if let Ok(base) = std::env::var(var) {
                candidates.push(PathBuf::from(&base).join("Cloudflare").join("Cloudflare WARP").join("wintun.dll"));
                candidates.push(PathBuf::from(&base).join("WireGuard").join("wintun.dll"));
            }
        }
        if let Ok(sys) = std::env::var("SystemRoot") {
            candidates.push(PathBuf::from(sys).join("System32").join("wintun.dll"));
        }
        for src in candidates {
            if src.exists() {
                std::fs::copy(&src, &dst).map_err(|e| format!("复制 wintun.dll 失败: {}", e))?;
                return Ok(dst);
            }
        }
    }
    Err("TUN 需要 wintun.dll 驱动：本机没有找到（装了 Cloudflare WARP 或 WireGuard 的机器会自带）。请安装其一，或把 wintun.dll 放到数据目录后重试。".into())
}

/// 提权重启时新实例带的标记参数：告诉新进程「你是被旧实例提权拉起来的」。
const RELAUNCH_ARG: &str = "--elevated-relaunch";
/// 新实例要等待退出的旧进程 pid。
const RELAUNCH_WAIT_ARG: &str = "--elevated-wait-pid=";

/// 启动阶段的诊断日志。
///
/// 提权重启的进程是 ShellExecuteW 拉起的独立进程，没有控制台，stderr 无处可看；
/// 出问题时只能靠这个文件回溯（`%APPDATA%\com.antun.client\relaunch.log`）。
pub fn boot_log(msg: &str) {
    let Some(dir) = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .map(|p| p.join("com.antun.client"))
    else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join("relaunch.log");
    // 只保留最近的一段：超过 64 KB 就清空重写，避免长期使用后无限增长
    if std::fs::metadata(&path).map(|m| m.len() > 64 * 1024).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path)
    {
        use std::io::Write;
        let _ = writeln!(f, "[{}] {}", ms, msg);
    }
}

/// 把 panic 也写进启动日志，避免面板进程崩溃后完全无迹可查。
pub fn install_panic_log() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        boot_log(&format!("PANIC {}", info));
        default_hook(info);
    }));
}

/// 本次启动是否由「以管理员身份重启」发起，并返回需要等待退出的旧进程 pid。
///
/// 旧实例在 ShellExecuteW 返回后才退出，而新实例可能已经起来了：如果不先等旧进程
/// 真正结束，新实例会撞上单实例插件被判定为二次启动直接退掉，旧实例随后也退出，
/// 结果一个进程都不剩（表现为「点了以管理员身份重启，应用没起来」）。
pub fn pending_relaunch_pid() -> Option<u32> {
    std::env::args()
        .find_map(|a| a.strip_prefix(RELAUNCH_WAIT_ARG).and_then(|v| v.parse::<u32>().ok()))
}

/// 等待指定进程退出，最多 `timeout`。用于提权重启时等旧实例释放单实例锁与 WebView2 数据目录。
pub fn wait_for_process_exit(pid: u32, timeout: std::time::Duration) {
    let started = std::time::Instant::now();
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::{
            CloseHandle, GetLastError, WAIT_OBJECT_0, WAIT_TIMEOUT,
        };
        use windows_sys::Win32::System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
        };
        const WAIT_FAILED: u32 = 4294967295;
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            boot_log(&format!(
                "wait pid={} OpenProcess failed err={}",
                pid,
                GetLastError()
            ));
            return;
        }
        let rc = WaitForSingleObject(handle, timeout.as_millis() as u32);
        boot_log(&format!(
            "wait pid={} rc={}{} elapsed={}ms",
            pid,
            rc,
            if rc == WAIT_OBJECT_0 {
                " (exited)"
            } else if rc == WAIT_TIMEOUT {
                " (timeout)"
            } else if rc == WAIT_FAILED {
                " (failed)"
            } else {
                ""
            },
            started.elapsed().as_millis()
        ));
        CloseHandle(handle);
    }
    #[cfg(not(windows))]
    {
        let _ = (pid, timeout);
    }
}

/// 以管理员身份重启本应用。
///
/// TUN 模式必须提权才能建虚拟网卡。用 ShellExecuteW 的 runas 动词拉起同一份 exe，
/// 并把当前 pid 一起传过去：新实例启动时会先等旧进程退出，再继续初始化。
/// 如果用户取消了 UAC，ShellExecuteW 返回错误码，此时保持当前实例运行。
#[tauri::command]
pub fn relaunch_elevated(app: AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let exe = std::env::current_exe().map_err(|e| format!("定位程序: {}", e))?;
        let verb: Vec<u16> = "runas\0".encode_utf16().collect();
        let file: Vec<u16> = exe.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let params: Vec<u16> = format!("{} {}{}", RELAUNCH_ARG, RELAUNCH_WAIT_ARG, std::process::id())
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let rc = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                file.as_ptr(),
                params.as_ptr(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        if (rc as isize) <= 32 {
            return Err(format!("提权启动被拒绝（错误码 {}）", rc as isize));
        }
        app.exit(0);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("仅 Windows 支持以管理员身份重启".into())
    }
}

/// 是否是「以管理员身份重启」拉起来的新实例（此时不注册单实例插件）。
pub fn is_elevated_relaunch() -> bool {
    std::env::args().any(|a| a == RELAUNCH_ARG)
}

#[tauri::command]
pub fn elevated_status() -> bool {
    is_elevated()
}

/// 上次异常退出留下的代理快照：启动时自动还原，避免指向已死掉的本地端口。
pub fn restore_orphan_proxy(app: &AppHandle) {
    if proxy_snapshot_path(app).map(|p| p.exists()).unwrap_or(false) {
        let _ = restore_system_proxy(app);
    }
}

/// 统一停止核心子进程。
fn stop_child(state: &CoreState) {
    if let Ok(mut guard) = state.child.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    close_job(state);
}

/// 把核心进程放进「随主进程一起结束」的 Job 对象。
///
/// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`：最后一个句柄关闭时（含主程序被强杀、
/// 崩溃、任务管理器结束进程）系统会一并结束子进程，不留孤儿核心。
/// 失败时静默降级为普通子进程，不影响连接。
#[cfg(windows)]
pub(crate) fn bind_child_to_job(child: &Child) -> Option<isize> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return None;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let set = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if set == 0 {
            let _ = CloseHandle(job);
            return None;
        }
        let handle = child.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE;
        if AssignProcessToJobObject(job, handle) == 0 {
            let _ = CloseHandle(job);
            return None;
        }
        Some(job as isize)
    }
}

#[cfg(not(windows))]
pub(crate) fn bind_child_to_job(_child: &Child) -> Option<isize> {
    None
}

/// 关闭 Job 句柄：KILL_ON_JOB_CLOSE 生效，句柄所属的子进程会被系统结束。
pub(crate) fn close_job_handle(handle: isize) {
    #[cfg(windows)]
    unsafe {
        let _ = windows_sys::Win32::Foundation::CloseHandle(
            handle as windows_sys::Win32::Foundation::HANDLE,
        );
    }
    #[cfg(not(windows))]
    let _ = handle;
}

fn close_job(state: &CoreState) {
    if let Ok(mut guard) = state.job.lock() {
        if let Some(handle) = guard.take() {
            close_job_handle(handle);
        }
    }
}

/// 供内核更新命令判断是否有正在运行的隧道，避免替换被占用的 exe。
pub fn is_running(state: &tauri::State<'_, CoreState>) -> bool {
    state.child.lock().map(|guard| guard.is_some()).unwrap_or(false)
}

/// 查找随安装包内置的资源文件（兼容 resources/ 子目录与根目录两种布局）
pub(crate) fn bundled_resource_path(app: &AppHandle, name: &str) -> Option<PathBuf> {
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
        if let Some(src) = bundled_resource_path(app, name) {
            let _ = std::fs::copy(src, dest);
        }
    }
}

/// 取得 mihomo 核心：优先用安装包内置文件，缺失时才走网络下载。
pub(crate) fn download_core(app: &AppHandle) -> Result<PathBuf, String> {
    let dest = core_path(app)?;
    if dest.exists() {
        return Ok(dest);
    }
    let dir = app_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create dir: {}", e))?;

    if let Some(src) = bundled_resource_path(app, "mihomo.exe") {
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

/// 构建 DNS 段。
/// preset 使用 IP 形式的 DoH（无需本地引导解析），配合 respect-rules 让解析走隧道；
/// guard 开启 fake-ip，浏览器只把域名交给核心，避免系统 DNS 明文外泄。
fn render_dns(dns_mode: &str, dns_custom: &str, guard: bool, ipv6: bool) -> String {
    if dns_mode == "off" {
        return String::new();
    }
    let mut servers: Vec<String> = if dns_mode == "custom" {
        dns_custom
            .split(|c| c == ',' || c == '\n' || c == '\r' || c == ' ' || c == ';')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    } else {
        vec![
            "https://1.1.1.1/dns-query".to_string(),
            "https://8.8.8.8/dns-query".to_string(),
        ]
    };
    if servers.is_empty() {
        servers.push("https://1.1.1.1/dns-query".to_string());
    }

    let mut s = String::from("dns:\n  enable: true\n");
    s.push_str(&format!("  ipv6: {}\n", ipv6));
    s.push_str("  respect-rules: true\n");
    s.push_str("  default-nameserver:\n    - 1.1.1.1\n    - 8.8.8.8\n");
    s.push_str("  proxy-server-nameserver:\n    - 8.8.8.8\n    - 1.1.1.1\n");
    if guard {
        s.push_str(
            "  enhanced-mode: fake-ip\n  fake-ip-range: 198.18.0.1/16\n  fake-ip-filter:\n    - '*.lan'\n    - '*.local'\n    - '+.msftconnecttest.com'\n    - '+.msftncsi.com'\n    - 'localhost.ptlogin2.qq.com'\n",
        );
    }
    s.push_str("  nameserver:\n");
    for d in servers {
        s.push_str(&format!("    - {}\n", d));
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
    dns_mode: &str,
    dns_custom: &str,
    dns_guard: bool,
    ip_family: &str,
    sub_exit: &str,
    sub_via_warp: bool,
    psiphon_socks_port: Option<u16>,
    capture_mode: &str,
    ad_block: bool,
) -> String {
    let effective_mtu = if mtu > 0 { mtu } else { 1280 };
    let allow_lan_str = if allow_lan { "true" } else { "false" };
    let ipv6 = ip_family != "v4";
    let dns_block = render_dns(dns_mode, dns_custom, dns_guard, ipv6);
    let dns_rules = if dns_block.is_empty() {
        String::new()
    } else {
        // 解析器流量跟随隧道（与 1.7.1 一致）。
        // 1.7.8 中途曾把 1.1.1.1 / 8.8.8.8 强制 DIRECT 以避免「DNS 自举死锁」，
        // 但在 1.1.1.1 被封锁的网络里，DoH 直连必然超时：即使 WG 隧道已经建立，
        // 也解析不了 www.cloudflare.com 去做 trace，最终被误判成「隧道未建立」。
        // 2026-11-28 本机实测：1.1.1.1 / 8.8.8.8 的 UDP 与 DoH 均不可达，
        // 而 1.7.1（解析器走隧道）可正常连接。握手走 IP 端点、不依赖 DNS，
        // 隧道起来后 PROXY DNS 即可用，不存在真正的死锁。
        String::new()
    };
    // 订阅节点作为最终出口时，WARP 只作为前置（可选）
    let node_exit = front_config.is_some() && sub_exit == "node";
    // 订阅模式的节点固定命名为 SUB-NODE：WARP 出口时作为最外层 dialer-proxy，节点出口时即最终出站
    let front_name = front_config.filter(|_| !node_exit).map(|_| "SUB-NODE");
    let (mut proxies, mut outbound) = match protocol {
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
        if node_exit {
            // 节点作为最终出口：SUB-NODE 直接出站，可选让 WARP 承载节点流量
            let mut node_cfg = front.trim_end().to_string();
            if sub_via_warp {
                node_cfg.push_str("\n    dialer-proxy: \"WARP\"");
            }
            node_cfg.push('\n');
            proxies = format!("{}{}", proxies, node_cfg);
            outbound = "SUB-NODE";
        } else {
            proxies = format!("{}\n{}", front.trim_end(), proxies);
        }
    }

    // Psiphon 出口：最终出站指向它的本地 SOCKS。
    // 此时 WARP/节点仍留在 proxies 里，但没有任何组引用它们，因此不会真的建链。
    if let Some(sp) = psiphon_socks_port {
        if !proxies.ends_with('\n') {
            proxies.push('\n');
        }
        proxies.push_str(&format!(
            "  - {{ name: PSIPHON, type: socks5, server: 127.0.0.1, port: {sp}, udp: false }}\n"
        ));
        outbound = "PSIPHON";
    }

    // TUN 全局模式：整机流量经虚拟网卡进核心，不受「应用是否遵守系统代理」影响。
    //
    // 两个必须注意的点：
    // 1. 建 wintun 适配器、改路由表都要管理员权限。非提权时 mihomo 只会打一行
    //    `Start TUN listening error: Access is denied.` 然后继续提供混合端口 ——
    //    表面上"连上了"，实际没有任何流量进隧道。所以 attempt_connect 会真实检测
    //    网卡是否建立（见 tun_adapter_up），起不来就直接判失败，不做静默降级。
    // 2. dns 关闭时不劫持 53：否则所有查询都被塞进一个停用的解析器，等于把 DNS 掐死。
    let tun_block = if capture_mode == "tun" {
        let hijack = if dns_block.is_empty() {
            String::new()
        } else {
            String::from("  dns-hijack:\n    - any:53\n")
        };
        format!(
            "tun:\n  enable: true\n  device: {TUN_DEVICE}\n  stack: gvisor\n  auto-route: true\n  auto-detect-interface: true\n{hijack}"
        )
    } else {
        String::new()
    };

    // 广告拦截：域名级 REJECT，放在 MATCH 之前，与分流模式无关（proxy / tun 都生效）。
    // 清单在 adblock.rs，静态内置，不依赖远程规则集。
    let ad_rules = if ad_block {
        crate::adblock::rules()
    } else {
        String::new()
    };

    format!(
        r#"# AnTun 自动生成的配置（请勿手动修改）· protocol={protocol}
mixed-port: {port}
bind-address: 127.0.0.1
allow-lan: {allow_lan_str}
mode: rule
log-level: info
ipv6: {ipv6}
external-controller: 127.0.0.1:{api_port}
tcp-concurrent: true
unified-delay: true
# 首页「连接设备」要显示是哪个应用在走 VPN：进程信息只在这项打开后才随
# /connections 的 metadata.processPath 返回（默认的 strict 模式下系统代理进来的
# 连接拿不到 PID）。always 只多一次本地 socket 归属查询，开销可忽略。
find-process-mode: always

{dns_block}
proxies:
{proxies}
proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - {outbound}

rules:
{dns_rules}  - IP-CIDR,10.0.0.0/8,DIRECT,no-resolve
  - IP-CIDR,172.16.0.0/12,DIRECT,no-resolve
  - IP-CIDR,192.168.0.0/16,DIRECT,no-resolve
  - IP-CIDR,100.64.0.0/10,DIRECT,no-resolve
  - IP-CIDR,127.0.0.0/8,DIRECT,no-resolve
  - DOMAIN-SUFFIX,local,DIRECT
{ad_rules}  - MATCH,PROXY
{tun_block}"#,
        protocol = protocol,
        port = port,
        api_port = api_port,
        ipv6 = ipv6,
        dns_block = dns_block,
        dns_rules = dns_rules,
        proxies = proxies,
        outbound = outbound,
        allow_lan_str = allow_lan_str,
        tun_block = tun_block,
        ad_rules = ad_rules,
    )
}

/// 取消正在进行的连接
///
/// 连接链路里最长的两段是「Psiphon 建隧道」和「出口探测」，都只能靠轮询等待。
/// 光置标志不够——正在等的那一轮还得等它自己超时，所以这里同时把两条阻塞源掐掉：
/// Psiphon 子进程一死，它的等待循环立刻返回；核心一停，出口探测的 curl 立刻连接失败。
/// 两者都会让 attempt_connect 在几百毫秒内走到下一个检查点并返回「已取消连接」。
#[tauri::command]
pub fn core_cancel_connect(app: AppHandle) {
    app.state::<CoreState>().cancel.store(true, Ordering::SeqCst);
    crate::psiphon::stop(&app);
    stop_child(app.state::<CoreState>().inner());
    let _ = restore_system_proxy(&app);
}

/// 停止核心进程
#[tauri::command]
pub fn core_stop(app: AppHandle, state: tauri::State<'_, CoreState>) -> Result<(), String> {
    stop_child(state.inner());
    // Psiphon 出口和核心同生命周期：断开连接必须一并结束，否则它会继续占着端口和网络
    crate::psiphon::stop(&app);
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

/// 直接从核心 REST API 读第一行 /traffic（NDJSON 流），读到就断开。
///
/// 之前这里用 `curl.exe -s --max-time 2 /traffic`：该接口是**长连接流**，
/// curl 会一直等到 2 秒超时才退出；而同步的 `#[tauri::command]` 跑在主线程上，
/// 于是连接后每秒都把窗口消息循环堵住约 2 秒 —— 表现就是点菜单、拖动窗口明显卡顿。
/// 改成直连 127.0.0.1 读一行就返回，通常 1～5ms。
fn read_traffic_line(api_port: u16) -> Result<String, String> {
    use std::io::{BufRead, BufReader, Write as IoWrite};
    use std::net::{SocketAddr, TcpStream};

    let addr = SocketAddr::from(([127, 0, 0, 1], api_port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(600))
        .map_err(|_| "核心流量接口不可用".to_string())?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(600)));
    let req = format!(
        "GET /traffic HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
        api_port
    );
    stream
        .write_all(req.as_bytes())
        .map_err(|e| format!("读取流量失败: {}", e))?;

    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    let mut in_body = false;
    loop {
        line.clear();
        let n = reader
            .read_line(&mut line)
            .map_err(|e| format!("读取流量失败: {}", e))?;
        if n == 0 {
            break;
        }
        let text = line.trim();
        if !in_body {
            // 跳过响应头（chunked 编码下正文前还会有一行长度）
            if text.is_empty() {
                in_body = true;
            }
            continue;
        }
        if text.starts_with('{') {
            return Ok(text.to_string());
        }
    }
    Err("核心流量接口不可用".into())
}

/// 读取核心 REST API 的流量快照。
///
/// 命令本身是 async 且把阻塞 IO 放进 spawn_blocking：
/// 绝不能让它在主线程上等网络，否则连接期间窗口会周期性卡死。
#[tauri::command]
pub async fn core_traffic(api_port: u16) -> Result<CoreTraffic, String> {
    let line = tauri::async_runtime::spawn_blocking(move || read_traffic_line(api_port))
        .await
        .map_err(|e| format!("读取流量失败: {}", e))??;
    let value: serde_json::Value =
        serde_json::from_str(&line).map_err(|e| format!("流量数据解析失败: {}", e))?;
    Ok(CoreTraffic {
        up: value.get("up").and_then(|v| v.as_u64()).unwrap_or(0),
        down: value.get("down").and_then(|v| v.as_u64()).unwrap_or(0),
        up_total: value.get("upTotal").and_then(|v| v.as_u64()).unwrap_or(0),
        down_total: value.get("downTotal").and_then(|v| v.as_u64()).unwrap_or(0),
    })
}

/// 单条连接（把核心 /connections 的原始结构投影成界面要用的字段）
///
/// 只保留「谁在连、连到哪、走了哪条规则和节点、用了多少流量」，
/// 原始结构里还有 dscp、sniffHost 等几十个字段，全量传给前端既慢又没必要。
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct CoreConn {
    pub id: String,
    /// 目标域名；没有域名时退回目标 IP
    pub host: String,
    pub port: String,
    pub network: String,
    /// 进程名（取 processPath 的文件名部分，例如 chrome.exe）
    pub process: String,
    pub rule: String,
    /// 命中的出口（chain 的最后一段），例如 WARP / 节点名
    pub chain: String,
    pub upload: u64,
    pub download: u64,
    pub start: String,
    pub source_ip: String,
}

/// 当前所有经过核心转发的连接 + 会话累计流量
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct CoreConns {
    pub connections: Vec<CoreConn>,
    pub upload_total: u64,
    pub download_total: u64,
}

/// 读满缓冲区：返回实际读到的字节数。
///
/// 这里不能用 read_exact —— 核心把 JSON 一次性写完后立刻关连接，
/// 而 read_exact 在超时/提前关闭时会丢掉已经读到的部分，导致整段 JSON 解析失败。
fn read_full<R: std::io::Read>(reader: &mut R, buf: &mut [u8]) -> usize {
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(_) => break,
        }
    }
    filled
}

/// 从核心 REST API 读一个完整 JSON 响应体。
///
/// 与 `/traffic`（NDJSON 长流，读一行就够）不同，`/connections` 是一次性完整对象：
/// Go 的 http 服务在没有 Content-Length 时用 chunked 编码，若直接 read_to_end，
/// 块长度行会混进正文让 serde 解析失败；所以这里按响应头分别处理两种编码。
fn read_api_json(api_port: u16, path: &str) -> Result<String, String> {
    use std::io::{BufRead, BufReader, Read, Write as IoWrite};
    use std::net::{SocketAddr, TcpStream};

    let addr = SocketAddr::from(([127, 0, 0, 1], api_port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(600))
        .map_err(|_| "核心接口不可用".to_string())?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(2500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(600)));
    let req = format!(
        "GET {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
        path, api_port
    );
    stream
        .write_all(req.as_bytes())
        .map_err(|e| format!("读取核心接口失败: {}", e))?;

    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    let mut chunked = false;
    let mut content_length: Option<usize> = None;
    loop {
        line.clear();
        let n = reader
            .read_line(&mut line)
            .map_err(|e| format!("读取核心接口失败: {}", e))?;
        if n == 0 {
            return Err("核心接口无响应".into());
        }
        let text = line.trim_end();
        if text.is_empty() {
            break;
        }
        let lower = text.to_ascii_lowercase();
        if let Some(v) = lower.strip_prefix("transfer-encoding:") {
            chunked = v.contains("chunked");
        } else if let Some(v) = lower.strip_prefix("content-length:") {
            content_length = v.trim().parse::<usize>().ok();
        }
    }

    let mut body: Vec<u8> = Vec::new();
    if chunked {
        loop {
            line.clear();
            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                break;
            }
            let size_text = line.trim().split(';').next().unwrap_or("");
            let size = usize::from_str_radix(size_text, 16).unwrap_or(0);
            if size == 0 {
                break;
            }
            let mut buf = vec![0u8; size];
            let read = read_full(&mut reader, &mut buf);
            body.extend_from_slice(&buf[..read]);
            if read < size {
                break;
            }
            // 吃掉块尾 CRLF
            let mut crlf = [0u8; 2];
            let _ = read_full(&mut reader, &mut crlf);
        }
    } else if let Some(len) = content_length {
        let mut buf = vec![0u8; len];
        let read = read_full(&mut reader, &mut buf);
        body.extend_from_slice(&buf[..read]);
    } else {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => body.extend_from_slice(&buf[..n]),
                Err(_) => break,
            }
        }
    }

    String::from_utf8(body).map_err(|e| format!("核心接口编码错误: {}", e))
}

/// 读取当前经过隧道的连接列表（首页「连接设备」）。
///
/// 和 core_traffic 一样是 async + spawn_blocking：这条请求要等核心把整个
/// 连接数组写完，放主线程会周期性卡住窗口。
#[tauri::command]
pub async fn core_connections(api_port: u16) -> Result<CoreConns, String> {
    let body = tauri::async_runtime::spawn_blocking(move || read_api_json(api_port, "/connections"))
        .await
        .map_err(|e| format!("读取连接失败: {}", e))??;
    let value: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("连接数据解析失败: {}", e))?;

    let text = |v: &serde_json::Value, key: &str| -> String {
        v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
    };

    let mut list: Vec<CoreConn> = Vec::new();
    if let Some(items) = value.get("connections").and_then(|v| v.as_array()) {
        for item in items {
            let meta = item.get("metadata").cloned().unwrap_or(serde_json::Value::Null);
            // 优先域名，其次 sniff 出来的域名，最后退回目标 IP
            let mut host = text(&meta, "host");
            if host.is_empty() {
                host = text(&meta, "sniffHost");
            }
            if host.is_empty() {
                host = text(&meta, "destinationIP");
            }
            // processPath 是完整路径，界面只显示进程名
            let path = text(&meta, "processPath");
            let process = path.rsplit(&['\\', '/'][..]).next().unwrap_or("").to_string();
            let rule_name = text(item, "rule");
            let rule_payload = text(item, "rulePayload");
            let rule = if rule_payload.is_empty() {
                rule_name
            } else if rule_name.is_empty() {
                rule_payload
            } else {
                format!("{}({})", rule_name, rule_payload)
            };
            let chain = item
                .get("chains")
                .and_then(|v| v.as_array())
                .and_then(|a| a.last())
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            list.push(CoreConn {
                id: text(item, "id"),
                host,
                port: text(&meta, "destinationPort"),
                network: text(&meta, "network"),
                process,
                rule,
                chain,
                upload: item.get("upload").and_then(|v| v.as_u64()).unwrap_or(0),
                download: item.get("download").and_then(|v| v.as_u64()).unwrap_or(0),
                start: text(item, "start"),
                source_ip: text(&meta, "sourceIP"),
            });
        }
    }
    // 流量大的排前面：用户最关心的是「谁在占带宽」
    list.sort_by(|a, b| (b.upload + b.download).cmp(&(a.upload + a.download)));

    Ok(CoreConns {
        connections: list,
        upload_total: value.get("uploadTotal").and_then(|v| v.as_u64()).unwrap_or(0),
        download_total: value.get("downloadTotal").and_then(|v| v.as_u64()).unwrap_or(0),
    })
}

/// 保存 WARP 凭证
#[tauri::command]
pub fn save_credential(app: AppHandle, cred: WarpCredential) -> Result<(), String> {
    let mut cred = cred;
    // 用户手动导入 = 自备身份，后续不会被自动注册覆盖
    cred.source = "user".into();
    let path = cred_path(&app)?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(path, serde_json::to_string_pretty(&cred).map_err(|e| e.to_string())?)
        .map_err(|e| format!("保存凭证: {}", e))
}

/// 内置默认凭证：来自公开 WARP 注册端点生成的免费账户，经本机实测可建立隧道。
/// 作用：新用户安装后无需任何配置即可连接；用户导入自己的凭证后会覆盖它。
pub(crate) const BUILTIN_OUTER_KEY: &str = "AO9FFXpvI2abd29iiuIskLoRg3nkT3j1VGs1M/1cj3s=";
pub(crate) const BUILTIN_WARP_PEER: &str = "bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=";
pub(crate) const BUILTIN_INNER_KEY: &str = "4FC385+GIJMWmOwT9e8NcD6WozjEyZePpV2uxhVE3k0=";
pub(crate) const BUILTIN_INNER_HOST: &str = "8.34.70.19";
pub(crate) const BUILTIN_MASQUE_KEY: &str = "MHcCAQEEIOiNkR2CFenP3pkGT6gKbMXdWSEA95DclNVCKs3wP089oAoGCCqGSM49AwEHoUQDQgAEqSoE25D8CGO4Wyb5NdDx0/t+2mPRZN0QALyEsMI4a17HXxzu4Lt4+bB0PsCNeQGAWAvGYpQ/G6Elqn7XCGiZow==";
pub(crate) const BUILTIN_MASQUE_PEER: &str = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEIaU7MToJm9NKp8YfGxR6r+/h4mcG7SxI8tsW8OR1A5tv/zCzVbCRRh2t87/kxnP6lAy0lkr7qYwu+ox+k3dr6w==";

/// 用内置凭证补齐缺失字段，保证嵌套协议开箱可用。
pub(crate) fn fill_defaults(mut cred: WarpCredential) -> WarpCredential {
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

pub(crate) fn builtin_credential() -> WarpCredential {
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

/// 一次连接尝试的输入参数（首次尝试与回退重试用同一份）
struct ConnectArgs {
    protocol: String,
    port: u16,
    api_port: u16,
    mtu: u16,
    timeout_sec: u32,
    allow_lan: bool,
    front_config: Option<String>,
    dns_mode: String,
    dns_custom: String,
    dns_guard: bool,
    ip_family: String,
    sub_exit: String,
    sub_via_warp: bool,
    /// 选定的出口端点（自动择优 / 手动锁定），为空则用凭证注册下发的端点。
    /// 只对 WireGuard 系（wg/awg/gool 外层）生效：MASQUE 端点由 Cloudflare 固定下发。
    endpoint_host: Option<String>,
    endpoint_port: Option<u16>,
    /// Psiphon 出口：开则先拉起 Psiphon 客户端，最终出站改走它的本地 SOCKS
    psiphon: bool,
    /// Psiphon 出口地区（ISO alpha-2，空为自动）
    psiphon_region: String,
    /// 捕获模式：proxy = 只设系统代理；tun = 另建 TUN 虚拟网卡做整机全局
    capture_mode: String,
    /// 广告拦截：把内置广告/追踪域名直接 REJECT（见 adblock.rs）
    ad_block: bool,
}

/// 真正建立连接：下载核心 → 写配置 → 启动 → 通过代理探测出口
///
/// 凭证失效（导入错密钥、自动注册身份被吊销、内置共享身份被风控）时，
/// 自动回退内置凭证重试一次，并在结果里带上 `fallback` / `fallbackReason`，
/// 避免用户只看到"连接超时"却不知道是凭证的问题。
#[tauri::command]
pub async fn core_connect(
    app: AppHandle,
    _state: tauri::State<'_, CoreState>,
    cred: WarpCredential,
    protocol: String,
    port: u16,
    api_port: u16,
    mtu: u16,
    timeout_sec: u32,
    allow_lan: bool,
    front_config: Option<String>,
    dns_mode: Option<String>,
    dns_custom: Option<String>,
    dns_guard: Option<bool>,
    ip_family: Option<String>,
    sub_exit: Option<String>,
    sub_via_warp: Option<bool>,
    endpoint_host: Option<String>,
    endpoint_port: Option<u16>,
    psiphon: Option<bool>,
    psiphon_region: Option<String>,
    capture_mode: Option<String>,
    ad_block: Option<bool>,
) -> Result<CoreResult, String> {
    let cred = fill_defaults(cred);
    let src = crate::credential::source_of(&cred).to_string();
    // 每次连接开始都清一次取消标志：上一次的取消不该影响这一次
    app.state::<CoreState>().cancel.store(false, Ordering::SeqCst);
    let args = ConnectArgs {
        protocol,
        port,
        api_port,
        mtu,
        timeout_sec,
        allow_lan,
        front_config,
        dns_mode: dns_mode.unwrap_or_else(|| "preset".into()),
        dns_custom: dns_custom.unwrap_or_default(),
        dns_guard: dns_guard.unwrap_or(true),
        ip_family: ip_family.unwrap_or_else(|| "v4".into()),
        sub_exit: sub_exit.unwrap_or_else(|| "warp".into()),
        sub_via_warp: sub_via_warp.unwrap_or(false),
        endpoint_host: endpoint_host.filter(|h| !h.trim().is_empty()),
        endpoint_port: endpoint_port.filter(|p| *p > 0),
        psiphon: psiphon.unwrap_or(false),
        psiphon_region: psiphon_region.unwrap_or_default(),
        capture_mode: capture_mode.unwrap_or_else(|| "proxy".into()),
        ad_block: ad_block.unwrap_or(false),
    };

    // 连接全过程是同步阻塞的（起 Psiphon 进程、等隧道、起核心、轮询出口），
    // Psiphon 首次启动就要几十秒。直接在 async 命令体里跑会占住运行时线程、
    // 期间界面与 WebView2 都拿不到响应，所以整段丢进阻塞线程池。
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<CoreState>();
        let state = st.inner();
        match attempt_connect(&app, state, &cred, &args) {
            Ok(mut r) => {
                r.credential_source = src;
                Ok(r)
            }
            Err(first_err) => {
                // 用户主动取消：不回退内置凭证，也不该弹「凭证失效」误导用户
                if is_cancelled(&app) {
                    return Ok(CoreResult {
                        error: CANCELLED.into(),
                        credential_source: src,
                        ..Default::default()
                    });
                }
                if src == "builtin" {
                    return Ok(CoreResult {
                        error: first_err,
                        credential_source: src,
                        ..Default::default()
                    });
                }
                // 当前凭证建立不了隧道 → 回退内置共享凭证再试一次
                let _ = app.emit(
                    "antun-credential",
                    serde_json::json!({
                        "kind": "fallback",
                        "source": "builtin",
                        "ok": true,
                        "error": first_err,
                    }),
                );
                match attempt_connect(&app, state, &builtin_credential(), &args) {
                    Ok(mut r) => {
                        r.credential_source = "builtin".into();
                        r.fallback = true;
                        r.fallback_reason = first_err;
                        Ok(r)
                    }
                    Err(second) => {
                        if is_cancelled(&app) {
                            return Ok(CoreResult {
                                error: CANCELLED.into(),
                                credential_source: "builtin".into(),
                                ..Default::default()
                            });
                        }
                        Ok(CoreResult {
                            error: format!("{}；回退内置凭证仍失败：{}", first_err, second),
                            credential_source: "builtin".into(),
                            fallback: true,
                            fallback_reason: first_err,
                            ..Default::default()
                        })
                    }
                }
            }
        }
    })
    .await
    .map_err(|e| format!("连接任务异常: {}", e))?
}

/// 失败时清理 Psiphon：连接链路上任何一步出错都不该留下一个占着端口的游离客户端。
/// 成功连接时把 keep 置真，进程交还给 state，由 core_stop / 下次连接接管。
struct PsiphonGuard<'a> {
    app: &'a AppHandle,
    keep: bool,
}

impl Drop for PsiphonGuard<'_> {
    fn drop(&mut self) {
        if !self.keep {
            crate::psiphon::stop(self.app);
        }
    }
}

/// 单次尝试：失败一律返回 Err（区分于"成功但结果不完美"），便于上层决定是否回退。
fn attempt_connect(
    app: &AppHandle,
    state: &CoreState,
    cred: &WarpCredential,
    a: &ConnectArgs,
) -> Result<CoreResult, String> {
    let mut cred = fill_defaults(cred.clone());
    // 选定的端点覆盖凭证里的默认端点：这是「自动择优 / 手动锁定」真正生效的地方。
    // MASQUE 系不走这里（端点与 SNI 由 Cloudflare 固定下发，改了反而连不上）。
    if !a.protocol.starts_with("masque") {
        if let Some(h) = a.endpoint_host.as_ref() {
            cred.endpoint_host = h.clone();
        }
        if let Some(p) = a.endpoint_port {
            cred.endpoint_port = p;
        }
    }
    let cred = &cred;
    // 1. 先把之前的核心停掉并还原系统代理，避免端口冲突与旧代理残留
    stop_child(state);
    let _ = restore_system_proxy(app);

    // 1.2 TUN 全局模式的前置条件：提权 + wintun 驱动。都在动手之前判掉，
    // 免得已经拉起 Psiphon、写了一半配置才发现建不了网卡。
    if a.capture_mode == "tun" {
        if !is_elevated() {
            return Err("TUN 全局模式需要管理员权限（要给网卡改路由表）。请用「以管理员身份重启」后再连接，或关闭 TUN 改回仅系统代理。".into());
        }
        ensure_wintun(app)?;
    }

    // 1.5 Psiphon 出口：先把它拉起来拿到本地 SOCKS 端口，再渲染配置。
    // 首次启动要下载远程服务器列表（实测约 30 秒），所以用独立的长超时。
    // 失败一律清理（guard），避免留下一个占着端口的孤儿进程。
    let mut psi_guard = PsiphonGuard { app, keep: !a.psiphon };
    let psiphon_port = if a.psiphon {
        psi_guard.keep = false;
        if is_cancelled(app) {
            return Err(CANCELLED.into());
        }
        match crate::psiphon::start(
            app,
            &a.psiphon_region,
            Duration::from_secs(crate::psiphon::DEFAULT_TIMEOUT_SECS),
            cancel_flag(state),
        ) {
            Ok(p) => Some(p),
            Err(e) => return Err(if is_cancelled(app) { CANCELLED.into() } else { format!("Psiphon 出口启动失败：{}", e) }),
        }
    } else {
        crate::psiphon::stop(app);
        None
    };

    // 2. 确保核心存在
    if is_cancelled(app) {
        return Err(CANCELLED.into());
    }
    let exe = download_core(app)?;
    ensure_bundled_extras(app);

    // 3. 写配置
    let cfg = render_config(
        cred,
        &a.protocol,
        a.port,
        a.api_port,
        a.mtu,
        a.allow_lan,
        a.front_config.as_deref(),
        &a.dns_mode,
        &a.dns_custom,
        a.dns_guard,
        &a.ip_family,
        &a.sub_exit,
        a.sub_via_warp,
        psiphon_port,
        &a.capture_mode,
        a.ad_block,
    );
    let cfg_path = config_path(app)?;
    std::fs::write(&cfg_path, &cfg).map_err(|e| format!("写配置: {}", e))?;

    // 4. 启动前先校验配置，配置非法直接返回具体错误（避免"正在连接"卡死）
    if let Ok(check) = proxy_free_command(&exe)
        .args(["-t", "-f", cfg_path.to_string_lossy().as_ref()])
        .output()
    {
        let err_text = String::from_utf8_lossy(&check.stderr);
        if err_text.contains("failed") || err_text.contains("error") {
            return Err(format!("核心配置校验失败：{}", err_text.trim()));
        }
    }

    // 5. 启动核心
    if is_cancelled(app) {
        return Err(CANCELLED.into());
    }
    let child = proxy_free_command(&exe)
        .args(["-f", cfg_path.to_string_lossy().as_ref()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("启动核心: {}", e))?;
    // 核心进程加入 Job：主程序异常退出时由系统一并结束，避免残留占用端口
    let job = bind_child_to_job(&child);
    if let Ok(mut guard) = state.job.lock() {
        *guard = job;
    }
    if let Ok(mut guard) = state.child.lock() {
        *guard = Some(child);
    }

    // 5.5 TUN 模式：等虚拟网卡真的建起来再进入出口探测。
    // 网卡没建起来时「走 127.0.0.1 代理」照样能通（那是核心自己的出口），
    // 所以绝不能拿出口探测成功去冒充「全局生效」——这正是这里单独判一次的原因。
    if a.capture_mode == "tun" && !wait_tun_adapter(Duration::from_secs(12)) {
        stop_child(state);
        let _ = restore_system_proxy(app);
        return Err(format!(
            "TUN 网卡 {TUN_DEVICE} 未能建立：请确认以管理员身份运行；若缺 wintun.dll，安装 Cloudflare WARP 或 WireGuard 后重试。"
        ));
    }

    // 6. 等待核心就绪 + 真实出口探测（轮询，直到成功或超时）
    let started = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // MASQUE H3 / in-MASQUE 使用 gvisor + bbr，首次握手与双重出口探测
    // 可能接近 10 秒，5 秒兜底会把可用隧道误判为失败，因此下限设为 30 秒。
    let max_wait = a.timeout_sec.max(30) as u64;
    let proxy_url = format!("http://127.0.0.1:{}", a.port);
    let mut last_err = String::new();

    loop {
        // 用户点「取消连接」：立刻收尾，不把这一轮的出口探测跑完
        if is_cancelled(app) {
            stop_child(state);
            let _ = restore_system_proxy(app);
            return Err(CANCELLED.into());
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        if now.saturating_sub(started) >= max_wait {
            break;
        }
        std::thread::sleep(Duration::from_millis(600));

        match probe_exit(&proxy_url) {
            Ok(mut info) => {
                // 如实回报实际使用的端点，便于前端核对而不是靠猜
                info.endpoint_host = cred.endpoint_host.clone();
                info.endpoint_port = cred.endpoint_port;
                // 隧道已验证可用：把系统代理指向本地核心，浏览器才会真正走 WARP
                if let Err(e) = set_system_proxy(app, a.port) {
                    stop_child(state);
                    let _ = restore_system_proxy(app);
                    return Err(format!("设置系统代理失败：{}", e));
                }
                // 连接成功：Psiphon 进程交给 state 持有，随 core_stop 一起结束
                psi_guard.keep = true;
                return Ok(info);
            }
            Err(e) => last_err = e,
        }
    }

    // 超时：停掉核心并返回原因。
    // 不再武断断言「网络阻断了 WARP 的 UDP 出站」：本机网络可能完全支持 WARP 直连，
    // 超时更多来自端点临时不可达、探测窗口内隧道尚未就绪、或 DNS 解析被旧配置拖累。
    // 这类情况重试一次往往就能连上，所以只给中性、可操作的建议。
    stop_child(state);
    let head = if a.psiphon {
        "Psiphon 出口连接超时"
    } else {
        "WARP 连接超时"
    };
    Err(format!(
        "{}：{}。建议重试一次或换一个端点；若反复失败再检查 WARP 凭证，或临时启用 Psiphon 出口。",
        head, last_err
    ))
}

/// 通过本地代理真实探测出口（这是判断"已连接"的唯一依据）
///
/// 用 Cloudflare trace 同时拿到出口 IP 与国家（经隧道请求，能通即证明隧道可用），
/// 再用 gstatic generate_204 做连通性二次确认——两者都通过才算真正连上。
fn probe_exit(proxy_url: &str) -> Result<CoreResult, String> {
    let t0 = SystemTime::now();

    // 1. Cloudflare trace：经隧道请求，返回 ip= / loc= 字段
    let trace = proxy_free_command("curl.exe")
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
    let mut colo = String::new();
    let mut elapsed_ms = 0u32;
    for line in trace_text.lines() {
        if let Some(v) = line.strip_prefix("ip=") { ip = v.to_string(); }
        if let Some(v) = line.strip_prefix("loc=") { loc = v.to_string(); }
        if let Some(v) = line.strip_prefix("warp=") { warp = v.to_string(); }
        if let Some(v) = line.strip_prefix("colo=") { colo = v.to_string(); }
        if let Some(v) = line.strip_prefix("__ANTUN_MS__") {
            elapsed_ms = (v.trim().parse::<f64>().unwrap_or(0.0) * 1000.0) as u32;
        }
    }
    if ip.is_empty() {
        return Err("未获取到出口 IP".into());
    }

    // 2. 二次确认：gstatic 204（YouTube 系服务，能通即证明可访问外网）
    let check = proxy_free_command("curl.exe")
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
        // colo= 是 Cloudflare 边缘机房代码（NRT / HKG / LAX …），
        // 之前误把 warp=on 写进了这里，导致界面显示「CN · WARP on」；
        // 现在如实返回机房代码，只有拿不到时才退回 WARP 标记。
        colo: if !colo.trim().is_empty() {
            colo.trim().to_string()
        } else if warp == "on" || warp == "plus" {
            "WARP".into()
        } else {
            String::new()
        },
        latency,
        error: String::new(),
        ..Default::default()
    })
}

/// 轻量存活探测：只发一次 generate_204，用最短时间判断隧道是否还能出网。
///
/// 定时健康检查用它而不是完整 `probe_exit`（trace + 204 两次请求），
/// 避免 Cloudflare trace 被限速或网络抖动时把可用隧道误判为断开。
fn probe_alive(proxy_url: &str) -> Result<u32, String> {
    let t0 = SystemTime::now();
    let out = proxy_free_command("curl.exe")
        .args([
            "-s", "-o", "NUL", "-w", "%{http_code}", "--max-time", "6",
            "-x", proxy_url, "http://www.gstatic.com/generate_204",
        ])
        .output()
        .map_err(|e| format!("连通性检查: {}", e))?;
    let code = String::from_utf8_lossy(&out.stdout);
    if !code.trim().starts_with('2') {
        return Err(format!("外网连通性检查失败（HTTP {}）", code.trim()));
    }
    Ok(SystemTime::now().duration_since(t0).unwrap_or_default().as_millis() as u32)
}

/// 独立探测命令（供前端定时调用，验证隧道是否仍可用）
///
/// `lite = true` 时只做一次轻量 204 探测，用于 6 秒一次的定时健康检查；
/// 完整探测（trace 取出口 IP + 204 复核）只在连接、手动刷新时使用。
#[tauri::command]
pub async fn probe_status(
    app: AppHandle,
    state: tauri::State<'_, CoreState>,
    port: u16,
    lite: Option<bool>,
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
        return Ok(CoreResult::fail_fatal("核心进程已退出，系统代理已还原"));
    }

    let proxy_url = format!("http://127.0.0.1:{}", port);
    let lite = lite.unwrap_or(false);

    // 探测内部是 curl 子进程 + 最长 8 秒超时，必须放到阻塞线程池，
    // 否则会占住 async 运行时的工作线程，和流量读取、窗口事件抢资源。
    tauri::async_runtime::spawn_blocking(move || {
        if lite {
            return match probe_alive(&proxy_url) {
                Ok(ms) => Ok(CoreResult {
                    ok: true,
                    exit_ip: String::new(),
                    country: String::new(),
                    city: String::new(),
                    colo: String::new(),
                    latency: ms,
                    error: String::new(),
                    ..Default::default()
                }),
                Err(e) => Ok(CoreResult::fail(e)),
            };
        }

        match probe_exit(&proxy_url) {
            Ok(r) => Ok(r),
            Err(e) => {
                // trace 可能被限速或偶发超时：再用一次轻量 204 复核，
                // 只要还能出网就当作存活，避免单次抖动被误判为断线。
                match probe_alive(&proxy_url) {
                    Ok(ms) => Ok(CoreResult {
                        ok: true,
                        exit_ip: String::new(),
                        country: String::new(),
                        city: String::new(),
                        colo: String::new(),
                        latency: ms,
                        error: String::new(),
                        ..Default::default()
                    }),
                    Err(_) => Ok(CoreResult::fail(e)),
                }
            }
        }
    })
    .await
    .map_err(|e| format!("探测任务失败: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg_with(dns_mode: &str, guard: bool, sub_exit: &str, sub_via_warp: bool) -> String {
        cfg_capture(dns_mode, guard, sub_exit, sub_via_warp, "proxy")
    }

    fn cfg_capture(dns_mode: &str, guard: bool, sub_exit: &str, sub_via_warp: bool, capture: &str) -> String {
        cfg_ad(dns_mode, guard, sub_exit, sub_via_warp, capture, false)
    }

    /// ad = 是否开启广告拦截
    fn cfg_ad(dns_mode: &str, guard: bool, sub_exit: &str, sub_via_warp: bool, capture: &str, ad_block: bool) -> String {
        let cred = builtin_credential();
        let front = "  - name: \"SUB-NODE\"\n    type: ss\n    server: 1.2.3.4\n    port: 8388";
        render_config(
            &cred,
            "wg",
            7890,
            9090,
            1280,
            false,
            Some(front),
            dns_mode,
            "",
            guard,
            "v4",
            sub_exit,
            sub_via_warp,
            None,
            capture,
            ad_block,
        )
    }

    #[test]
    fn tun_mode_emits_real_adapter_config() {
        let cfg = cfg_capture("preset", true, "warp", false, "tun");
        assert!(cfg.contains("tun:\n  enable: true"));
        assert!(cfg.contains("device: AnTun"));
        assert!(cfg.contains("auto-route: true"));
        // DNS 打开时劫持 53，交给核心内部解析器（否则会绕过 fake-ip 规则）
        assert!(cfg.contains("dns-hijack:\n    - any:53"));
    }

    #[test]
    fn ad_block_rules_come_before_match() {
        let cfg = cfg_ad("preset", true, "warp", false, "proxy", true);
        let ad_pos = cfg.find("DOMAIN-SUFFIX,doubleclick.net,REJECT").expect("缺少广告拦截规则");
        let match_pos = cfg.find("  - MATCH,PROXY").expect("缺少 MATCH 规则");
        assert!(ad_pos < match_pos, "广告规则必须在 MATCH 之前，否则永远命中不到");
        // 每条都以 REJECT 结尾，且是标准规则行（缩进两格）
        for line in cfg.lines().filter(|l| l.contains(",REJECT")) {
            assert!(line.starts_with("  - DOMAIN-SUFFIX,"), "规则行格式不对: {line}");
            assert!(line.ends_with(",REJECT"), "规则行格式不对: {line}");
        }
    }

    #[test]
    fn ad_block_off_emits_no_reject_rules() {
        let cfg = cfg_with("preset", true, "warp", false);
        assert!(!cfg.contains(",REJECT"), "关闭广告拦截后不应有 REJECT 规则");
    }

    #[test]
    fn ad_block_also_applies_in_tun_mode() {
        // TUN 只是捕获方式变了，规则表是同一份，广告拦截必须照样在
        let cfg = cfg_ad("preset", true, "warp", false, "tun", true);
        assert!(cfg.contains("DOMAIN-SUFFIX,doubleclick.net,REJECT"));
        assert!(cfg.contains("tun:\n  enable: true"));
    }

    #[test]
    fn ad_block_rules_survive_dns_off() {
        // DNS 关闭时 dns 段为空，广告规则仍要写进 rules
        let cfg = cfg_ad("off", true, "warp", false, "proxy", true);
        assert!(!cfg.contains("dns:\n"));
        assert!(cfg.contains("DOMAIN-SUFFIX,doubleclick.net,REJECT"));
    }

    #[test]
    fn proxy_mode_has_no_tun_block() {
        let cfg = cfg_with("preset", true, "warp", false);
        assert!(!cfg.contains("\ntun:"));
    }

    #[test]
    fn tun_with_dns_off_skips_hijack() {
        // DNS 关闭还劫持 53，会把所有查询塞进停用的解析器 —— 等于把 DNS 掐死
        let cfg = cfg_capture("off", true, "warp", false, "tun");
        assert!(cfg.contains("tun:\n  enable: true"));
        assert!(!cfg.contains("dns-hijack"));
    }

    #[test]
    fn dns_guard_uses_fake_ip_and_doh() {
        let cfg = cfg_with("preset", true, "warp", false);
        assert!(cfg.contains("enhanced-mode: fake-ip"));
        assert!(cfg.contains("https://1.1.1.1/dns-query"));
        assert!(cfg.contains("ipv6: false"));
        // 解析器流量跟随隧道，不再给 1.1.1.1/8.8.8.8 放 IP-CIDR 直连例外：
        // 在封锁 1.1.1.1 的网络里那样写会让 DoH 直接超时（1.7.8 已回退）
        assert!(!cfg.contains("IP-CIDR,1.1.1.1/32,PROXY"));
        assert!(!cfg.contains("IP-CIDR,8.8.8.8/32,PROXY"));
    }

    #[test]
    fn dns_off_removes_dns_block() {
        let cfg = cfg_with("off", true, "warp", false);
        assert!(!cfg.contains("\ndns:/n"));
        assert!(!cfg.contains("IP-CIDR,1.1.1.1/32,PROXY"));
    }

    #[test]
    fn node_exit_turns_node_into_final_outbound() {
        let cfg = cfg_with("preset", true, "node", true);
        // WARP 不再以节点为前置，改为承载节点流量
        assert!(!cfg.contains("dialer-proxy: \"SUB-NODE\""));
        assert!(cfg.contains("dialer-proxy: \"WARP\""));
        assert!(cfg.contains("      - SUB-NODE"));
    }

    #[test]
    fn warp_exit_keeps_node_as_front() {
        let cfg = cfg_with("preset", true, "warp", false);
        assert!(cfg.contains("dialer-proxy: \"SUB-NODE\""));
        assert!(cfg.contains("      - WARP"));
    }

    /// /traffic 是长连接流：核心发完一行后不会关连接。
    /// 读取必须拿到第一行就返回，不能像 `curl --max-time 2` 那样等满 2 秒。
    #[test]
    fn traffic_line_returns_before_stream_ends() {
        use std::io::Write;
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                let _ = s.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n41\r\n{\"up\":10,\"down\":20,\"upTotal\":100,\"downTotal\":200}\r\n",
                );
                let _ = s.flush();
                // 模拟 mihomo：连接保持打开，后续每秒一行
                std::thread::sleep(Duration::from_secs(5));
            }
        });

        let t0 = std::time::Instant::now();
        let line = read_traffic_line(port).expect("应读到第一行 JSON");
        let elapsed = t0.elapsed();
        assert!(line.starts_with('{'), "line={line}");
        assert!(line.contains("\"up\""));
        assert!(
            elapsed < Duration::from_millis(300),
            "读取耗时 {elapsed:?}，仍在等流结束"
        );
    }
}
