// 无控制台 GUI 应用用：写文件日志，带时间戳。append，单行。
// flush() 确保进程退出前所有排队写入落盘（process.exit 前必须 await）。
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface Logger {
  info(msg: string): void;
  error(msg: string, err?: unknown): void;
  /** 等待所有排队写入完成；process.exit 前必须 await，避免截断末尾日志。 */
  flush(): Promise<void>;
}

export function createLogger(logPath: string): Logger {
  // 跟踪所有 in-flight 写入；flush 时 Promise.allSettled 等齐。
  const pending = new Set<Promise<void>>();

  const track = (p: Promise<void>) => {
    pending.add(p);
    p.finally(() => pending.delete(p));
  };

  const write = (level: string, line: string) => {
    const ts = new Date().toISOString();
    track(
      mkdir(dirname(logPath), { recursive: true }).then(
        () => appendFile(logPath, `[${ts}] ${level} ${line}\n`).then(() => {}, () => {}),
        () => {},
      ),
    );
  };

  return {
    info: (msg) => write("INFO", msg),
    error: (msg, err) => write("ERROR", `${msg}${err ? " " + (err instanceof Error ? err.stack : String(err)) : ""}`),
    flush: async () => {
      await Promise.allSettled([...pending]);
    },
  };
}
