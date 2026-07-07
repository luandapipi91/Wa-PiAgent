// 跨平台端口占用检测与清理。Windows 用 netstat,POSIX 用 lsof。
import { spawn } from "node:child_process";

const isWindows = process.platform === "win32";

/** 查端口占用的 PID,无占用返回 null */
export async function findPidOnPort(port: number): Promise<number | null> {
  // 命令拼接;用 buffer 收集输出后正则提取 PID
  // Windows 用 /R 正则配合 ":端口 " (端口后跟空格) 精确匹配,避免 :1999 命中 :19999
  const cmd = isWindows ? `netstat -ano | findstr /R ":${port} "` : `lsof -ti :${port}`;
  return new Promise((resolve) => {
    const shell = isWindows ? "cmd.exe" : "/bin/sh";
    const shellArgs = isWindows ? ["/c", cmd] : ["-c", cmd];
    const child = spawn(shell, shellArgs, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("close", () => {
      if (!out.trim()) return resolve(null);
      // Windows netstat 最后一列是 PID;POSIX lsof -ti 直接是 PID
      const match = isWindows ? out.match(/\s(\d+)\s*$/) : out.match(/(\d+)/);
      const pid = match ? Number(match[1]) : null;
      resolve(pid);
    });
    child.on("error", () => resolve(null));
  });
}

/** kill 占用端口的进程;无占用静默返回 */
export async function killPort(port: number): Promise<void> {
  const pid = await findPidOnPort(port);
  if (pid == null) return;
  const cmd = isWindows ? `taskkill /PID ${pid} /F` : `kill -9 ${pid}`;
  return new Promise((resolve) => {
    const shell = isWindows ? "cmd.exe" : "/bin/sh";
    const shellArgs = isWindows ? ["/c", cmd] : ["-c", cmd];
    // spawn 失败也需 resolve,否则 promise 永挂 / 抛未捕获错误
    spawn(shell, shellArgs, { stdio: "ignore" })
      .on("close", () => resolve())
      .on("error", () => resolve());
  });
}
