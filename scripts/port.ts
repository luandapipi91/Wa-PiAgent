// 跨平台端口占用检测与清理。
// 检测占用:先尝试建 net.Server 监听,失败说明端口被占(拿不到 PID,但够 dev 启动前清理用);
// 若要拿 PID kill,用平台命令(Windows PowerShell / POSIX lsof)。
import { createServer } from "node:net";
import { spawn } from "node:child_process";

const isWindows = process.platform === "win32";

/** 端口是否被占用(监听测试,跨平台可靠,不依赖外部命令解析) */
export async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(true));  // 监听失败=被占用
    server.once("listening", () => {
      server.close(() => resolve(false));  // 监听成功=空闲,立即关闭
    });
    server.listen(port);
  });
}

/** 查端口占用的 PID,无占用或拿不到返回 null */
export async function findPidOnPort(port: number): Promise<number | null> {
  // Windows 用 PowerShell(比 netstat|findstr 在 Git Bash 下可靠,避免 shell 参数转换问题);
  // POSIX 用 lsof -ti
  const psCmd = `Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -First 1 -ExpandProperty OwningProcess`;
  return new Promise((resolve) => {
    const child = isWindows
      ? spawn("powershell.exe", ["-NoProfile", "-Command", psCmd], { stdio: ["ignore", "pipe", "ignore"] })
      : spawn("/bin/sh", ["-c", `lsof -ti :${port}`], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("close", () => {
      const trimmed = out.trim();
      if (!trimmed) return resolve(null);
      const match = trimmed.match(/(\d+)/);
      resolve(match ? Number(match[1]) : null);
    });
    child.on("error", () => resolve(null));
  });
}

/** kill 占用端口的进程;无占用或拿不到 PID 时,若端口仍被占则尽力 kill */
export async function killPort(port: number): Promise<void> {
  const pid = await findPidOnPort(port);
  if (pid == null) return;  // 拿不到 PID(空闲 或 PowerShell 不可用),直接返回
  const child = isWindows
    ? spawn("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" })
    : spawn("/bin/sh", ["-c", `kill -9 ${pid}`], { stdio: "ignore" });
  return new Promise((resolve) => {
    child.on("close", () => resolve());
    child.on("error", () => resolve());  // spawn 失败也 resolve,避免 promise 永挂
  });
}
