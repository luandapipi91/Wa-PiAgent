// HiAgent Tauri 主进程入口（Task 30 空壳，Task 32 接管 sidecar 生命周期）

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
