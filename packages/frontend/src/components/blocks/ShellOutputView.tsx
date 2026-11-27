import { useState } from "react";
import { useTranslation } from "../../i18n/useTranslation";
import { useIsDarkMode } from "../../theme/use-is-dark-mode";
import { RESULT_CLIP_PX, RESULT_MONO_FONT_CLS } from "./tool-result-shared";

export interface ShellResultView {
	output: string;
	/** 退出码：成功为 0；失败但无法解析（超时/中断）为 null */
	exitCode: number | null;
	truncated: { shown: number; total: number } | null;
	/** 全量输出落盘位置（截断且存盘成功时） */
	fullOutputPath: string | null;
	/** 截断但全量输出未能落盘的原因（pi 1.6.1 新增；磁盘满/无权限等） */
	fullOutputError: string | null;
}

// pi bash 工具在正文尾部追加的页脚约定。
//
// pi 1.6.x（pi-coding-agent dist/core/tools/bash.js formatOutput）实际写的是：
//   [Showing lines A-B of C. Full output: <path>]
//   [Showing lines A-B of C (NKB limit). Full output: <path>]
//   [Showing lines A-B of C. Could not save the full output: <reason>]     ← 1.6.1 新增
//   [Showing last <size> of line N (line is <size>). <上述两种后缀之一>]   ← 长单行截断
// 0.x 老格式（历史会话回读仍会遇到）：
//   [Full output: <path>. Truncated: showing X of Y lines] / [Truncated: showing X of Y lines]
const EXIT_RE = /\n\nCommand exited with code (\d+)\s*$/;
/** 页脚分隔部分：`l1\nl2\n\n[...]` —— 页脚前一定有两个换行（`[` 需转义） */
const FOOTER_PREFIX = "\n\n\\[";
/** 行号段：`Showing lines 1801-2000 of 2000` / 字节上限变体 / 长单行变体 */
const LINES_SEGMENT =
	"Showing (?:lines (?<from>\\d+)-(?<to>\\d+) of (?<total>\\d+)(?: \\([^)]*\\))?|last [^)]* of line \\d+ \\(line is [^)]*\\))\. ";
/** 全量输出去向：路径 或 存盘失败原因 */
const DEST_SEGMENT =
	"(?:(Full output: (?<path>.+))|(?:Could not save the full output: (?<error>.+)))";
/** 1.6.x 页脚（带行号段，可选） */
const FOOTER_MODERN_RE = new RegExp(
	`${FOOTER_PREFIX}(?:${LINES_SEGMENT})?${DEST_SEGMENT}\\]\\s*$`,
);
/** 0.x 老格式页脚：`[Full output: p. Truncated: showing X of Y lines]` */
const LEGACY_FULL_TRUNC_RE =
	/\n\n\[Full output: (.+?)\. Truncated: showing (\d+) of (\d+) lines\]\s*$/;
/** 0.x 老格式页脚：`[Truncated: showing X of Y lines]` */
const LEGACY_TRUNC_RE = /\n\n\[Truncated: showing (\d+) of (\d+) lines\]\s*$/;
/** 0.x 老格式页脚：`[Full output: p]` */
const LEGACY_FULL_RE = /\n\n\[Full output: (.+?)\]\s*$/;

/** 解析 shell 结果：剥离尾部退出码/截断提示，返回可展示的输出与退出码。 */
export function parseShellResult(
	content: Array<{ type?: string; text?: string }> | undefined,
	details: unknown,
	isError: boolean,
): ShellResultView {
	const raw = (content ?? [])
		.filter((c) => c?.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string)
		.join("\n");

	let output = raw;
	let exitCode: number | null = isError ? null : 0;
	let truncated: { shown: number; total: number } | null = null;
	let fullOutputPath: string | null = null;
	let fullOutputError: string | null = null;

	// 最多剥两段：截断页脚 + 退出码（1.6.x 的格式是「页脚在前、退出码在后」）
	for (let guard = 0; guard < 2; guard++) {
		const exit = output.match(EXIT_RE);
		if (exit) {
			exitCode = Number(exit[1]);
			output = output.slice(0, exit.index);
			continue;
		}
		const fullTrunc = output.match(LEGACY_FULL_TRUNC_RE);
		if (fullTrunc) {
			fullOutputPath = fullTrunc[1];
			truncated = { shown: Number(fullTrunc[2]), total: Number(fullTrunc[3]) };
			output = output.slice(0, fullTrunc.index);
			continue;
		}
		const trunc = output.match(LEGACY_TRUNC_RE);
		if (trunc) {
			truncated = { shown: Number(trunc[1]), total: Number(trunc[2]) };
			output = output.slice(0, trunc.index);
			continue;
		}
		const full = output.match(LEGACY_FULL_RE);
		if (full) {
			fullOutputPath = full[1];
			output = output.slice(0, full.index);
			continue;
		}
		const modern = output.match(FOOTER_MODERN_RE);
		if (modern) {
			const g = modern.groups ?? {};
			// 行号段存在时用 A-B / C 推导 shown/total（长单行变体无行号，交给 details）
			if (g.from && g.to && g.total) {
				truncated = {
					shown: Number(g.to) - Number(g.from) + 1,
					total: Number(g.total),
				};
			}
			if (g.path) fullOutputPath = g.path;
			if (g.error) fullOutputError = g.error;
			output = output.slice(0, modern.index);
			continue;
		}
		break;
	}

	// details 是最权威的来源
	const t = (details as { truncation?: { outputLines?: number; totalLines?: number } })
		?.truncation;
	if (
		t &&
		typeof t.outputLines === "number" &&
		typeof t.totalLines === "number"
	) {
		truncated = { shown: t.outputLines, total: t.totalLines };
	}
	const d = details as
		| { fullOutputPath?: string; fullOutputError?: string }
		| undefined;
	if (typeof d?.fullOutputPath === "string" && d.fullOutputPath) {
		fullOutputPath = d.fullOutputPath;
		fullOutputError = null; // 落盘成功与失败互斥，details 里给了路径即视为成功
	}
	if (typeof d?.fullOutputError === "string" && d.fullOutputError) {
		fullOutputError = d.fullOutputError;
		fullOutputPath = null;
	}

	return { output, exitCode, truncated, fullOutputPath, fullOutputError };
}

/** 耗时格式化：<1s 显示毫秒，<60s 显示一位小数秒，否则分秒 */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const total = Math.round(ms / 1000);
	return `${Math.floor(total / 60)}m ${total % 60}s`;
}

/** shell 输出卡：提示符 + 命令 + 输出（限高滚动）+ 退出码/耗时/复制。
 *  明暗自适应：浅色用浅灰终端底，深色用近黑终端底。 */
export function ShellOutputView({
	shell,
	command,
	timeout,
	durationMs,
	view,
	testId,
}: {
	shell: "bash" | "powershell";
	command: string;
	timeout?: number;
	/** 执行耗时（毫秒）：由 assistant 消息时间戳与 toolResult 时间戳差算 */
	durationMs?: number;
	view: ShellResultView;
	testId?: string;
}) {
	const { t } = useTranslation();
	const isDark = useIsDarkMode();
	const [copied, setCopied] = useState<"cmd" | "out" | null>(null);

	const termStyle = isDark
		? {
				background: "#0f0f12",
				color: "#d6d6dc",
				border: "1px solid rgba(255,255,255,.08)",
			}
		: {
				background: "#f7f7f9",
				color: "var(--text-primary)",
				border: "1px solid var(--hairline)",
			};
	const barBg = isDark ? "rgba(255,255,255,.04)" : "rgba(0,0,0,.025)";
	const dimColor = isDark ? "#8b8b95" : "var(--text-secondary)";
	const prompt = shell === "powershell" ? ">" : "$";

	async function copy(kind: "cmd" | "out", text: string) {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(kind);
			setTimeout(() => setCopied(null), 1600);
		} catch {
			// 剪贴板不可用时静默失败
		}
	}

	return (
		<div
			data-testid={testId}
			className="rounded-md overflow-hidden font-mono"
			style={termStyle}
		>
			<div
				className="flex gap-2 px-3 py-2 border-b"
				style={{
					background: barBg,
					borderColor: isDark ? "rgba(255,255,255,.06)" : "var(--hairline)",
				}}
			>
				<span className="select-none flex-shrink-0 text-accent">{prompt}</span>
				<span
					className="min-w-0 whitespace-pre-wrap break-all text-[calc(11.5px*var(--font-scale))]"
					style={{ color: isDark ? "#f2f2f5" : "var(--text-primary)" }}
				>
					{command}
				</span>
			</div>

			{view.output !== "" && (
				<div
					className={`px-3 py-2 overflow-auto ${RESULT_MONO_FONT_CLS} leading-[1.7] whitespace-pre`}
					style={{ maxHeight: RESULT_CLIP_PX }}
				>
					{view.output}
				</div>
			)}

			<div
				className="flex items-center gap-2 px-3 py-1.5 border-t text-[calc(10.5px*var(--font-scale))]"
				style={{
					background: barBg,
					borderColor: isDark ? "rgba(255,255,255,.06)" : "var(--hairline)",
					color: dimColor,
				}}
			>
				{view.exitCode !== null && view.exitCode !== 0 && (
					<span
						data-testid={testId ? `${testId}-exit` : undefined}
						className="text-danger font-semibold"
					>
						{t("blocks.toolCall.shellExit", { code: view.exitCode })}
					</span>
				)}
				{timeout !== undefined && (
					<span>{t("blocks.toolCall.shellTimeout", { s: timeout })}</span>
				)}
				{durationMs !== undefined && durationMs >= 0 && (
					<span data-testid={testId ? `${testId}-duration` : undefined}>
						{t("blocks.toolCall.shellDuration", {
							duration: formatDuration(durationMs),
						})}
					</span>
				)}
				{view.truncated && (
					<span className="text-warning">
						{t("blocks.toolCall.shellTruncated", {
							shown: view.truncated.shown,
							total: view.truncated.total,
						})}
					</span>
				)}
				{view.fullOutputPath && (
					<span className="truncate" title={view.fullOutputPath}>
						{t("blocks.toolCall.shellFullOutput", { path: view.fullOutputPath })}
					</span>
				)}
				{/* pi 1.6.1：全量输出没能落盘（磁盘满 / 无权限）时如实说明原因，
				    否则用户只看到「已截断」，却不知道完整输出已丢失。 */}
				{view.fullOutputError && (
					<span
						data-testid={testId ? `${testId}-full-output-error` : undefined}
						className="truncate text-danger"
						title={view.fullOutputError}
					>
						{t("blocks.toolCall.shellFullOutputError", {
							reason: view.fullOutputError,
						})}
					</span>
				)}
				<span className="ml-auto flex items-center gap-1 flex-shrink-0">
					<button
						type="button"
						className="px-1.5 py-0.5 rounded hover:bg-surface-hover hover:text-primary"
						onClick={() => copy("cmd", command)}
					>
						{copied === "cmd"
							? t("blocks.toolCall.shellCopied")
							: t("blocks.toolCall.shellCopyCommand")}
					</button>
					{view.output !== "" && (
						<button
							type="button"
							className="px-1.5 py-0.5 rounded hover:bg-surface-hover hover:text-primary"
							onClick={() => copy("out", view.output)}
						>
							{copied === "out"
								? t("blocks.toolCall.shellCopied")
								: t("blocks.toolCall.shellCopyOutput")}
						</button>
					)}
				</span>
			</div>
		</div>
	);
}
