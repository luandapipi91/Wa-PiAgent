// 文件日志（无控制台 GUI 用）。append，带时间戳；flush 等齐 in-flight 写入。
// 容量上限：超过 maxBytes（默认 5MB）时做 FIFO 裁剪——丢弃最旧的行，只保留最新
// keepBytes（默认 4MB，留缓冲避免每次写都裁剪），按换行对齐避免半截行。
const { appendFile, mkdir, readFile, stat, writeFile } = require("node:fs/promises");
const { dirname } = require("node:path");

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_BYTES = 4 * 1024 * 1024;

function createLogger(logPath, maxBytes = MAX_BYTES, keepBytes = KEEP_BYTES) {
  // 所有文件操作串行化（trim 读改写不能与 append 并发）；chain 的 resolve 值是
  // 当前日志文件估算大小（null = 尚未从磁盘 stat 初始化）。
  let chain = Promise.resolve(null);
  const write = (level, line) => {
    const ts = new Date().toISOString();
    const text = `[${ts}] ${level} ${line}\n`;
    const bytes = Buffer.byteLength(text);
    chain = chain
      .then(async (size) => {
        await mkdir(dirname(logPath), { recursive: true });
        if (size === null) {
          size = await stat(logPath)
            .then((s) => s.size)
            .catch(() => 0);
        }
        if (size + bytes > maxBytes) {
          // FIFO：丢最旧部分，保留最新 keepBytes，对齐到行首避免半截行
          try {
            const buf = await readFile(logPath);
            let start = Math.max(0, buf.length - (keepBytes - bytes));
            const nl = buf.indexOf(0x0a, start);
            if (nl !== -1 && nl + 1 < buf.length) start = nl + 1;
            await writeFile(logPath, buf.subarray(start));
            size = buf.length - start;
          } catch {
            size = 0;
          }
        }
        await appendFile(logPath, text);
        return size + bytes;
      })
      .catch(() => 0);
  };
  return {
    info: (m) => write("INFO", m),
    error: (m, err) => write("ERROR", `${m}${err ? " " + (err instanceof Error ? err.stack : String(err)) : ""}`),
    flush: () => chain.then(() => {}),
  };
}
module.exports = { createLogger, MAX_BYTES, KEEP_BYTES };
