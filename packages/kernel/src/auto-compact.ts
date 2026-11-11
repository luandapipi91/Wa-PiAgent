/**
 * 发送前自动压缩的触发判定。
 *
 * 双条件（满足其一即压缩）：
 * ① 上下文占用超过窗口的 AUTO_COMPACT_USAGE_RATIO（0.8）——保留原「按比例提前量」逻辑。
 * ② 上游钳制后的输出预算低于 MIN_USABLE_OUTPUT_TOKENS（8192）——「几乎无法作答」才压缩。
 *
 * 为什么条件②改口径：pi 请求层（pi-ai 1.5.2）发请求前会用 clampMaxTokensToContext
 * 自行把 max_tokens 钳制到「窗口 - 占用 - 安全余量」内，所以 used + 钳制后预算
 * 永远不会越过窗口、不再溢出（400）。旧的「输入 + 标称输出 + 预留余量越界」判据
 * 因此失效——标称输出再大的模型也不会真的把请求撑爆，只会被上游悄悄削减，
 * 按标称值判断会误触发压缩。真正需要先压缩腾空间的信号是：钳制后几乎没输出空间。
 */
export const AUTO_COMPACT_USAGE_RATIO = 0.8;

/** 旧条件②（输入 + 标称输出 + 预留余量越窗）口径遗留；新口径已不再使用 */
export const AUTO_COMPACT_OUTPUT_RESERVE = 4096;

/** 钳制后输出预算低于该值视为「几乎无法作答」，此时才值得先压缩腾空间 */
export const MIN_USABLE_OUTPUT_TOKENS = 8192;

/** 逐式复刻 pi-ai 1.5.2 dist/api/simple-options.js 的 clampMaxTokensToContext */
export function clampedRequestMaxTokens(
 usedTokens: number,
 contextWindow: number,
 declaredMaxTokens: number,
): number {
 const CONTEXT_SAFETY_TOKENS = 4096;
 const CONTEXT_SAFETY_RATIO = 0.15;
 const MIN_OUTPUT_WITH_RATIO_MARGIN = 32768;
 if (contextWindow <= 0) return Math.max(1, declaredMaxTokens);
 const margin = Math.max(
  CONTEXT_SAFETY_TOKENS,
  Math.ceil(usedTokens * CONTEXT_SAFETY_RATIO),
 );
 let room = contextWindow - usedTokens - margin;
 if (room < MIN_OUTPUT_WITH_RATIO_MARGIN) {
  room = Math.min(MIN_OUTPUT_WITH_RATIO_MARGIN, contextWindow - usedTokens - CONTEXT_SAFETY_TOKENS);
 }
 return Math.min(declaredMaxTokens, Math.max(1, room));
}

/**
 * 发送前是否需要先压缩。
 *
 * @param usedTokens 当前上下文占用（token）
 * @param contextWindow 模型上下文窗口（token）
 * @param maxOutputTokens 本次请求标称的最大输出（token）；未知/非法时条件②跳过
 */
export function shouldCompactBeforeSend(
 usedTokens: number,
 contextWindow: number,
 maxOutputTokens?: number,
): boolean {
 if (contextWindow <= 0) return false;
 // 条件①：占用超窗口比例阈值
 if (usedTokens > contextWindow * AUTO_COMPACT_USAGE_RATIO) return true;
 // 条件②：上游已自行把输出预算钳制进窗口（used + 钳制后不再越窗），
 // 旧的「输入 + 标称输出越界」判据失效；真正要压缩的信号是钳制后几乎没输出空间
 if (typeof maxOutputTokens === "number" && maxOutputTokens > 0) {
  const clamped = clampedRequestMaxTokens(usedTokens, contextWindow, maxOutputTokens);
  if (clamped < Math.min(maxOutputTokens, MIN_USABLE_OUTPUT_TOKENS)) return true;
 }
 return false;
}
