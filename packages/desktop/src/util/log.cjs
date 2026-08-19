// 文件日志（无控制台 GUI 用）。append，带时间戳；flush 等齐 in-flight 写入。
// 容量上限：超过 maxBytes 时做 FIFO 裁剪——丢弃最旧的行，只保留最新 keepBytes
// （留缓冲避免每次写都裁剪），按换行对齐避免半截行。
// 磁盘兼容：实际上限随磁盘剩余空间自适应——effectiveMax = min(maxBytes,
// max(maxBytes * 10%, 剩余空间 * 1%))。小磁盘机器上 10MB 日志也可能过多，
// 故剩余空间紧张时上限自动收紧（最低为 maxBytes 的 10%）；statfs 不可用时按 maxBytes 处理。
const { appendFile, mkdir, readFile, stat, statfs, writeFile } = require("node:fs/promises");
const { dirname } = require("node:path");

const MAX_BYTES = 10 * 1024 * 1024;
const KEEP_BYTES = 8 * 1024 * 1024;
const MIN_FLOOR_RATIO = 0.1; // 自适应下限：磁盘再紧也保留 maxBytes 的 10%（默认即 1MB）
const FREE_SPACE_RATIO = 0.01; // 日志最多占剩余空间的 1%
const FREE_SPACE_TTL_MS = 60_000; // statfs 结果缓存 60s，免每行日志多一次系统调用

/** 由剩余空间计算有效上限/保留量（纯函数，便于单测）。 */
function resolveEffectiveLimits(maxBytes, keepBytes, freeBytes) {
  if (!Number.isFinite(freeBytes) || freeBytes < 0) return { max: maxBytes, keep: keepBytes };
  const floor = Math.floor(maxBytes * MIN_FLOOR_RATIO);
  const max = Math.max(floor, Math.min(maxBytes, Math.floor(freeBytes * FREE_SPACE_RATIO)));
  return { max, keep: Math.min(keepBytes, Math.floor(max * 0.8)) };
}

// 默认取日志所在盘的剩余空间；statfs 不支持/失败时返回 Infinity（按 maxBytes 处理）
async function defaultGetFreeBytes(logPath) {
  try {
    const s = await statfs(dirname(logPath));
    return s.bavail * s.bsize;
  } catch {
    return Infinity;
  }
}

function createLogger(logPath, maxBytes = MAX_BYTES, keepBytes = KEEP_BYTES, getFreeBytes = defaultGetFreeBytes) {
  // 所有文件操作串行化（trim 读改写不能与 append 并发）；chain 的 resolve 值是
  // 当前日志文件估算大小（null = 尚未从磁盘 stat 初始化）。
  let chain = Promise.resolve(null);
  let freeCache = { at: 0, bytes: Infinity };
  const freeBytes = async () => {
    if (Date.now() - freeCache.at < FREE_SPACE_TTL_MS) return freeCache.bytes;
    const bytes = await getFreeBytes(logPath);
    freeCache = { at: Date.now(), bytes };
    return bytes;
  };
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
        const limit = resolveEffectiveLimits(maxBytes, keepBytes, await freeBytes());
        if (size + bytes > limit.max) {
          // FIFO：丢最旧部分，保留最新 keep，对齐到行首避免半截行
          try {
            const buf = await readFile(logPath);
            let start = Math.max(0, buf.length - (limit.keep - bytes));
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
module.exports = { createLogger, resolveEffectiveLimits, MAX_BYTES, KEEP_BYTES, MIN_FLOOR_RATIO, FREE_SPACE_RATIO };
