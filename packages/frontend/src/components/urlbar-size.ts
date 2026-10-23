// URL 地址栏宽度契约（BrowserPanel 工具栏）：
// 默认宽度占工具栏一半；用户可经拖拽把手调节并持久化到 localStorage；
// 上限必须为右侧图标按钮区保留固定空间（不能占用 icon 长度），由 urlBarMaxW 计算。
/** localStorage 键：用户拖拽后的地址栏宽度 */
export const URLBAR_WIDTH_KEY = "hiagent.preview.urlbar.width";
/** 最小宽度：保证路径可读的最窄值 */
export const MIN_URLBAR_W = 160;
/** 图标按钮区预留宽度：工具栏右侧一排图标按钮（复制/刷新/选中/三种视图模式/
 *  浮动窗最小化/源码/分享/关闭）+ 间距 + 内边距的实测占用与安全余量 */
export const URLBAR_ICON_RESERVE_PX = 380;

/** 地址栏允许的最大宽度 = 工具栏总宽 − 图标按钮区预留，但不低于最小宽度 */
export function urlBarMaxW(toolbarW: number): number {
	return Math.max(MIN_URLBAR_W, toolbarW - URLBAR_ICON_RESERVE_PX);
}

/** 默认宽度 = 工具栏一半（像素取整），过窄时退到最小宽度 */
export function halfUrlBarW(toolbarW: number): number {
	return Math.max(MIN_URLBAR_W, Math.round(toolbarW / 2));
}

/** 从 localStorage 恢复用户定制的地址栏宽度；
 *  无记录或值非法（低于最小宽度的脏值）→ null，由 CSS 50% 兜底为默认半宽 */
export function loadStoredUrlBarW(): number | null {
	const v = Number(localStorage.getItem(URLBAR_WIDTH_KEY));
	return Number.isFinite(v) && v >= MIN_URLBAR_W ? v : null;
}
