/**
 * 发送前自动压缩的触发阈值：上下文使用率达到 80% 时先压缩再发送。
 *
 * 原实现固定 33000 预留（1M 窗口下 96.7% 才触发），对 pi 的「字符数/4」token 估算
 * 明显偏低、以及模型目录 contextWindow 偏小的场景，直到真实窗口边缘才触发压缩，
 * 而此刻 pi 请求层的 max_tokens 已被顶到模型上限，叠加真实 token 数后越过窗口溢出（400）。
 * 改为按窗口百分比触发，让压缩更早介入，留出足够安全区。
 */
export const AUTO_COMPACT_USAGE_RATIO = 0.8;

/** 发送前是否需要先压缩：当前占用超过窗口的一定比例时触发 */
export function shouldCompactBeforeSend(
 usedTokens: number,
 contextWindow: number,
): boolean {
 if (contextWindow <= 0) return false;
 return usedTokens > contextWindow * AUTO_COMPACT_USAGE_RATIO;
}
