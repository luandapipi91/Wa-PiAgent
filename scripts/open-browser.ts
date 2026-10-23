// 跨平台用系统默认浏览器打开 URL。
import { spawn } from "node:child_process";

/** 当前平台的开浏览器命令;不支持的平台返回 null */
export function openBrowserCommand(): { shell: string; args: string[] } | null {
  switch (process.platform) {
    case "win32":
      return { shell: "cmd.exe", args: ["/c", "start", ""] };  // start 后空引号是 Windows idiom(避免把 URL 当标题)
    case "darwin":
      return { shell: "/usr/bin/open", args: [] };  // open <url>
    default:
      // Linux/BSD 等,优先 xdg-open
      return { shell: "xdg-open", args: [] };
  }
}

/** 用系统默认浏览器打开 url */
export async function openBrowser(url: string): Promise<void> {
  const cmd = openBrowserCommand();
  if (!cmd) return;
  return new Promise((resolve) => {
    const child = spawn(cmd.shell, [...cmd.args, url], { stdio: "ignore", detached: true });
    child.on("close", () => resolve());
    child.on("error", () => resolve());  // 开浏览器失败不阻塞启动
  });
}
