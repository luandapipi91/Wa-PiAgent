import { useMemo, useState } from "react";
import { useTranslation } from "../../i18n/useTranslation";
import { Icon } from "../ui/Icon";

/** 一行 diff：上下文 / 新增 / 删除 / 省略。行号为 null 表示未知（执行中预览）。 */
export type DiffLine =
	| { kind: "ctx"; oldNo: number | null; newNo: number | null; text: string }
	| { kind: "add"; oldNo: null; newNo: number | null; text: string }
	| { kind: "del"; oldNo: number | null; newNo: null; text: string }
	| { kind: "gap"; skipped: number | null };

/** pi edit-diff 的行格式："+<新行号> 内容" / "-<旧行号> 内容" / " <旧行号> 内容" / "  ..." */
const DIFF_LINE_RE = /^([+-])(\s*\d*)\s(.*)$|^( )(\s*\d*)\s(.*)$/;

/** 解析 pi 的 details.diff：单列行号 + 净增行数推导出双列行号。
 *  - add 行给的是新文件行号，del 行给的是旧文件行号；
 *  - 上下文行只带旧行号，新行号 = 旧行号 + 当前累计净增（adds - dels）。 */
export function parseEditDiff(diff: string): DiffLine[] {
	if (!diff.trim()) return [];
	const rows: DiffLine[] = [];
	let delta = 0;
	for (const raw of diff.split("\n")) {
		if (raw.startsWith("+++") || raw.startsWith("---")) continue;
		const m = raw.match(DIFF_LINE_RE);
		if (!m) continue;
		const prefix = m[1] ?? m[4];
		const numText = (m[2] ?? m[5] ?? "").trim();
		const text = m[3] ?? m[6] ?? "";
		const num = numText === "" ? null : Number(numText);
		if (prefix === "+") {
			rows.push({ kind: "add", oldNo: null, newNo: num, text });
			delta++;
		} else if (prefix === "-") {
			rows.push({ kind: "del", oldNo: num, newNo: null, text });
			delta--;
		} else if (num === null) {
			rows.push({ kind: "gap", skipped: null });
		} else {
			rows.push({ kind: "ctx", oldNo: num, newNo: num + delta, text });
		}
	}
	return fillGapSkips(rows);
}

/** gap 的跳过行数：用前后两个带旧行号的行推算；算不出就留 null。 */
function fillGapSkips(rows: DiffLine[]): DiffLine[] {
	return rows.map((row, i) => {
		if (row.kind !== "gap") return row;
		const prev = rows[i - 1];
		const next = rows[i + 1];
		// gap 后面可能是上下文行或删除行（两者都带旧行号）；新增行只有新行号，算不出
		const nextOldNo =
			next?.kind === "ctx" || next?.kind === "del" ? next.oldNo : null;
		if (
			prev?.kind === "ctx" &&
			prev.oldNo != null &&
			nextOldNo != null
		) {
			const skipped = nextOldNo - prev.oldNo - 1;
			if (skipped > 0) return { kind: "gap", skipped };
		}
		return row;
	});
}

/** 执行中 / 旧会话没有 details.diff 时，用参数构造块级预览：先删除行、后新增行。
 *  不伪造文件行号（oldNo/newNo 为 null），避免把块内序号当成真实位置。 */
export function buildEditPreview(args: Record<string, unknown>): DiffLine[] {
	const edits = Array.isArray(args.edits)
		? args.edits
		: args.oldText !== undefined || args.newText !== undefined
			? [{ oldText: args.oldText, newText: args.newText }]
			: [];
	// 参数来自 LLM 输出，流式中可能是截断/畸形的 JSON。形状不符时整体返回空，
	// 由调用方降级到通用参数视图（避免把残缺预览渲染成“看起来完整”的 diff）。
	const valid = edits.every(
		(edit) =>
			edit &&
			typeof edit === "object" &&
			((edit as any).oldText === undefined ||
				typeof (edit as any).oldText === "string") &&
			((edit as any).newText === undefined ||
				typeof (edit as any).newText === "string"),
	);
	if (!valid) return [];
	const rows: DiffLine[] = [];
	for (const edit of edits) {
		if (!edit || typeof edit !== "object") continue;
		const oldText =
			typeof (edit as any).oldText === "string"
				? (edit as any).oldText
				: undefined;
		const newText =
			typeof (edit as any).newText === "string"
				? (edit as any).newText
				: undefined;
		if (oldText === undefined && newText === undefined) continue;
		if (rows.length > 0) rows.push({ kind: "gap", skipped: null });
		for (const text of splitLines(oldText)) {
			rows.push({ kind: "del", oldNo: null, newNo: null, text });
		}
		for (const text of splitLines(newText)) {
			rows.push({ kind: "add", oldNo: null, newNo: null, text });
		}
	}
	return rows;
}

function splitLines(text: string | undefined): string[] {
	if (text === undefined || text === "") return [];
	return text.split("\n");
}

export interface IntraLineDiff {
	prefix: string;
	oldChanged: string;
	newChanged: string;
	suffix: string;
}

/** 单行替换的词级高亮：公共前缀/后缀不动，中间段标出。 */
export function intraLineDiff(oldText: string, newText: string): IntraLineDiff {
	let prefixLen = 0;
	const max = Math.min(oldText.length, newText.length);
	while (prefixLen < max && oldText[prefixLen] === newText[prefixLen]) {
		prefixLen++;
	}
	let suffixLen = 0;
	while (
		suffixLen < max - prefixLen &&
		oldText[oldText.length - 1 - suffixLen] ===
			newText[newText.length - 1 - suffixLen]
	) {
		suffixLen++;
	}
	return {
		prefix: oldText.slice(0, prefixLen),
		oldChanged: oldText.slice(prefixLen, oldText.length - suffixLen),
		newChanged: newText.slice(prefixLen, newText.length - suffixLen),
		suffix: suffixLen > 0 ? oldText.slice(oldText.length - suffixLen) : "",
	};
}

export interface DiffHunkSummary {
	line: number | null;
	added: number;
	removed: number;
}

/** 变更块摘要：连续的新增/删除算一处，取该块第一个真实行号。 */
export function diffSummary(rows: DiffLine[]): DiffHunkSummary[] {
	const hunks: DiffHunkSummary[] = [];
	let current: DiffHunkSummary | null = null;
	for (const row of rows) {
		if (row.kind === "ctx" || row.kind === "gap") {
			current = null;
			continue;
		}
		if (!current) {
			current = {
				line: row.kind === "del" ? row.oldNo : row.newNo,
				added: 0,
				removed: 0,
			};
			hunks.push(current);
		}
		if (row.kind === "add") current.added++;
		else current.removed++;
	}
	return hunks;
}

/** 给相邻的一删一增配对做词级高亮；多行块不配对（与 pi 的终端渲染一致）。 */
function buildHighlights(rows: DiffLine[]): Map<number, IntraLineDiff> {
	const map = new Map<number, IntraLineDiff>();
	let i = 0;
	while (i < rows.length) {
		if (rows[i].kind !== "del") {
			i++;
			continue;
		}
		const delStart = i;
		while (i < rows.length && rows[i].kind === "del") i++;
		const delEnd = i;
		const addStart = i;
		while (i < rows.length && rows[i].kind === "add") i++;
		const addEnd = i;
		if (delEnd - delStart === 1 && addEnd - addStart === 1) {
			const delRow = rows[delStart] as Extract<DiffLine, { kind: "del" }>;
			const addRow = rows[addStart] as Extract<DiffLine, { kind: "add" }>;
			map.set(delStart, intraLineDiff(delRow.text, addRow.text));
			map.set(addStart, intraLineDiff(delRow.text, addRow.text));
		}
	}
	return map;
}

export function EditDiffView({
	rows,
	diffText,
	testId,
}: {
	rows: DiffLine[];
	/** 原始 diff 文本：有值时 footer 提供复制，没有则视为执行中预览。 */
	diffText?: string | null;
	testId?: string;
}) {
	const { t } = useTranslation();
	const highlights = useMemo(() => buildHighlights(rows), [rows]);
	const hunks = useMemo(() => diffSummary(rows), [rows]);
	const [copied, setCopied] = useState(false);

	if (rows.length === 0) return null;

	const lines = hunks
		.map((h) => h.line)
		.filter((n): n is number => n != null);

	async function copy() {
		if (!diffText) return;
		try {
			await navigator.clipboard.writeText(diffText);
			setCopied(true);
			setTimeout(() => setCopied(false), 1600);
		} catch {
			// 剪贴板不可用（权限/非安全上下文）时静默失败，不影响阅读
		}
	}

	return (
		<div className="min-w-0" data-testid={testId}>
			<div
				className="font-mono text-[calc(11px*var(--font-scale))] leading-[1.7] py-1"
				style={{ tabSize: 4 }}
			>
				{rows.map((row, i) =>
					row.kind === "gap" ? (
						<div
							key={i}
							data-testid="edit-diff-gap"
							className="flex items-center gap-2 pl-[82px] pr-3 py-0.5 my-1 bg-surface-elevated border-y border-dashed border-hairline text-[calc(10px*var(--font-scale))] text-tertiary"
						>
							{row.skipped != null && (rows[i - 1] as any)?.oldNo != null
								? t("blocks.toolCall.diffSkipped", {
										from: (rows[i - 1] as any).oldNo + 1,
										to: (rows[i - 1] as any).oldNo + row.skipped,
									})
								: t("blocks.toolCall.diffSkippedUnknown")}
						</div>
					) : (
						<div
							key={i}
							data-testid={`edit-diff-${row.kind}`}
							className={`grid grid-cols-[34px_34px_14px_minmax(0,1fr)] ${
								row.kind === "add"
									? "bg-success-soft"
									: row.kind === "del"
										? "bg-danger-soft"
										: ""
							}`}
						>
							<span className="text-right pr-2 text-secondary text-[calc(10px*var(--font-scale))] select-none tabular-nums">
								{row.oldNo ?? ""}
							</span>
							<span className="text-right pr-2 text-secondary text-[calc(10px*var(--font-scale))] select-none tabular-nums">
								{row.newNo ?? ""}
							</span>
							<span
								className={`text-center select-none font-semibold ${
									row.kind === "add"
										? "text-success"
										: row.kind === "del"
											? "text-danger"
											: "text-tertiary"
								}`}
							>
								{row.kind === "add" ? "+" : row.kind === "del" ? "−" : ""}
							</span>
							<span
								className={`whitespace-pre-wrap break-words min-w-0 pr-3 ${
									row.kind === "ctx" ? "text-secondary" : "text-primary"
								}`}
							>
								{renderCode(row, highlights.get(i))}
							</span>
						</div>
					),
				)}
			</div>

			<div className="flex items-center gap-2 pt-1.5 mt-0.5 border-t border-hairline text-[calc(10.5px*var(--font-scale))] text-tertiary">
				<span data-testid={testId ? `${testId}-summary` : undefined}>
					{diffText
						? t("blocks.toolCall.diffHunkCount", { count: hunks.length })
						: t("blocks.toolCall.diffPreview")}
					{lines.length > 0 &&
						` · ${t("blocks.toolCall.diffAtLine", { lines: lines.join("、") })}`}
				</span>
				<span className="ml-auto" />
				{diffText && (
					<button
						type="button"
						onClick={copy}
						className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-surface-hover hover:text-primary"
					>
						<Icon name="copy" size={11} />
						{copied
							? t("blocks.toolCall.diffCopied")
							: t("blocks.toolCall.diffCopy")}
					</button>
				)}
			</div>
		</div>
	);
}

function renderCode(
	row: Exclude<DiffLine, { kind: "gap" }>,
	hl?: IntraLineDiff,
) {
	if (!hl) return row.text;
	const changed = row.kind === "del" ? hl.oldChanged : hl.newChanged;
	if (!changed) return row.text;
	return (
		<>
			{hl.prefix}
			<mark
				className={
					row.kind === "del"
						? "bg-danger/30 rounded-[2px] text-inherit"
						: "bg-success/30 rounded-[2px] text-inherit"
				}
			>
				{changed}
			</mark>
			{hl.suffix}
		</>
	);
}
