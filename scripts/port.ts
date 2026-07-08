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

/** kill 占用端口的进程;完成后轮询等待端口真正空闲（最多 3s） */
export async function killPort(port: number): Promise<void> {
  // 第一轮：PID kill
  const pid = await findPidOnPort(port);
  if (pid != null) await killPid(pid);

  // 兜底：lsof -ti 有时拿不到 PID（进程僵死/TIME_WAIT），用 shell 管道强制清理
  if (await isPortInUse(port)) {
    const child = isWindows
      ? spawn("powershell.exe", ["-NoProfile", "-Command",
          `Get-NetTCPConnection -LocalPort ${port} -State Listen | Stop-Process -Force`], { stdio: "ignore" })
      : spawn("/bin/sh", ["-c", `lsof -ti :${port} | xargs kill -9 2>/dev/null; true`], { stdio: "ignore" });
    await new Promise<void>((resolve) => {
      child.on("close", () => resolve());
      child.on("error", () => resolve());
    });
  }

  // 轮询等待端口真正空闲（处理 TIME_WAIT 等瞬时状态）
  for (let i = 0; i < 15; i++) {
    if (!(await isPortInUse(port))) return;
    await sleep(200);
  }
  // 3 秒后仍被占就算了（可能被其他进程占用），不阻塞启动
}

function killPid(pid: number): Promise<void> {
  const child = isWindows
    ? spawn("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" })
    : spawn("/bin/sh", ["-c", `kill -9 ${pid}`], { stdio: "ignore" });
  return new Promise((resolve) => {
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
