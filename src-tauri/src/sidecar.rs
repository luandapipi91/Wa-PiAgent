// kernel sidecar 启停：Tauri setup 时 spawn，窗口关闭时 kill
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// 启动 hiagent-kernel sidecar，返回子进程句柄供生命周期管理。
/// sidecar 的 stdout/stderr 转发到 Rust 进程的 stderr（调试用）。
pub fn spawn_kernel(app: &tauri::AppHandle) -> std::result::Result<CommandChild, String> {
    let sidecar = app
        .shell()
        .sidecar("hiagent-kernel")
        .map_err(|e| format!("找不到 sidecar: {e}"))?;
    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| format!("spawn kernel 失败: {e}"))?;
    // 异步消费事件流：转发 stdout/stderr 到本进程 stderr，避免管道缓冲写满阻塞
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    eprintln!("[kernel] {}", String::from_utf8_lossy(&bytes).trim_end());
                }
                CommandEvent::Stderr(bytes) => {
                    eprintln!("[kernel] {}", String::from_utf8_lossy(&bytes).trim_end());
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!("[kernel] 进程退出 code={:?}", payload.code);
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(child)
}
