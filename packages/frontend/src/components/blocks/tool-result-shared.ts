// 工具返回结果渲染的共享件：ToolResultTextView（通用工具）与 McpResultView（mcp__ 前缀）
// 的公共底层——JSON 探测纯函数 + 结果块样式常量。只放两组件确实同款的重复；
// 场景性差异（MCP 的摘要条/延迟展开/tokenize 高亮，通用视图的字段行/长文本折叠）
// 留在各自组件内，不在此层造抽象。

/**
 * JSON 探测：trim 后 parse，成功且为 object/array 返回数据；
 * 顶层标量 / 非 JSON / 畸形截断 / null → null（调用方降级原文渲染）。
 * 两组件共用一份判定，避免内联 try/catch 各写各的。
 */
export function parseResultJson(text: string): object | null {
	const trimmed = text.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			const data: unknown = JSON.parse(trimmed);
			if (data && typeof data === "object") return data;
		} catch {
			/* 畸形/截断 JSON：降级原文 */
		}
	}
	return null;
}

/** 结果区限高滚动：超长内容避免一张卡片铺满整屏（两组件同款） */
export const RESULT_MAX_H = "max-h-[360px] overflow-auto";

/** 内容区限高数字（px）：read 正文展开/shell 终端输出的 inline maxHeight 同款值。
 *  与 RESULT_MAX_H 的差异是形式：这两处需配合动态滚动切换/终端仿真，用数字而非 Tailwind 类。 */
export const RESULT_CLIP_PX = 300;

/** 结果区标准等宽+字号：font-mono + 11px 随缩放（read 正文容器/shell 输出区同款） */
export const RESULT_MONO_FONT_CLS =
	"font-mono text-[calc(11px*var(--font-scale))]";

/** 真实换行保留两件套（无字号/等宽）：换行语义与字体解耦——字号不同的场景
 *  （如 codemode console 的 text-xs 次要信息档）只取换行部分，不硬套 11px 单一值 */
export const RESULT_MONO_WRAP_CLS = "whitespace-pre-wrap break-words";

/** 等宽结果块基座：换行两件套 + 标准等宽字号 + m-0；背景/圆角/内边距/配色由调用方按场景组合
 *  （通用视图自含 surface 底独立块，MCP 视图嵌在带边框容器里由容器供底） */
export const RESULT_MONO_BASE_CLS = `${RESULT_MONO_WRAP_CLS} ${RESULT_MONO_FONT_CLS} m-0`;

/** 全宽条状展开/收起按钮：长文本块下方的 toggle 形态（ReadContentView 同款） */
export const RESULT_TOGGLE_BAR_CLS =
	"w-full text-center text-[calc(11px*var(--font-scale))] text-secondary hover:text-primary py-1 border-t border-dashed border-hairline bg-surface-elevated transition-colors";

/** 结果区小文字按钮基座：去浏览器默认样式的公共部分；颜色/布局类由调用方按语义组合 */
export const RESULT_BTN_BASE_CLS =
	"cursor-pointer border-none bg-transparent transition-colors text-[calc(11px*var(--font-scale))]";

/** 展开收起渲染的公共类型：json 带解析数据，text 原样降级 */
export type ParsedResultView =
	| { kind: "json"; data: object }
	| { kind: "text"; data?: undefined };
