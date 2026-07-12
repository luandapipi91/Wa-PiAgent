// 文件日志（无控制台 GUI 用）。append，带时间戳；flush 等齐 in-flight 写入。
const { appendFile, mkdir } = require("node:fs/promises");
const { dirname } = require("node:path");

function createLogger(logPath) {
  const pending = new Set();
  const write = (level, line) => {
    const ts = new Date().toISOString();
    const p = mkdir(dirname(logPath), { recursive: true })
      .then(() => appendFile(logPath, `[${ts}] ${level} ${line}\n`))
      .catch(() => {});
    pending.add(p);
    p.finally(() => pending.delete(p));
  };
  return {
    info: (m) => write("INFO", m),
    error: (m, err) => write("ERROR", `${m}${err ? " " + (err instanceof Error ? err.stack : String(err)) : ""}`),
    flush: () => Promise.allSettled([...pending]).then(() => {}),
  };
}
module.exports = { createLogger };
