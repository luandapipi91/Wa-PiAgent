// 端口占用检测与清理（搬自 scripts/port.ts，desktop 专用副本）。
import { createServer } from "node:net";
import { spawn } from "node:child_process";

const isWindows = process.platform === "win32";

export async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => server.close(() => resolve(false)));
    server.listen(port);
  });
}

export async function killPort(port: number): Promise<void> {
  // 实现：同 scripts/port.ts 的 killPort（PowerShell/taskkill + lsof 轮询）
  // 这里复刻其逻辑；详见 scripts/port.ts。
  const findPid = (p: number) => new Promise<number | null>((resolve) => {
    const ps = `Get-NetTCPConnection -LocalPort ${p} -State Listen | Select-Object -First 1 -ExpandProperty OwningProcess`;
    const child = isWindows
      ? spawn("powershell.exe", ["-NoProfile", "-Command", ps], { stdio: ["ignore", "pipe", "ignore"] })
      : spawn("/bin/sh", ["-c", `lsof -ti :${p}`], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("close", () => {
      const m = out.trim().match(/(\d+)/);
      resolve(m ? Number(m[1]) : null);
    });
    child.on("error", () => resolve(null));
  });
  const killPid = (pid: number) => new Promise<void>((resolve) => {
    const c = isWindows
      ? spawn("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" })
      : spawn("/bin/sh", ["-c", `kill -9 ${pid}`], { stdio: "ignore" });
    c.on("close", () => resolve());
    c.on("error", () => resolve());
  });
  const pid = await findPid(port);
  if (pid != null) await killPid(pid);
  for (let i = 0; i < 15; i++) {
    if (!(await isPortInUse(port))) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}
