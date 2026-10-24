import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../../i18n/useTranslation";

/** 默认只展示的预览行数：先看 6 行，按需展开其余 */
const PREVIEW_LINES = 6;
/** 展开后内容区最大高度（超出纵向滚动，避免长文件撑爆消息流） */
const MAX_HEIGHT = 300;

export interface ReadResultView {
	lines: string[];
	/** 1-indexed：第一行在文件中的真实行号（来自 args.offset） */
	startLine: number;
	/** 截断信息：已显示行数 / 文件总行数；无截断时为 null */
	truncation: { shown: number; total: number } | null;
	/** 无法归类的提示（如首行超限），单独展示 */
	notice: string | null;
}

// pi read 工具在正文末尾追加的提示（见 pi-coding-agent core/tools/read.js）
const SHOWING_RE = /^\[Showing lines (\d+)-(\d+) of (\d+)[^\]]*\]$/;
const MORE_RE = /^\[(\d+) more lines in file\.[^\]]*\]$/;
const FIRST_LINE_RE = /^\[Line \d+ is [^\]]*exceeds[^\]]*\]$/;

/** 解析 read 结果：剥离尾部提示、算真实行号起点与截断信息。
 *  正文提示是纯文本约定，解析失败时原样保留（不吞内容）。 */
export function parseReadResult(
	content: Array<{ type?: string; text?: string }> | undefined,
	args: Record<string, unknown>,
	details?: Record<string, unknown> | null,
): ReadResultView {
	const text = (content ?? [])
		.filter((c) => c?.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string)
		.join("\n");
	const startLine =
		typeof args.offset === "number" && args.offset > 0 ? args.offset : 1;
	if (!text.trim()) {
		return { lines: [], startLine, truncation: null, notice: null };
	}

	const rows = text.split("\n");
	let end = rows.length;
	while (end > 0 && rows[end - 1] === "") end--;

	let notice: string | null = null;
	let truncation: { shown: number; total: number } | null = null;
	let pendingMore: number | null = null;

	// 尾部最多两段提示（提示行 + 它前面的空行）
	for (let guard = 0; guard < 2 && end > 0; guard++) {
		const last = rows[end - 1].trim();
		const showing = last.match(SHOWING_RE);
		if (showing) {
			truncation = {
				shown: Number(showing[2]) - Number(showing[1]) + 1,
				total: Number(showing[3]),
			};
			end--;
			while (end > 0 && rows[end - 1] === "") end--;
			continue;
		}
		const more = last.match(MORE_RE);
		if (more) {
			pendingMore = Number(more[1]);
			end--;
			while (end > 0 && rows[end - 1] === "") end--;
			continue;
		}
		if (FIRST_LINE_RE.test(last)) {
			notice = last;
			end--;
			break;
		}
		break;
	}

	const lines = rows.slice(0, end);
	if (pendingMore != null) {
		truncation = { shown: lines.length, total: lines.length + pendingMore };
	}

	// details.truncation 是最权威的来源（outputLines / totalLines）
	const t = details?.truncation as
		| { outputLines?: number; totalLines?: number }
		| undefined;
	if (
		t &&
		typeof t.outputLines === "number" &&
		typeof t.totalLines === "number"
	) {
		truncation = { shown: t.outputLines, total: t.totalLines };
	}

	return { lines, startLine, truncation, notice };
}

/** read 内容视图：默认 6 行预览（底部渐隐 + 展开按钮），展开后限高滚动。
 *  followTail（流式写入中）：全量渲染并自动滚到底，让用户看到最新写入的内容。 */
export function ReadContentView({
	view,
	testId,
	followTail,
}: {
	view: ReadResultView;
	testId?: string;
	/** 流式写入中：显示全部内容并跟随底部 */
	followTail?: boolean;
}) {
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState(false);
	const { lines, startLine, truncation, notice } = view;
	const scrollRef = useRef<HTMLDivElement>(null);
	const stickRef = useRef(true);
	const prevTextRef = useRef<string | null>(null);
	const contentText = lines.join("\n");

	// 流式跟随：内容增长时若用户停在底部则滚到底；首次挂载不抢滚动
	useEffect(() => {
		const el = scrollRef.current;
		if (!el || !followTail) return;
		if (prevTextRef.current === null) {
			prevTextRef.current = contentText;
			return;
		}
		prevTextRef.current = contentText;
		if (stickRef.current) el.scrollTop = el.scrollHeight;
	}, [contentText, followTail]);

	if (lines.length === 0 && !notice) return null;

	const effectiveExpanded = expanded || !!followTail;
	const collapsible = lines.length > PREVIEW_LINES;
	const shown =
		collapsible && !effectiveExpanded ? lines.slice(0, PREVIEW_LINES) : lines;
	const hidden = lines.length - shown.length;

	return (
		<div data-testid={testId}>
			{lines.length > 0 && (
				<>
					<div className="relative">
						<div
							ref={scrollRef}
							data-testid={testId ? `${testId}-lines` : undefined}
							onScroll={() => {
								const el = scrollRef.current;
								if (el)
									stickRef.current =
										el.scrollHeight - el.scrollTop - el.clientHeight < 20;
							}}
							className={
								effectiveExpanded ? "overflow-auto" : "overflow-hidden"
							}
							style={
								effectiveExpanded ? { maxHeight: MAX_HEIGHT } : undefined
							}
						>
							<div
								className="font-mono text-[calc(11px*var(--font-scale))] leading-[1.75]"
								style={{ tabSize: 4 }}
							>
								{shown.map((line, i) => (
									<div
										key={i}
										data-testid="read-line"
										className="grid grid-cols-[34px_max-content]"
										style={{ contentVisibility: "auto" }}
									>
										<span className="sticky left-0 bg-surface text-right pr-2 text-[calc(10px*var(--font-scale))] text-secondary select-none tabular-nums">
											{startLine + i}
										</span>
										<span className="whitespace-pre pr-4 text-primary">
											{line || "\u00A0"}
										</span>
									</div>
								))}
							</div>
						</div>
						{collapsible && !effectiveExpanded && (
							<div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-surface to-transparent" />
						)}
					</div>
					{collapsible && !followTail && (
						<button
							type="button"
							data-testid={testId ? `${testId}-toggle` : undefined}
							onClick={() => setExpanded((v) => !v)}
							className="w-full text-center text-[calc(11px*var(--font-scale))] text-secondary hover:text-primary py-1 border-t border-dashed border-hairline bg-surface-elevated transition-colors"
						>
							{expanded
								? t("blocks.toolCall.readCollapse")
								: t("blocks.toolCall.readExpandMore", { n: hidden })}
						</button>
					)}
				</>
			)}

			{notice && (
				<div className="mt-1 font-mono text-[calc(10.5px*var(--font-scale))] text-warning break-words">
					{notice}
				</div>
			)}
			{truncation && (
				<div
					data-testid={testId ? `${testId}-truncated` : undefined}
					className="mt-1 text-[calc(10.5px*var(--font-scale))] text-warning"
				>
					{t("blocks.toolCall.readTruncated", {
						shown: truncation.shown,
						total: truncation.total,
					})}
				</div>
			)}
		</div>
	);
}
