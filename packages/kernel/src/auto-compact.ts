/**
 * 发送前自动压缩的预留 token 数。
 * 采用社区做法（Claude Code 固定 33K autocompact buffer，200K 窗口占 16.5%、1M 窗口占 3.3%），
 * 与 pi DEFAULT_COMPACTION_SETTINGS.reserveTokens（16384）同量级。
 * pi-ai 请求层已把 max_tokens clamp 到「窗口 − 当前占用 − 4096」，输出空间由 pi 保证，
 * 这里只需固定小预留做发送前提前量，不能按模型 maxTokens 上限预留（会把 1M 窗口提前到 61.6% 就压缩）。
 */
export const AUTO_COMPACT_RESERVE_TOKENS = 33000;

/** 发送前是否需要先压缩：当前占用 + 固定预留超过上下文窗口 */
export function shouldCompactBeforeSend(
	usedTokens: number,
	contextWindow: number,
): boolean {
	return usedTokens > contextWindow - AUTO_COMPACT_RESERVE_TOKENS;
}
