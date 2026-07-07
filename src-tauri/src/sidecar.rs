// kernel sidecar 启停 + 热重启：Tauri setup 时 spawn，窗口关闭时 kill，
// kernel 二进制变化时自动 kill 旧进程 + spawn 新进程（开发期热更新）
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// 持有 kernel sidecar 子进程句柄。
/// - setup 时存入
/// - 窗口关闭时 take 出并 kill
/// - 二进制变化热重启时 take 出 kill、重新 spawn 后存回
pub struct KernelChild(pub Mutex<Option<CommandChild>>);

/// 返回当前 Rust host 的 target triple，与 packages/kernel/scripts/copy-sidecar.mjs 对齐。
/// Tauri sidecar 按 {name}-{triple} 解析 externalBin 文件。
pub fn triple_for_host() -> String {
    // std::env::consts::{ARCH, OS} 的取值是 Rust 标准化字符串，稳定可靠
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "aarch64",
        other => other,
    };
    let os = match std::env::consts::OS {
        "macos" => "apple-darwin",
        "windows" => "pc-windows-msvc",
        "linux" => "unknown-linux-gnu",
        other => other,
    };
    format!("{arch}-{os}")
}

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

/// 热重启 kernel sidecar：kill 旧进程 → spawn 新进程。
/// 用于开发期 kernel 二进制重编后的自动热更新。
pub fn restart_kernel(app: &tauri::AppHandle) -> std::result::Result<(), String> {
    let state: tauri::State<KernelChild> = app.state();
    // take 出旧 child 并 kill（MutexGuard 在语句末释放，避免死锁）
    if let Some(old) = state.0.lock().unwrap().take() {
        let _ = old.kill();
        eprintln!("[kernel] 旧 sidecar 已 kill，正在重启...");
    }
    // 重新 spawn 新二进制（磁盘上的文件已被 watch 进程替换）
    let child = spawn_kernel(app)?;
    *state.0.lock().unwrap() = Some(child);
    eprintln!("[kernel] 新 sidecar 已启动");
    Ok(())
}

/// 监听 kernel 二进制文件变化，自动触发 restart_kernel。
/// - 监听 packages/kernel/dist/ 目录（macOS FSEvents 目录级监听，规避单文件原子替换丢事件）
/// - 过滤 hiagent-kernel-{triple} 文件事件
/// - 300ms 手写去抖，避免 copy-sidecar.mjs 的多步写入触发多次重启
///
/// 只在 debug 构建生效（开发期热更新）；release 打包不监听。
pub fn watch_kernel_binary(app: tauri::AppHandle) {
    // release 构建不走热更新（生产打包没有 dist 目录、没有 watch 进程）
    #[cfg(not(debug_assertions))]
    {
        let _ = app;
        return;
    }

    #[cfg(debug_assertions)]
    {
        use notify::{event::EventKind, RecursiveMode, Watcher};
        use std::path::PathBuf;
        use std::time::{Duration, Instant};
        use tokio::sync::mpsc;

        // dist 目录 = src-tauri/../packages/kernel/dist
        // CARGO_MANIFEST_DIR 在编译期指向 src-tauri/ 目录
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let dist_dir = manifest_dir
            .join("..")
            .join("packages")
            .join("kernel")
            .join("dist");

        if !dist_dir.exists() {
            eprintln!("[kernel] dist 目录不存在，跳过二进制监听: {}", dist_dir.display());
            return;
        }

        let triple = triple_for_host();
        let watch_target = format!("hiagent-kernel-{triple}");
        eprintln!(
            "[kernel] 监听二进制变化: {} ({})",
            dist_dir.display(),
            watch_target
        );

        let (tx, mut rx) = mpsc::channel::<()>(32);

        // notify watcher 必须在独立线程运行（不可跨 await）
        let dist_dir_clone = dist_dir.clone();
        std::thread::spawn(move || -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
            let (notify_tx, notify_rx) = std::sync::mpsc::channel();
            let mut watcher = notify::recommended_watcher(notify_tx)?;
            watcher.watch(&dist_dir_clone, RecursiveMode::NonRecursive)?;

            for ev in notify_rx {
                let Ok(event) = ev else { continue };
                // 只关心目标二进制文件的写入/创建/修改事件
                let is_target = event.paths.iter().any(|p| {
                    p.file_name()
                        .map(|n| n.to_string_lossy() == watch_target)
                        .unwrap_or(false)
                });
                if !is_target {
                    continue;
                }
                if matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                    // 异步通知消费端（非阻塞；满了直接丢弃，去抖端只看时间戳）
                    let _ = tx.blocking_send(());
                }
            }
            Ok(())
        });

        // 消费端：300ms 去抖 + 触发 restart_kernel
        let app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut last: Option<Instant> = None;
            while rx.recv().await.is_some() {
                let now = Instant::now();
                let should_fire = match last {
                    Some(t) => now.duration_since(t) >= Duration::from_millis(300),
                    None => true,
                };
                if !should_fire {
                    continue;
                }
                last = Some(now);
                // 多等 200ms 让 copy-sidecar.mjs 写完（write+rename 可能非原子序列）
                tokio::time::sleep(Duration::from_millis(200)).await;
                if let Err(e) = restart_kernel(&app_handle) {
                    eprintln!("[kernel] 热重启失败: {e}");
                }
            }
        });

        let _ = app;
    }
}
