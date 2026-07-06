#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

struct SidecarState(Mutex<Option<Child>>);

fn spawn_bun_sidecar() -> std::io::Result<Child> {
    Command::new("bun")
        .arg("run")
        .arg("packages/kernel/src/index.ts")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
}

fn main() {
    tauri::Builder::default()
        .manage(SidecarState(Mutex::new(None)))
        .setup(|app| {
            match spawn_bun_sidecar() {
                Ok(child) => {
                    let state: tauri::State<SidecarState> = app.state();
                    *state.0.lock().unwrap() = Some(child);
                    println!("[HiAgent] Bun sidecar started");
                }
                Err(e) => eprintln!("[HiAgent] Failed to start Bun sidecar: {}", e),
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let state: tauri::State<SidecarState> = window.app_handle().state();
                if let Some(mut child) = state.0.lock().unwrap().take() {
                    let _ = child.kill();
                    println!("[HiAgent] Bun sidecar stopped");
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
