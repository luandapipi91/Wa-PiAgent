// HiAgent Tauri 主进程：启动时 spawn kernel sidecar，窗口关闭时 kill
mod sidecar;

use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_shell::process::CommandChild;

/// 持有 kernel sidecar 子进程句柄，供窗口关闭时清理
struct KernelChild(Mutex<Option<CommandChild>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(KernelChild(Mutex::new(None)))
        .setup(|app| {
            let child = sidecar::spawn_kernel(&app.handle())
                .map_err(|e| Box::<dyn std::error::Error>::from(e))?;
            let state: tauri::State<KernelChild> = app.state();
            *state.0.lock().unwrap() = Some(child);
            Ok(())
        })
        .on_window_event(|window, event| {
            // 窗口关闭时 kill kernel sidecar，防泄漏
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let state: tauri::State<KernelChild> = window.state();
                // 先 take 出 child（MutexGuard 在语句末释放），再 kill
                let child = state.0.lock().unwrap().take();
                if let Some(child) = child {
                    let _ = child.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
