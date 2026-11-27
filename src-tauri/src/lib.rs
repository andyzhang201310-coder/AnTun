mod core;
mod core_update;
mod credential;
mod endpoint_probe;
mod net_diag;
mod node_test;
mod psiphon;
mod subscription;
mod wg_handshake;

use serde::Serialize;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_autostart::ManagerExt;

/// 托盘图标保存在全局状态，供前端通知连接状态时更新提示文字。
struct TrayState(Mutex<Option<TrayIcon>>);

/// 前端设置开机自启。
#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let result = if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    };
    result.map(|_| true).map_err(|e| e.to_string())
}

/// 前端查询开机自启状态。
#[tauri::command]
fn get_autostart(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    exe_path: String,
    resource_dir: String,
    data_dir: String,
}

/// 关于页使用的真实版本与路径，避免硬编码 XEHN 信息。
#[tauri::command]
fn app_info(app: AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        exe_path: std::env::current_exe()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        resource_dir: app
            .path()
            .resource_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        data_dir: app
            .path()
            .app_data_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
    }
}

/// 连接状态同步到托盘提示文字。
#[tauri::command]
fn notify_status(connected: bool, state: State<'_, TrayState>) -> Result<(), String> {
    if let Some(tray) = state.0.lock().map_err(|e| e.to_string())?.as_ref() {
        let tip = if connected {
            "AnTun · 已连接"
        } else {
            "AnTun · 未连接"
        };
        let _ = tray.set_tooltip(Some(tip));
    }
    Ok(())
}

/// 前端已完成断连与代理还原，主进程可以安全退出。
#[tauri::command]
fn quit_ready(app: AppHandle) {
    app.exit(0);
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 二次双击 exe：唤起已有窗口，避免启动第二个客户端争抢端口
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .manage(TrayState(Mutex::new(None)))
        .manage(core::CoreState::default())
        .manage(node_test::NodeTestState::default())
        .manage(psiphon::PsiphonState::default())
        .invoke_handler(tauri::generate_handler![
            set_autostart,
            get_autostart,
            app_info,
            notify_status,
            quit_ready,
            subscription::subscription_fetch,
            subscription::subscription_parse,
            core::core_connect,
            core::core_cancel_connect,
            core::core_stop,
            core::core_status,
            core::core_traffic,
            core::save_credential,
            core::load_credential,
            core::probe_status,
            credential::credential_info,
            endpoint_probe::endpoint_probe,
            core_update::core_update_status,
            core_update::core_update,
            psiphon::psiphon_regions,
            psiphon::set_psiphon_region,
            psiphon::psiphon_status,
            psiphon::psiphon_stop,
            node_test::node_test_start,
            node_test::node_test_delay,
            node_test::node_test_speed,
            node_test::node_test_stop,
            net_diag::net_diagnose
        ])
        .setup(|app| {
            // 上次异常退出若留下代理快照，先还原，避免系统代理指向已死的本地端口
            core::restore_orphan_proxy(app.handle());

            // 首次启动为本机匿名注册独享 WARP 身份（后台线程，失败不影响使用：
            // 没有独享身份时连接会自动回退内置共享凭证）
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                match credential::ensure_identity(&handle) {
                    Ok(src) => eprintln!("[credential] identity ready: {}", src),
                    Err(e) => eprintln!("[credential] auto register skipped: {}", e),
                }
            });

            // 关闭窗口 → 收进托盘，隧道与代理保持（VPN 客户端关键行为）
            if let Some(window) = app.get_webview_window("main") {
                let w = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = w.hide();
                    }
                });
            }

            // 系统托盘：左键切换窗口，右键菜单显示/退出
            let show_item = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出 AnTun", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            let icon = app.default_window_icon().cloned();

            let mut builder = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("AnTun")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        // 先停止核心进程并还原系统代理，避免浏览器流量指向死端口
                        if let Some(state) = app.try_state::<core::CoreState>() {
                            let _ = core::core_stop(app.clone(), state);
                        }
                        // 结束可能残留的测速核心，避免退出后孤儿进程占用端口
                        if let Some(state) = app.try_state::<node_test::NodeTestState>() {
                            let _ = node_test::node_test_stop(state);
                        }
                        // 通知前端断开连接、还原系统代理，再退出（带超时保护）
                        let _ = app.emit("antun-quit-request", ());
                        let handle = app.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(1500));
                            handle.exit(0);
                        });
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                });

            if let Some(icon) = icon {
                builder = builder.icon(icon);
            }
            let tray = builder.build(app)?;
            app.state::<TrayState>().0.lock().unwrap().replace(tray);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running AnTun");
}
