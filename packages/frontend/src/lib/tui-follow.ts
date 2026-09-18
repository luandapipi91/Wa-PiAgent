/**
 * TUI 浮窗帧区的贴底跟随判定（供 TuiPanel 的自动贴底兜底使用）。
 *
 * 背景：帧尾是对话框的选项/确认区（pi-goal-x 等扩展对话框的决策面），正文一长
 * 选项就被推出浮窗首屏。帧刷新时若用户未主动上滚，浮窗贴底跟随保证选项可见；
 * 用户上滚阅读正文时不能被拉回，滚回底部附近后自动恢复跟随。
 */

/**
 * 用户是否已主动滚离帧底部：距底超过 1 行高视为离开（1 行内的微小抖动仍算跟随）。
 * 无滚动空间（内容不足一屏）时恒为「未离开」。
 *
 * @param scrollTop    当前滚动位置（px）
 * @param clientHeight 可视区高度（px）
 * @param scrollHeight 内容总高度（px）
 * @param lineHeight   行高（px），TuiPanel 传 CELL.height；阈值取 1 行——
 *                     帧以整行为单位渲染，小于 1 行的偏差属于渲染抖动而非阅读意图
 */
export function isScrolledAwayFromBottom(
	scrollTop: number,
	clientHeight: number,
	scrollHeight: number,
	lineHeight: number,
): boolean {
	if (scrollHeight <= clientHeight) return false;
	return scrollHeight - (scrollTop + clientHeight) > lineHeight;
}
