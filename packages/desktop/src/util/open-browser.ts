// 跨平台用系统默认浏览器打开 URL（搬自 scripts/open-browser.ts）。
import { spawn } from "node:child_process";

export function openBrowserCommand(): { shell: string; args: string[] } | null {
  switch (process.platform) {
    case "win32": return { shell: "cmd.exe", args: ["/c", "start", ""] };
    case "darwin": return { shell: "/usr/bin/open", args: [] };
    default: return { shell: "xdg-open", args: [] };
  }
}

export async function openBrowser(url: string): Promise<void> {
  const cmd = openBrowserCommand();
  if (!cmd) return;
  return new Promise((resolve) => {
    const child = spawn(cmd.shell, [...cmd.args, url], { stdio: "ignore", detached: true });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}
