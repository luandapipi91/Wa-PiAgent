// 目录选择封装层：Tauri 环境用原生文件夹选择器，非 Tauri 降级到 prompt 输入
// 动态 import plugin-dialog，避免非 Tauri 环境加载即崩

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * 选目录（Tauri 环境）。
 * 非 Tauri 环境返回 null（调用方决定是否降级到手动输入）。
 */
export async function pickDirectory(): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const result = await open({ directory: true, multiple: false });
  // open 在取消时返回 null
  return typeof result === "string" ? result : null;
}

/**
 * 选目录，非 Tauri 环境降级到 prompt 手动输入（dev server 调试 / E2E 用 page.on("dialog") 拦截）。
 * 用户取消返回 null。
 */
export async function pickDirectoryOrPrompt(): Promise<string | null> {
  const dir = await pickDirectory();
  if (dir) return dir;
  // 非 Tauri 或用户取消原生选择器 → prompt 手动输入
  const input = window.prompt("输入项目目录绝对路径");
  return input && input.trim() ? input.trim() : null;
}

/** 取路径的 basename 作项目名（/Users/x/work/my-app → my-app） */
export function basename(path: string): string {
  // 处理尾部斜杠
  const clean = path.replace(/[\\/]+$/, "");
  const idx = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return clean.slice(idx + 1) || clean;
}
