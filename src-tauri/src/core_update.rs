//! 内核更新：mihomo 走官方 Release，Psiphon 走 AnTun Release 中发布的组件包。
//! 更新只替换用户数据目录内的 exe，不改动安装包内置副本，便于失败时回退。

use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};
#[cfg(windows)]
use std::os::windows::process::CommandExt;

const GH_API: &str = "https://api.github.com";
const GH_PROXY: &str = "https://ghfast.top/";
const MIHOMO_REPO: &str = "MetaCubeX/mihomo";
const ANTUN_REPO: &str = "andyzhang201310-coder/AnTun";

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    assets: Vec<GhAsset>,
}

#[derive(Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct UpdateMeta {
    mihomo_version: Option<String>,
    psiphon_version: Option<String>,
    mihomo_updated_at: Option<u64>,
    psiphon_updated_at: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreComponentStatus {
    installed: bool,
    version: String,
    updated_at: Option<u64>,
    source: String,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreUpdateStatus {
    mihomo: CoreComponentStatus,
    psiphon: CoreComponentStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreUpdateResult {
    ok: bool,
    component: String,
    version: String,
    message: String,
    needs_restart: bool,
}

fn hidden_command(program: impl AsRef<OsStr>) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

fn app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {}", e))
}

fn meta_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_dir(app)?.join("core-update.json"))
}

fn read_meta(app: &AppHandle) -> UpdateMeta {
    let Ok(path) = meta_path(app) else {
        return UpdateMeta::default();
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return UpdateMeta::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn write_meta(app: &AppHandle, meta: &UpdateMeta) -> Result<(), String> {
    let path = meta_path(app)?;
    let text = serde_json::to_string_pretty(meta).map_err(|e| format!("serialize meta: {}", e))?;
    std::fs::write(path, text).map_err(|e| format!("write meta: {}", e))
}

fn curl_text(url: &str, timeout: u64) -> Result<String, String> {
    let timeout_arg = timeout.to_string();
    let out = hidden_command("curl.exe")
        .args(["-sSL", "--fail", "--connect-timeout", "10", "--retry", "1", "--max-time", timeout_arg.as_str(), url])
        .output()
        .map_err(|e| format!("curl: {}", e))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    String::from_utf8(out.stdout).map_err(|e| format!("decode response: {}", e))
}

fn github_latest(repo: &str) -> Result<GhRelease, String> {
    let url = format!("{}/repos/{}/releases/latest", GH_API, repo);
    let text = curl_text(&url, 30).or_else(|_| curl_text(&format!("{}{}", GH_PROXY, url), 30))?;
    serde_json::from_str::<GhRelease>(&text).map_err(|e| format!("解析 Release 信息失败: {}", e))
}

fn download_file(url: &str, dest: &Path, timeout: u64) -> Result<(), String> {
    let _ = std::fs::remove_file(dest);
    let timeout_arg = timeout.to_string();
    let dest_arg = dest.to_string_lossy().to_string();
    let try_download = |target: &str| -> bool {
        hidden_command("curl.exe")
            .args([
                "-sSL", "--fail", "--connect-timeout", "15", "--retry", "2",
                "--max-time", timeout_arg.as_str(), "-o", dest_arg.as_str(), target,
            ])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    };
    if try_download(url) {
        return Ok(());
    }
    let _ = std::fs::remove_file(dest);
    if try_download(&format!("{}{}", GH_PROXY, url)) {
        return Ok(());
    }
    Err("下载失败：源站与镜像均不可达".into())
}

fn ps_quote(value: &str) -> String {
    value.replace('\'', "''")
}

fn extract_exe(zip: &Path, dest: &Path) -> Result<(), String> {
    let _ = std::fs::remove_dir_all(dest);
    std::fs::create_dir_all(dest).map_err(|e| format!("create extract dir: {}", e))?;
    let script = format!(
        "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
        ps_quote(&zip.to_string_lossy()),
        ps_quote(&dest.to_string_lossy()),
    );
    let status = hidden_command("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .status()
        .map_err(|e| format!("unzip: {}", e))?;
    if !status.success() {
        return Err("内核压缩包解压失败".into());
    }
    Ok(())
}

fn find_exe(dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_exe(&path) {
                return Some(found);
            }
        } else if path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("exe"))
            .unwrap_or(false)
        {
            return Some(path);
        }
    }
    None
}

fn replace_file(from: &Path, dest: &Path) -> Result<(), String> {
    let backup = dest.with_extension("exe.bak");
    let _ = std::fs::remove_file(&backup);
    if dest.exists() {
        std::fs::rename(dest, &backup).map_err(|e| format!("备份旧内核失败: {}", e))?;
    }
    match std::fs::copy(from, dest) {
        Ok(_) => {
            let _ = std::fs::remove_file(&backup);
            Ok(())
        }
        Err(e) => {
            if backup.exists() {
                let _ = std::fs::rename(&backup, dest);
            }
            Err(format!("安装新内核失败: {}", e))
        }
    }
}

fn mihomo_version(exe: &Path) -> String {
    let Ok(out) = hidden_command(exe).arg("-v").output() else {
        return "内置版本".into();
    };
    if !out.status.success() {
        return "内置版本".into();
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let fallback = String::from_utf8_lossy(&out.stderr);
    text.lines()
        .chain(fallback.lines())
        .map(|line| line.trim())
        .find(|line| !line.is_empty())
        .unwrap_or("内置版本")
        .to_string()
}

fn component_status(app: &AppHandle, exe_name: &str, version: String, updated_at: Option<u64>, meta_marked: bool) -> CoreComponentStatus {
    let path = app_dir(app).map(|dir| dir.join(exe_name)).ok();
    let size = path.as_ref().and_then(|p| std::fs::metadata(p).ok()).map(|m| m.len()).unwrap_or(0);
    CoreComponentStatus {
        installed: path.map(|p| p.is_file()).unwrap_or(false),
        version,
        updated_at,
        source: if meta_marked { "updated" } else { "bundled" }.to_string(),
        size,
    }
}

#[tauri::command]
pub fn core_update_status(app: AppHandle) -> CoreUpdateStatus {
    let meta = read_meta(&app);
    let mihomo = component_status(
        &app,
        "mihomo.exe",
        meta.mihomo_version.clone().unwrap_or_else(|| {
            app_dir(&app)
                .ok()
                .map(|d| d.join("mihomo.exe"))
                .filter(|p| p.is_file())
                .map(|p| mihomo_version(p.as_path()))
                .unwrap_or_else(|| "未安装".into())
        }),
        meta.mihomo_updated_at,
        meta.mihomo_version.is_some(),
    );
    let psiphon = component_status(
        &app,
        "psiphon.exe",
        meta.psiphon_version.clone().unwrap_or_else(|| "内置版本".into()),
        meta.psiphon_updated_at,
        meta.psiphon_version.is_some(),
    );
    CoreUpdateStatus { mihomo, psiphon }
}

#[tauri::command]
pub fn core_update(
    app: AppHandle,
    kind: String,
    state: State<'_, crate::core::CoreState>,
) -> Result<CoreUpdateResult, String> {
    if crate::core::is_running(&state) {
        return Err("请先断开当前连接再更新内核".into());
    }

    let work_dir = app_dir(&app)?.join("core-update");
    std::fs::create_dir_all(&work_dir).map_err(|e| format!("create update dir: {}", e))?;
    let mut meta = read_meta(&app);

    let result = match kind.as_str() {
        "mihomo" => {
            let release = github_latest(MIHOMO_REPO)?;
            let asset = release
                .assets
                .iter()
                .find(|a| {
                    a.name.starts_with("mihomo-windows-amd64-compatible-")
                        && a.name.to_ascii_lowercase().ends_with(".zip")
                })
                .ok_or("官方 Release 中未找到 Windows amd64 核心包")?;
            let zip_path = work_dir.join(&asset.name);
            download_file(&asset.browser_download_url, &zip_path, 240)?;
            let extract_dir = work_dir.join("mihomo-extract");
            extract_exe(&zip_path, &extract_dir)?;
            let exe = find_exe(&extract_dir).ok_or("核心包中未找到 mihomo.exe")?;
            replace_file(&exe, &app_dir(&app)?.join("mihomo.exe"))?;
            meta.mihomo_version = Some(release.tag_name.clone());
            meta.mihomo_updated_at = Some(now_secs());
            CoreUpdateResult {
                ok: true,
                component: kind.clone(),
                version: release.tag_name,
                message: "mihomo 已更新".into(),
                needs_restart: true,
            }
        }
        "psiphon" => {
            let release = github_latest(ANTUN_REPO)?;
            let asset = release
                .assets
                .iter()
                .find(|a| a.name.eq_ignore_ascii_case("psiphon.exe"))
                .ok_or("AnTun 最新发行版尚未提供 Psiphon 组件包")?;
            let exe_path = work_dir.join("psiphon-new.exe");
            download_file(&asset.browser_download_url, &exe_path, 240)?;
            replace_file(&exe_path, &app_dir(&app)?.join("psiphon.exe"))?;
            meta.psiphon_version = Some(release.tag_name.clone());
            meta.psiphon_updated_at = Some(now_secs());
            CoreUpdateResult {
                ok: true,
                component: kind.clone(),
                version: release.tag_name,
                message: "Psiphon 已更新".into(),
                needs_restart: true,
            }
        }
        _ => return Err("未知的内核类型".into()),
    };

    write_meta(&app, &meta)?;
    let _ = std::fs::remove_dir_all(&work_dir);
    Ok(result)
}
