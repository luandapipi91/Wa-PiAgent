// 工具返回文本美化渲染：browser_navigate / browser_snapshot 等工具的返回体
// 是单行 JSON 原文（snapshot 的换行是字面量 \n 转义序列），旧渲染经 Linkify
// 平铺在 span 里——空白折叠成一行、树形缩进丢失、整体一坨绿字无法阅读。
//
// 现在：
//   1. JSON.parse 成功且为 object/array → 结构化展示：简单字段逐行 `字段: 值`；
//      长文本字段（含换行的 string，如 snapshot）单独渲染为等宽块——parse 后
//      \n 已转真实换行，whitespace-pre-wrap 保留前导空格，树形缩进可见；
//   2. 解析失败（普通文本 / 畸形截断 JSON）→ 原样 whitespace-pre-wrap 渲染，
//      多行文本天然可读，畸形 JSON 不抛错不白屏；
//   3. 长文本块超 8 行默认收起只显示前 8 行，展开/收起按钮复用 ReadContentView
//      同款样式与文案（readExpandMore / readCollapse）。
// JSON 探测 / 限高 / 按钮样式与 McpResultView 共用 tool-result-shared。
import { memo, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "../../i18n/useTranslation";
import {
	parseResultJson,
	RESULT_MAX_H,
	RESULT_MONO_BASE_CLS,
	RESULT_TOGGLE_BAR_CLS,
} from "./tool-result-shared";

/** 长文本块默认预览行数：收起时只显示前几行 */
const PREVIEW_LINES = 8;

/** 长文本块样式：共享等宽基座 + 自含独立块的差异部分（surface 底/圆角/内边距/次级色） */
const LONG_TEXT_CLS = `${RESULT_MONO_BASE_CLS} my-1 rounded bg-surface px-2 py-1 leading-[1.6] text-secondary`;

/** 解析分类：JSON object/array → 结构化；顶层标量 / 非 JSON / 畸形截断 → 原样文本 */
export function parseToolResultText(
	text: string,
): { kind: "json"; data: object } | { kind: "text" } {
	const data = parseResultJson(text);
	return data !== null ? { kind: "json", data } : { kind: "text" };
}

/** 长文本字段块：保留真实换行与前导空格；超 PREVIEW_LINES 行默认收起可展开 */
const LongTextBlock = memo(function LongTextBlock({ text }: { text: string }) {
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState(false);
	// 兼容 \r\n（部分工具返回体为 CRLF），避免行尾残留 \r 在 pre-wrap 下被当换行渲染为双换行；
	// text 不变时不重复 split（大 snapshot 可能几百 KB）
	const lines = useMemo(() => text.split(/\r?\n/), [text]);
	if (lines.length <= PREVIEW_LINES) {
		return (
			<pre data-testid="tool-result-longtext" className={LONG_TEXT_CLS}>
				{text}
			</pre>
		);
	}
	if (!expanded) {
		return (
			<div>
				<pre data-testid="tool-result-longtext" className={LONG_TEXT_CLS}>
					{lines.slice(0, PREVIEW_LINES).join("\n")}
				</pre>
				<button
					type="button"
					data-testid="tool-result-expand"
					onClick={() => setExpanded(true)}
					className={RESULT_TOGGLE_BAR_CLS}
				>
					{t("blocks.toolCall.readExpandMore", {
						n: lines.length - PREVIEW_LINES,
					})}
				</button>
			</div>
		);
	}
	return (
		<div>
			<pre
				data-testid="tool-result-longtext"
				className={`${LONG_TEXT_CLS} ${RESULT_MAX_H}`}
			>
				{text}
			</pre>
			<button
				type="button"
				data-testid="tool-result-collapse"
				onClick={() => setExpanded(false)}
				className={RESULT_TOGGLE_BAR_CLS}
			>
				{t("blocks.toolCall.readCollapse")}
			</button>
		</div>
	);
});

/** 字段值渲染：含换行的字符串 → 长文本块；标量直接展示；嵌套对象/数组紧凑 JSON 兜底 */
function FieldValue({ v }: { v: unknown }): ReactNode {
	if (typeof v === "string") {
		if (v.includes("\n")) return <LongTextBlock text={v} />;
		return <span className="text-secondary">{v}</span>;
	}
	if (typeof v === "number" || typeof v === "boolean") {
		return <span className="text-secondary">{String(v)}</span>;
	}
	if (v === null || v === undefined) {
		return <span className="text-tertiary">null</span>;
	}
	return <span className="text-secondary">{JSON.stringify(v)}</span>;
}

/** 工具返回文本美化渲染：JSON 结构化 / 非 JSON 原样（颜色继承外层成功/失败 tone） */
// memo：props 只有 text，ToolCallCard streaming 更新 / 父级折叠切换重渲染时跳过重复 parse
export const ToolResultText = memo(function ToolResultText({ text }: { text: string }) {
	// text 不变时不重复 parse（browser_snapshot 返回体可能几百 KB）
	const parsed = useMemo(() => parseToolResultText(text), [text]);
	if (parsed.kind === "text") {
		return (
			<pre className={`${RESULT_MONO_BASE_CLS} leading-[1.6]`}>{text}</pre>
		);
	}
	return (
		<div>
			{Object.entries(parsed.data).map(([k, v]) => (
				<div key={k} className="min-w-0">
					<span className="font-mono text-tertiary">{k}:</span>{" "}
					<FieldValue v={v} />
				</div>
			))}
		</div>
	);
});
