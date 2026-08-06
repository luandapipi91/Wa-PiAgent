/** IM 会话历史截取：最多展示末尾 max 条；未传 max 原样返回 */
export function sliceHistory<T>(messages: T[], max?: number): T[] {
	if (!max || messages.length <= max) return messages;
	return messages.slice(-max);
}
