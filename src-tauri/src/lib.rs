// HiAgent Tauri 主进程：启动时 spawn kernel sidecar + 监听二进制变化热重启，
// 窗口关闭时 kill sidecar
mod sidecar;

use sidecar::KernelChild;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(KernelChild(std::sync::Mutex::new(None)))
        .setup(|app| {
            let child = sidecar::spawn_kernel(&app.handle())
                .map_err(|e| Box::<dyn std::error::Error>::from(e))?;
            let state: tauri::State<KernelChild> = app.state();
            *state.0.lock().unwrap() = Some(child);
            // 启动 kernel 二进制文件监听（开发期热更新）
            sidecar::watch_kernel_binary(app.handle().clone());
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
