// 前端 dev server 就绪探测:按 R 重载 / 首次启动后,不依赖 vite 的 stdout 输出判断就绪。
// 背景:bun run --filter 的输出转发偶发丢输出(2026-09-01 现场取证:vite 正常监听服务
// 但终端零 [web] 输出),依赖 stdout 正则判断就绪会漏开浏览器、漏反馈,表现为"卡死"。

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** 一次探测:能建立 HTTP 连接即视为服务就绪(不校验状态码;连接拒绝/超时=未就绪) */
export async function isFrontendReady(
  port: number,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    // 用 localhost 而非 127.0.0.1:vite 在 macOS 下可能只绑 ::1,fetch 对 localhost 会自动回退 v6/v4
    const res = await fetchImpl(`http://localhost:${port}/`, {
      signal: AbortSignal.timeout(1500),
    });
    // 拿到响应头即算就绪,立即丢弃 body 释放连接
    await res.body?.cancel().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

export interface WaitFrontendReadyOptions {
  timeoutMs?: number;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  /** 每次轮询后回调,入参为已耗时毫秒(调用方用于节流打印进度) */
  onPoll?: (elapsedMs: number) => void;
}

/** 轮询等待前端就绪:就绪返回 true,超时返回 false */
export async function waitFrontendReady(
  port: number,
  opts: WaitFrontendReadyOptions = {},
): Promise<boolean> {
  const {
    timeoutMs = 60_000,
    intervalMs = 500,
    fetchImpl = fetch,
    onPoll,
  } = opts;
  const start = Date.now();
  for (;;) {
    if (await isFrontendReady(port, fetchImpl)) return true;
    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs) return false;
    onPoll?.(elapsed);
    await sleep(intervalMs);
  }
}
