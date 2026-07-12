// 无控制台 GUI 应用用：写文件日志，带时间戳。append，单行。
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface Logger { info(msg: string): void; error(msg: string, err?: unknown): void; }

export function createLogger(logPath: string): Logger {
  const write = (level: string, line: string) => {
    const ts = new Date().toISOString();
    mkdir(dirname(logPath), { recursive: true }).then(
      () => appendFile(logPath, `[${ts}] ${level} ${line}\n`).catch(() => {}),
      () => {},
    );
  };
  return {
    info: (msg) => write("INFO", msg),
    error: (msg, err) => write("ERROR", `${msg}${err ? " " + (err instanceof Error ? err.stack : String(err)) : ""}`),
  };
}
