/**
 * 发送前自动压缩的触发判定。
 *
 * 双条件（满足其一即压缩）：
 * ① 上下文占用超过窗口的 AUTO_COMPACT_USAGE_RATIO（0.8）——保留原「按比例提前量」逻辑。
 * ② 输入占用 + 本次请求的最大输出（maxOutputTokens）+ 预留余量 已越过窗口。
 *
 * 为什么加条件②：pi 请求层的 max_tokens 取模型上限，若输入占用已贴近窗口、再叠加
 * 这次输出预算就会越过上游窗口边界溢出（400）。条件①对「窗口大但 max_tokens 也大」
 * 的模型不够：占用没到 80%，但输出预算叠加后就超窗口了。
 */
export const AUTO_COMPACT_USAGE_RATIO = 0.8;

/** 条件②的预留余量（token）：输入 + 输出预算之外的额外安全区 */
export const AUTO_COMPACT_OUTPUT_RESERVE = 4096;

/**
 * 发送前是否需要先压缩。
 *
 * @param usedTokens 当前上下文占用（token）
 * @param contextWindow 模型上下文窗口（token）
 * @param maxOutputTokens 本次请求的最大输出（token）；未知/非法时条件②跳过
 */
export function shouldCompactBeforeSend(
 usedTokens: number,
 contextWindow: number,
 maxOutputTokens?: number,
): boolean {
 if (contextWindow <= 0) return false;
 // 条件①：占用超窗口比例阈值
 if (usedTokens > contextWindow * AUTO_COMPACT_USAGE_RATIO) return true;
 // 条件②：输入 + 最大输出 + 预留余量 将越过窗口
 if (
  typeof maxOutputTokens === "number" &&
  maxOutputTokens > 0 &&
  usedTokens + maxOutputTokens + AUTO_COMPACT_OUTPUT_RESERVE > contextWindow
 ) {
  return true;
 }
 return false;
}
