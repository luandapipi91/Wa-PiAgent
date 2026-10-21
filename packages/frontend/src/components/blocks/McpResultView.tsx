// MCP 工具（mcp__ 前缀）结果的重新设计渲染——变体 C「摘要优先式」（用户拍板）。
//
// 改造前：result.content 的 text 经 Linkify 裸平铺——大 JSON 无格式、无高亮、无限高，
// pi 的截断警告原文（"Warning: truncated output (…) Total output lines: …"）混在正文里。
//
// 现在（摘要优先）：
//   1. 截断前缀解析为警告条（warning-soft 底），不再混入正文；
//   2. JSON.parse 成功 → 默认**收起**，只显示结构摘要（条数 + 前几条主题/字段名），
//      「展开 JSON」点击后才格式化高亮渲染（延迟计算，大 JSON 不展开不付渲染成本）；
//   3. 解析失败（截断畸形）或纯文本 → 无摘要条，行号原文块直接展示；
//   4. 展开区：类型徽标 + 行数 + 复制（复制含截断前缀的原始全文）+ 限高 360px 滚动 +
//      格式化后超 500 行折叠为「剩余提示」（DOM 规模可控）。
//   5. 失败结果整块 danger 色；主题自适应（CSS 变量，暗/亮色通用）。
import { useMemo, useState } from "react";
import type { ToolResultMessage } from "@wa-pi/shared";
import { useTranslation } from "../../i18n/useTranslation";

/** pi 截断输出前缀（dist 内 truncated 输出固定格式） */
const TRUNCATED_RE =
	/^Warning: truncated output \(original token count: (\d+)\) Total output lines: (\d+)\s*/;

/** 格式化后最多渲染的行数：超出部分折叠为提示（完整内容走复制） */
const MAX_RENDER_LINES = 500;

/** 摘要里最多列的主题条数 */
const SUMMARY_ITEM_LIMIT = 3;

/** 结果区限高：超出滚动（避免一张卡片铺满整屏） */
const MAX_HEIGHT_CLS = "max-h-[360px] overflow-auto";

/** JSON token 着色的轻量正则：字符串（含转义）/ bool / null / 数字。
 *  每行独立处理——stringify(v, null, 2) 保证字符串不跨行。 */
const TOKEN_RE =
	/("(?:\\.|[^"\\])*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

type Tok = { kind: "key" | "str" | "bool" | "num" | "plain"; text: string };

/** 把一行 JSON 文本切成着色 token（key=后跟冒号的字符串） */
function tokenizeLine(line: string): Tok[] {
	const out: Tok[] = [];
	let last = 0;
	for (const m of line.matchAll(TOKEN_RE)) {
		const idx = m.index ?? 0;
		if (idx > last) out.push({ kind: "plain", text: line.slice(last, idx) });
		if (m[1] !== undefined) {
			out.push({ kind: m[2] ? "key" : "str", text: m[1] + (m[2] ?? "") });
		} else if (/^(true|false|null)$/.test(m[0])) {
			out.push({ kind: "bool", text: m[0] });
		} else {
			out.push({ kind: "num", text: m[0] });
		}
		last = idx + m[0].length;
	}
	if (last < line.length) out.push({ kind: "plain", text: line.slice(last) });
	return out;
}

const TOK_CLS: Record<Tok["kind"], string> = {
	key: "text-[var(--accent)]",
	str: "text-primary",
	bool: "text-tertiary",
	num: "text-[var(--warning)]",
	plain: "text-tertiary",
};

function TokenLine({ line }: { line: string }) {
	const toks = useMemo(() => tokenizeLine(line), [line]);
	return (
		<>
			{toks.map((t, i) => (
				<span
					key={i}
					data-tok={t.kind === "plain" ? undefined : t.kind}
					className={TOK_CLS[t.kind]}
				>
					{t.text}
				</span>
			))}
		</>
	);
}

/** 拼合 result 的全部 text 块（MCP 结果可能拆多段 content） */
function joinTexts(result: ToolResultMessage): string {
	return (result.content ?? [])
		.map((c: any) => (c?.type === "text" ? c.text : ""))
		.filter((s: string) => s !== "")
		.join("\n");
}

/** 结构摘要：条数 + 主题列表（或对象字段名列表） */
interface SummaryInfo {
	/** 顶层集合条数（无集合时为字段数） */
	count: number;
	/** 服务端声明的总数（total/count/totalCount 字段）优先于本地条数 */
	declaredTotal: number | null;
	/** 集合元素的主题文本（前 N 条；字符串数组直接用元素值） */
	titles: string[];
	/** 对象（无集合）时的字段名列表（前若干个） */
	objKeys: string[];
}

/** 语义标题字段优先级：第一个命中的字符串值作为该条的主题 */
const TITLE_FIELDS = ["subject", "title", "name", "message", "summary", "id"];
/** 常见的集合包装字段（云效 items / 通用 data·list 等） */
const WRAPPER_FIELDS = ["items", "data", "list", "records", "results", "rows"];
/** 服务端总数声明字段 */
const TOTAL_FIELDS = ["total", "count", "totalCount"];

function itemTitle(item: unknown): string | null {
	if (typeof item === "string") return item;
	if (item && typeof item === "object") {
		for (const f of TITLE_FIELDS) {
			const v = (item as Record<string, unknown>)[f];
			if (typeof v === "string" && v.trim()) return v.trim();
		}
	}
	return null;
}

function extractSummary(data: unknown): SummaryInfo {
	if (Array.isArray(data)) {
		return {
			count: data.length,
			declaredTotal: null,
			titles: data
				.map(itemTitle)
				.filter((s): s is string => !!s)
				.slice(0, SUMMARY_ITEM_LIMIT),
			objKeys: [],
		};
	}
	if (data && typeof data === "object") {
		const obj = data as Record<string, unknown>;
		for (const f of WRAPPER_FIELDS) {
			const arr = obj[f];
			if (Array.isArray(arr)) {
				let declaredTotal: number | null = null;
				for (const tf of TOTAL_FIELDS) {
					const v = obj[tf];
					if (typeof v === "number" && Number.isFinite(v)) {
						declaredTotal = v;
						break;
					}
				}
				return {
					count: arr.length,
					declaredTotal,
					titles: arr
						.map(itemTitle)
						.filter((s): s is string => !!s)
						.slice(0, SUMMARY_ITEM_LIMIT),
					objKeys: [],
				};
			}
		}
		// 无集合的对象：字段名列表
		return {
			count: Object.keys(obj).length,
			declaredTotal: null,
			titles: [],
			objKeys: Object.keys(obj).slice(0, 5),
		};
	}
	// 标量（数字/布尔/字符串顶层）
	return { count: 0, declaredTotal: null, titles: [], objKeys: [] };
}

/** MCP 结果视图（变体 C）：截断警告条 + 结构摘要（默认收起）+ 展开后的高亮 JSON。 */
export function McpResultView({
	result,
	failed,
}: {
	result: ToolResultMessage;
	failed: boolean;
}) {
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState(false);
	const [copied, setCopied] = useState(false);

	const { truncatedTokens, truncatedLines, body } = useMemo(() => {
		const raw = joinTexts(result);
		const m = raw.match(TRUNCATED_RE);
		if (!m) return { truncatedTokens: null, truncatedLines: null, body: raw };
		return {
			truncatedTokens: Number(m[1]),
			truncatedLines: Number(m[2]),
			body: raw.slice(m[0].length),
		};
	}, [result]);

	// JSON 探测：成功留 data（摘要 + 展开共用），失败降级原文
	const parsed = useMemo(() => {
		const trimmed = body.trim();
		if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
			try {
				return { kind: "json" as const, data: JSON.parse(trimmed) };
			} catch {
				/* 截断/畸形 JSON：按原文渲染 */
			}
		}
		return { kind: "text" as const, data: undefined };
	}, [body]);

	const summary = useMemo(
		() => (parsed.kind === "json" ? extractSummary(parsed.data) : null),
		[parsed],
	);

	// 展开时才格式化（大 JSON 不展开不付 stringify/tokenize 成本）
	const formattedText = useMemo(() => {
		if (parsed.kind === "json") {
			return expanded
				? JSON.stringify(parsed.data, null, 2)
				: "";
		}
		return body;
	}, [parsed, expanded, body]);

	const allLines = useMemo(
		() => (formattedText === "" ? [] : formattedText.split("\n")),
		[formattedText],
	);
	const shownLines = useMemo(
		() => allLines.slice(0, MAX_RENDER_LINES),
		[allLines],
	);
	const restCount = allLines.length - shownLines.length;

	const copyFull = () => {
		const raw = joinTexts(result);
		void navigator.clipboard?.writeText(raw).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	};

	const summaryCount =
		summary?.declaredTotal ?? (summary ? summary.count : 0);

	return (
		<div className="mt-1">
			{truncatedTokens !== null && truncatedLines !== null && (
				<div
					data-testid="mcp-result-truncated"
					className="inline-flex items-center gap-1.5 rounded px-2 py-0.5 mb-1 text-[calc(11px*var(--font-scale))] flex-wrap"
					style={{ background: "var(--warning-soft)", color: "var(--warning)" }}
				>
					<span className="font-semibold">
						{t("blocks.toolCall.mcpTruncatedLabel")}
					</span>
					<span>
						{t("blocks.toolCall.mcpOriginalTokens", {
							tokens: truncatedTokens.toLocaleString("en-US"),
						})}
					</span>
					<span>
						{t("blocks.toolCall.mcpTotalLines", {
							lines: truncatedLines.toLocaleString("en-US"),
						})}
					</span>
				</div>
			)}

			{/* 摘要条：仅 JSON 成功解析时显示；默认收起，展开后让位给完整视图 */}
			{parsed.kind === "json" && !expanded && summary && (
				<div
					data-testid="mcp-result-summary"
					className="flex items-center gap-2 flex-wrap rounded-md border border-hairline px-2.5 py-1.5 text-[calc(12px*var(--font-scale))]"
					style={{ background: "var(--code-bg, var(--surface-elevated))" }}
				>
					<span
						className="font-mono font-semibold text-[calc(12px*var(--font-scale))]"
						style={{ color: "var(--accent)" }}
						data-testid="mcp-result-count"
					>
						{summaryCount.toLocaleString("en-US")}
					</span>
					<span className="text-secondary">
						{summary.objKeys.length > 0
							? t("blocks.toolCall.mcpFieldsCount", {
									count: summary.count,
								})
							: t("blocks.toolCall.mcpItemsCount")}
					</span>
					{summary.titles.length > 0 && (
						<span
							className="text-tertiary min-w-0 truncate"
							data-testid="mcp-result-titles"
						>
							{summary.titles.join(" · ")}
							{(summary.declaredTotal ?? summary.count) > SUMMARY_ITEM_LIMIT ||
							summary.titles.length < Math.min(summary.count, SUMMARY_ITEM_LIMIT)
								? " …"
								: ""}
						</span>
					)}
					{summary.objKeys.length > 0 && (
						<span
							className="text-tertiary font-mono min-w-0 truncate"
							data-testid="mcp-result-objkeys"
						>
							{summary.objKeys.join(", ")}
							{summary.count > summary.objKeys.length ? ", …" : ""}
						</span>
					)}
					<button
						type="button"
						data-testid="mcp-result-expand"
						onClick={() => setExpanded(true)}
						className="ml-auto text-[calc(11px*var(--font-scale))] flex-shrink-0 rounded px-2 py-0.5 transition-colors"
						style={{
							color: "var(--accent)",
							background: "none",
							border: "none",
							cursor: "pointer",
						}}
						onMouseEnter={(e) =>
							(e.currentTarget.style.background = "var(--accent-soft)")
						}
						onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
					>
						{t("blocks.toolCall.mcpExpand")} ▾
					</button>
				</div>
			)}

			{/* 展开区：JSON 高亮 / 文本原文 + 徽标 + 行数 + 复制 + 限高滚动 */}
			{(parsed.kind !== "json" || expanded) && (
					<div
						className="rounded-md border border-hairline overflow-hidden"
						style={{ background: "var(--code-bg, var(--surface-elevated))" }}
					>
						{expanded && (
							<div className="flex items-center gap-2 px-2.5 py-1 border-b border-hairline">
								<span
									data-testid="mcp-result-kind"
									className="inline-flex items-center rounded-full px-1.5 py-px text-[calc(10px*var(--font-scale))] font-semibold tracking-wide"
									style={
										parsed.kind === "json"
											? {
													background: "var(--accent-soft)",
													color: "var(--accent)",
												}
											: {
													background: "var(--surface-hover)",
													color: "var(--text-tertiary)",
												}
									}
								>
									{parsed.kind === "json"
										? t("blocks.toolCall.mcpJson")
										: t("blocks.toolCall.mcpText")}
								</span>
								<span className="text-[calc(11px*var(--font-scale))] text-tertiary font-mono">
									{allLines.length.toLocaleString("en-US")}
								</span>
								{parsed.kind === "json" && (
									<button
										type="button"
										data-testid="mcp-result-collapse"
										onClick={() => setExpanded(false)}
										className="text-[calc(11px*var(--font-scale))] text-tertiary hover:text-[var(--brand)] transition-colors"
										style={{
											cursor: "pointer",
											background: "none",
											border: "none",
											padding: "0 2px",
										}}
									>
										{t("blocks.toolCall.mcpCollapse")} ▴
									</button>
								)}
								<button
									type="button"
									data-testid="mcp-result-copy"
									onClick={copyFull}
									className="ml-auto text-[calc(11px*var(--font-scale))] text-tertiary hover:text-[var(--brand)] transition-colors"
									style={{
										cursor: "pointer",
										background: "none",
										border: "none",
										padding: "0 2px",
									}}
								>
									{copied
										? t("blocks.toolCall.mcpCopied")
										: t("blocks.toolCall.mcpCopy")}
								</button>
							</div>
						)}
						<pre
							data-testid="mcp-result-code"
							data-failed={failed || undefined}
							className={`${MAX_HEIGHT_CLS} m-0 p-2 font-mono text-[calc(11px*var(--font-scale))] leading-relaxed ${
								failed ? "text-[var(--danger)]" : "text-primary"
							}`}
						>
							{shownLines.map((line, i) => (
								<div key={i} data-line={i} className="flex min-w-0">
									<span className="inline-block w-9 text-right mr-2.5 text-tertiary select-none flex-shrink-0">
										{i + 1}
									</span>
									<span className="whitespace-pre-wrap break-all min-w-0">
										{parsed.kind === "json" ? (
											<TokenLine line={line} />
										) : (
											line || "\u00A0"
										)}
									</span>
								</div>
							))}
						</pre>
						{restCount > 0 && (
							<div
								data-testid="mcp-result-more"
								className="px-2.5 py-1 border-t border-hairline text-[calc(11px*var(--font-scale))] text-tertiary"
							>
								{t("blocks.toolCall.mcpMoreLines", {
									count: restCount.toLocaleString("en-US"),
								})}
							</div>
						)}
					</div>
				)}
		</div>
	);
}
