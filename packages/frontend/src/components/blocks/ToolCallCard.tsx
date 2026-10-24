import type { ReactNode } from "react";
import { Fragment, useEffect, useRef } from "react";
import type { ToolCall, ToolResultMessage } from "@wa-pi/shared";
import { ProcessCard, Spinner } from "./ProcessCard";
import { useAutoCollapse } from "./useAutoCollapse";
import { Linkify } from "./linkify";
import { McpResultView } from "./McpResultView";
import { CodemodeScriptView, CodemodeResultView } from "./CodemodeView";
import {
	EditDiffView,
	buildEditPreview,
	parseEditDiff,
} from "./EditDiffView";
import { ReadContentView, parseReadResult } from "./ReadContentView";
import { ShellOutputView, parseShellResult } from "./ShellOutputView";
import { useTranslation } from "../../i18n/useTranslation";
import { useUiPrefsStore } from "../../store/ui-prefs";
import { Icon } from "../ui/Icon";

/** 格式化工具调用参数 — 截断长值避免撑爆 UI（自 MessageList 迁入） */
export function formatArgs(args: Record<string, unknown>): string {
	const keys = Object.keys(args);
	if (keys.length === 0) return "";
	const parts = keys.map((k) => {
		const v = args[k];
		if (typeof v === "string") {
			return v.length > 60 ? `${k}: "${v.slice(0, 50)}..."` : `${k}: "${v}"`;
		}
		const s = JSON.stringify(v);
		return s.length > 80 ? `${k}: ${s.slice(0, 77)}...` : `${k}: ${s}`;
	});
	return parts.join(", ");
}

/** 行数统计（edit/write 卡片右侧 +N -M） */
export interface EditLineStats {
	added: number;
	removed: number;
}

function countLines(s: string): number {
	return s === "" ? 0 : s.split("\n").length;
}

/** 计算 edit/write 的增删行数；无可靠数据（其他工具/失败/无法解析）返回 null 不展示。
 *  优先级：edit 已完成时用 result.details.diff（pi edit-diff 生成，+<行号>/-<行号>/空格开头上下文，
 *  最准）；执行中或旧会话无 details 时从 arguments.edits[]（兼容平铺 oldText/newText）推算；
 *  write 没有删除数（覆盖写前的旧行数在调用点不可知），只报 content 行数。 */
export function editLineStats(
	toolName: string,
	args: Record<string, unknown>,
	result?: ToolResultMessage,
): EditLineStats | null {
	if (toolName !== "edit" && toolName !== "write") return null;
	if (result?.isError) return null;

	if (toolName === "edit") {
		const details = result?.details;
		if (
			details &&
			typeof details === "object" &&
			typeof (details as any).diff === "string"
		) {
			let added = 0;
			let removed = 0;
			for (const line of (details as any).diff.split("\n")) {
				if (line.startsWith("+++") || line.startsWith("---")) continue;
				if (line.startsWith("+")) added++;
				else if (line.startsWith("-")) removed++;
			}
			if (added > 0 || removed > 0) return { added, removed };
		}

		// 兜底（执行中 / 旧会话）：参数推算。与 EditArgsView 同款兼容：edits 数组或平铺 oldText/newText
		const edits = Array.isArray(args.edits)
			? args.edits
			: args.oldText !== undefined || args.newText !== undefined
				? [{ oldText: args.oldText, newText: args.newText }]
				: [];
		let added = 0;
		let removed = 0;
		let seen = false;
		for (const e of edits) {
			if (!e || typeof e !== "object") continue;
			const oldText = typeof e.oldText === "string" ? e.oldText : undefined;
			const newText = typeof e.newText === "string" ? e.newText : undefined;
			if (oldText === undefined && newText === undefined) continue;
			seen = true;
			if (oldText !== undefined) removed += countLines(oldText);
			if (newText !== undefined) added += countLines(newText);
		}
		return seen && (added > 0 || removed > 0) ? { added, removed } : null;
	}

	// write
	const content = args.content;
	if (typeof content !== "string") return null;
	const added = countLines(content);
	return added > 0 ? { added, removed: 0 } : null;
}

/** 多行/长字符串代码块样式：真实换行缩进展示、带行号，不设高度限制（完整可读） */
const CODE_BLOCK_CLS =
	"whitespace-pre-wrap break-words rounded bg-surface px-2 py-1 text-[calc(11px*var(--font-scale))] text-secondary my-1 font-mono";

/** 按行拆分渲染带行号的代码块（行号右对齐固定列宽，内容保留缩进/折行） */
function LineNumberedLines({ text }: { text: string }) {
	const lines = text.split("\n");
	return (
		<>
			{lines.map((line, i) => (
				<div key={i} className="flex min-w-0">
					<span
						data-testid="code-line-num"
						className="inline-block w-8 text-right mr-3 text-tertiary select-none flex-shrink-0"
					>
						{i + 1}
					</span>
					<span className="whitespace-pre-wrap break-words min-w-0">
						{line || "\u00A0"}
					</span>
				</div>
			))}
		</>
	);
}

/** 内容流式增长时自动滚动到底部的 pre（工具参数长文本预览）。
 * 语义与主消息列表一致：用户停在底部时内容增长自动跟随；用户上翻则不抢；
 * 回到底部恢复跟随。首次挂载不自动滚动（用户从头看完整内容）。 */
function AutoScrollPre({ text }: { text: string }) {
	const ref = useRef<HTMLPreElement>(null);
	const stickRef = useRef(true);
	const prevTextRef = useRef<string | null>(null);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		if (prevTextRef.current === null) {
			prevTextRef.current = text; // 首次挂载：停在顶部，不抢滚动
			return;
		}
		prevTextRef.current = text;
		if (stickRef.current) el.scrollTop = el.scrollHeight;
	}, [text]);
	return (
		<pre
			ref={ref}
			onScroll={() => {
				const el = ref.current;
				if (el)
					stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
			}}
			className={CODE_BLOCK_CLS}
		>
			<LineNumberedLines text={text} />
		</pre>
	);
}

/** 递归渲染参数值：多行/长字符串以真实文本代码块展示，其余保持 JSON 风格 */
function ArgValue({ v }: { v: any }): ReactNode {
	if (typeof v === "string") {
		if (v.includes("\n") || v.length > 60) {
			return <AutoScrollPre text={v} />;
		}
		return <span className="text-secondary">"{v}"</span>;
	}
	if (v === null) return <span className="text-tertiary">null</span>;
	if (Array.isArray(v)) {
		return (
			<div className="pl-3 border-l border-hairline">
				{v.map((item, i) => (
					<div key={i} className="min-w-0">
						{ArgValue({ v: item })}
					</div>
				))}
			</div>
		);
	}
	if (typeof v === "object") {
		return (
			<div className="pl-3 border-l border-hairline">
				{Object.entries(v).map(([k, val]) => (
					<div key={k} className="min-w-0">
						<span className="text-tertiary">{k}:</span> {ArgValue({ v: val })}
					</div>
				))}
			</div>
		);
	}
	return <span className="text-secondary">{String(v)}</span>;
}

/** 通用工具参数展开视图：美化 JSON，长字符串还原为真实文本 */
function PrettyArgsView({ args }: { args: Record<string, unknown> }) {
	return <ArgValue v={args} />;
}

/** 工具失败：错误文本块（不走 Linkify 平铺，也不展示残缺内容） */
function ToolErrorBlock({ result }: { result?: ToolResultMessage }) {
	const text = (result?.content ?? [])
		.filter((c: any) => c?.type === "text")
		.map((c: any) => c.text)
		.join("\n");
	if (!text) return null;
	return (
		<pre className="m-0 rounded bg-danger-soft border border-danger/20 px-2 py-1.5 text-[calc(11px*var(--font-scale))] leading-[1.6] text-danger whitespace-pre-wrap break-words font-mono">
			{text}
		</pre>
	);
}

/** 卡片标题：edit/read 显示文件名与动作，其余工具显示名称 + 截断参数 */
function toolCallTitle(
	toolCall: ToolCall,
	t: (key: string, opts?: Record<string, unknown>) => string,
): ReactNode {
	if (toolCall.name === "edit") {
		const path =
			typeof toolCall.arguments.path === "string"
				? toolCall.arguments.path
				: undefined;
		return path ? (
			fileTitle(path, t("blocks.toolCall.editAction"))
		) : (
			<span className="font-mono">edit</span>
		);
	}
	if (toolCall.name === "read") {
		const path =
			typeof toolCall.arguments.path === "string"
				? toolCall.arguments.path
				: undefined;
		const offset =
			typeof toolCall.arguments.offset === "number"
				? toolCall.arguments.offset
				: undefined;
		const limit =
			typeof toolCall.arguments.limit === "number"
				? toolCall.arguments.limit
				: undefined;
		let range: string | null = null;
		if (offset !== undefined || limit !== undefined) {
			const from = offset ?? 1;
			range =
				limit !== undefined
					? t("blocks.toolCall.readRange", { from, to: from + limit - 1 })
					: t("blocks.toolCall.readFrom", { from });
		}
		return path ? (
			fileTitle(path, t("blocks.toolCall.readAction"), range)
		) : (
			<span className="font-mono">read</span>
		);
	}
	if (toolCall.name === "bash" || toolCall.name === "powershell") {
		const command =
			typeof toolCall.arguments.command === "string"
				? toolCall.arguments.command
				: "";
		const firstLine = command.split("\n")[0] ?? "";
		const shown =
			firstLine.length > 80 ? `${firstLine.slice(0, 78)}…` : firstLine;
		return (
			<span className="font-mono">
				<span className="font-sans text-tertiary">
					{t("blocks.toolCall.shellAction")}
				</span>{" "}
				<span className="font-semibold">{shown || "…"}</span>
				<span className="ml-1.5 align-middle text-[calc(9px*var(--font-scale))] font-bold uppercase tracking-wider text-tertiary border border-hairline rounded px-1 py-px">
					{toolCall.name === "powershell" ? "pwsh" : "bash"}
				</span>
			</span>
		);
	}
	if (toolCall.name === "write") {
		const path =
			typeof toolCall.arguments.path === "string"
				? toolCall.arguments.path
				: undefined;
		return path ? (
			fileTitle(path, t("blocks.toolCall.writeAction"))
		) : (
			<span className="font-mono">write</span>
		);
	}
	if (toolCall.name === "ask_user_question") {
		return (
			<span className="font-mono">
				{t("blocks.toolCall.askUserQuestionName")}{" "}
				<span className="text-tertiary">
					({formatArgs(toolCall.arguments)})
				</span>
			</span>
		);
	}
	if (toolCall.name === "codemode") {
		const code =
			typeof toolCall.arguments.code === "string"
				? toolCall.arguments.code
				: "";
		return (
			<span className="font-mono">
				codemode{" "}
				<span className="text-tertiary">
					({code === "" ? 0 : code.split("\n").length}L)
				</span>
			</span>
		);
	}
	return (
		<span className="font-mono">
			{toolCall.name}{" "}
			<span className="text-tertiary">({formatArgs(toolCall.arguments)})</span>
		</span>
	);
}

/** 去掉末尾空行（write 内容通常以换行结尾，不应多渲染空行） */
function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") end--;
	return lines.slice(0, end);
}

/** 文件类工具标题：动作 + 文件名为主、目录为辅（完整路径放 title 属性） */
function fileTitle(
	path: string,
	action: string,
	trailing?: string | null,
): ReactNode {
	const norm = path.replace(/\\/g, "/");
	const idx = norm.lastIndexOf("/");
	const file = idx >= 0 ? norm.slice(idx + 1) : norm;
	const parts = idx >= 0 ? norm.slice(0, idx).split("/").filter(Boolean) : [];
	const dir = parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : parts.join("/");
	return (
		<span className="font-mono" title={norm}>
			<span className="font-sans text-tertiary">{action}</span>{" "}
			<span className="font-semibold">{file}</span>
			{dir && <span className="text-tertiary"> · {dir}</span>}
			{trailing && <span className="text-tertiary"> · {trailing}</span>}
		</span>
	);
}

/** 单个工具调用卡片：完成即折叠；成功绿 / 失败红 / 执行中 accent */
export function ToolCallCard({
	toolCall,
	result,
	isStreaming,
	startedAt,
}: {
	toolCall: ToolCall;
	result?: ToolResultMessage;
	isStreaming?: boolean;
	/** 工具开始执行的绝对时间（assistant 消息时间戳，epoch ms）：用于算耗时 */
	startedAt?: number;
}) {
	const collapseProcessByDefault = useUiPrefsStore(
		(s) => s.collapseProcessByDefault,
	);
	const { open, toggle } = useAutoCollapse({
		isStreaming,
		isDone: !!result,
		executingMode: true,
		defaultCollapsed: collapseProcessByDefault,
	});
	const { t } = useTranslation();
	const failed = !!result?.isError;
	const tone = !result ? "accent" : failed ? "danger" : "success";
	const stats = editLineStats(toolCall.name, toolCall.arguments, result);
	// edit：优先用 pi 生成的 details.diff（带真实行号）；执行中/旧会话用参数构造块级预览。
	const diffText =
		toolCall.name === "edit" &&
		result &&
		!result.isError &&
		result.details &&
		typeof result.details === "object" &&
		typeof (result.details as any).diff === "string"
			? ((result.details as any).diff as string)
			: null;
	const editRows =
		toolCall.name === "edit" && !failed
			? diffText
				? parseEditDiff(diffText)
				: buildEditPreview(toolCall.arguments)
			: [];
	// read：完成后解析正文（剥离尾部提示）+ 行号起点 + 截断信息
	const readView =
		toolCall.name === "read" && result && !failed
			? parseReadResult(
					result.content as any,
					toolCall.arguments,
					result.details as any,
				)
			: null;
	// shell：完成后解析输出/退出码/截断（成功与失败都要，失败时退出码来自正文）
	const isShell =
		toolCall.name === "bash" || toolCall.name === "powershell";
	const shellView =
		isShell && result
			? parseShellResult(
					result.content as any,
					result.details,
					failed,
				)
			: null;
	const shellCommand =
		typeof toolCall.arguments.command === "string"
			? toolCall.arguments.command
			: "";
	// write：正文来自参数（不是结果），行号从 1 起，无截断；去掉末尾空行
	const writeView =
		toolCall.name === "write" &&
		!failed &&
		typeof toolCall.arguments.content === "string" &&
		toolCall.arguments.content !== ""
			? {
					lines: trimTrailingEmptyLines(
						(toolCall.arguments.content as string).split("\n"),
					),
					startLine: 1,
					truncation: null,
					notice: null,
				}
			: null;
	const shellTimeout =
		typeof toolCall.arguments.timeout === "number"
			? toolCall.arguments.timeout
			: undefined;
	const durationMs =
		startedAt !== undefined &&
		result &&
		typeof result.timestamp === "number" &&
		result.timestamp > 0
			? result.timestamp - startedAt
			: undefined;
	return (
		<ProcessCard
			tone={tone}
			icon={
				!result ? (
					<Icon name="wrench" />
				) : failed ? (
					<Icon name="x" />
				) : (
					<Icon name="check" />
				)
			}
			title={toolCallTitle(toolCall, t)}
			meta={
				<>
					{!result ? (
						<Spinner />
					) : shellView && shellView.exitCode !== null ? null /* shell 的退出码已在下方自述，不再叠「完成」 */ : failed ? (
						t("blocks.toolCall.failedMeta")
					) : (
						t("blocks.toolCall.doneMeta")
					)}
					{stats && (
						<span
							data-testid={`toolcall-${toolCall.id}-stats`}
							className="inline-flex items-center gap-1 font-mono"
						>
							{stats.removed > 0 ? (
								<>
									<span className="text-success">+{stats.added}</span>
									<span className="text-danger">-{stats.removed}</span>
								</>
							) : (
								<span className="text-success">+{stats.added}</span>
							)}
						</span>
					)}
					{readView && readView.lines.length > 0 && (
						<span
							data-testid={`toolcall-${toolCall.id}-lines`}
							className="font-mono"
						>
							{t("blocks.toolCall.readLines", { n: readView.lines.length })}
						</span>
					)}
					{shellView && shellView.exitCode !== null && (
						<span
							data-testid={`toolcall-${toolCall.id}-exit`}
							className={
								shellView.exitCode === 0
									? "font-mono font-semibold text-success"
									: "font-mono font-semibold text-danger"
							}
						>
							{t("blocks.toolCall.shellExit", { code: shellView.exitCode })}
						</span>
					)}
				</>
			}
			open={open}
			onToggle={toggle}
			muted={!!result}
			testId={`toolcall-${toolCall.id}`}
		>
			{toolCall.name === "codemode" ? (
				<CodemodeScriptView
					code={
						typeof toolCall.arguments.code === "string"
							? toolCall.arguments.code
							: ""
						}
				/>
			) : toolCall.name === "edit" ? (
				failed ? (
					<ToolErrorBlock result={result} />
				) : editRows.length > 0 ? (
					<EditDiffView
						rows={editRows}
						diffText={diffText}
						testId={`toolcall-${toolCall.id}-diff`}
					/>
				) : (
					<PrettyArgsView args={toolCall.arguments} />
				)
			) : toolCall.name === "read" ? (
				failed ? (
					<ToolErrorBlock result={result} />
				) : readView ? (
					<ReadContentView
						view={readView}
						testId={`toolcall-${toolCall.id}-read`}
					/>
				) : (
					<PrettyArgsView args={toolCall.arguments} />
				)
			) : isShell ? (
				result && shellView ? (
					<ShellOutputView
						shell={toolCall.name as "bash" | "powershell"}
						command={shellCommand}
						timeout={shellTimeout}
						durationMs={durationMs}
						view={shellView}
						testId={`toolcall-${toolCall.id}-shell`}
					/>
				) : (
					<PrettyArgsView args={toolCall.arguments} />
				)
			) : toolCall.name === "write" ? (
				failed ? (
					<ToolErrorBlock result={result} />
				) : writeView && writeView.lines.length > 0 ? (
					<ReadContentView
						view={writeView}
						testId={`toolcall-${toolCall.id}-write`}
						followTail={!!isStreaming && !result}
					/>
				) : (
					<PrettyArgsView args={toolCall.arguments} />
				)
			) : (
				<PrettyArgsView args={toolCall.arguments} />
			)}
			{result &&
				toolCall.name !== "edit" &&
				toolCall.name !== "read" &&
				toolCall.name !== "write" &&
				!isShell && (
				<div
					className={`mt-1 pt-1 border-t border-hairline ${failed ? "text-danger" : "text-success"}`}
				>
					{toolCall.name.startsWith("mcp__") ? (
						// MCP 结果（多为大 JSON）：结构化渲染（截断横幅 / 语法高亮 / 限高 / 复制），
						// 不走裸 Linkify 平铺。失败态的 danger 色由 McpResultView 自身承载。
						<McpResultView result={result} failed={failed} />
					) : toolCall.name === "codemode" ? (
						// codemode：脚本输出协议解析（==> text N/M <== 分隔 / console 块 / 图片）
						<CodemodeResultView result={result} failed={failed} />
					) : (
						result.content.map(
							(c: any, i: number) =>
								c?.type === "text" && (
									<div key={i}>
										<Linkify text={c.text} />
									</div>
								),
						)
					)}
				</div>
			)}
		</ProcessCard>
	);
}

/** 单个调用的渲染出口：默认渲染平铺 ToolCallCard（含结果）。
 *  嵌套调用的调用方（ToolCallsSegment）传自定义实现，把内层子卡挂到父卡下；
 *  分组/计数/折叠逻辑与出口无关，传与不传行为一致。 */
export type ToolCallRenderer = (toolCall: any) => ReactNode;

/** 工具调用分组：>1 个连续调用归成一张组卡；单工具直接渲染单卡 */
export function ToolGroupCard({
	toolCalls,
	results,
	isStreaming,
	renderItem,
}: {
	toolCalls: any[];
	results: Map<string, ToolResultMessage>;
	isStreaming?: boolean;
	renderItem?: ToolCallRenderer;
}) {
	const render = renderItem ?? defaultRenderer(results, isStreaming);
	if (toolCalls.length === 1) {
		return <>{render(toolCalls[0])}</>;
	}
	return (
		<ToolGroupCardInner
			toolCalls={toolCalls}
			results={results}
			isStreaming={isStreaming}
			renderItem={renderItem}
		/>
	);
}

/** 默认渲染：平铺单卡（与改造前的 JSX 逐字一致） */
function defaultRenderer(
	results: Map<string, ToolResultMessage>,
	isStreaming?: boolean,
): ToolCallRenderer {
	return (toolCall) => (
		<ToolCallCard
			toolCall={toolCall}
			result={results.get(toolCall.id)}
			isStreaming={isStreaming}
		/>
	);
}

function ToolGroupCardInner({
	toolCalls,
	results,
	isStreaming,
	renderItem,
}: {
	toolCalls: any[];
	results: Map<string, ToolResultMessage>;
	isStreaming?: boolean;
	renderItem?: ToolCallRenderer;
}) {
	const render = renderItem ?? defaultRenderer(results, isStreaming);
	const total = toolCalls.length;
	const doneCount = toolCalls.filter((tc: any) => results.has(tc.id)).length;
	const successCount = toolCalls.filter((tc: any) => {
		const r = results.get(tc.id);
		return r && !r.isError;
	}).length;
	const failedCount = toolCalls.filter((tc: any) => {
		const r = results.get(tc.id);
		return r && r.isError;
	}).length;
	const collapseProcessByDefault = useUiPrefsStore(
		(s) => s.collapseProcessByDefault,
	);
	const { open, toggle } = useAutoCollapse({
		isStreaming,
		isDone: doneCount === total,
		executingMode: true,
		defaultCollapsed: collapseProcessByDefault,
	});
	const { t } = useTranslation();

	// 计数摘要：✓成功 ✗失败 ⏳进行中（图标 + 数量）
	const status: ReactNode[] = [];
	if (successCount > 0)
		status.push(
			<span key="ok" className="inline-flex items-center gap-0.5">
				<Icon name="check" size={11} />
				{successCount}
			</span>,
		);
	if (failedCount > 0)
		status.push(
			<span key="fail" className="inline-flex items-center gap-0.5">
				<Icon name="x" size={11} />
				{failedCount}
			</span>,
		);
	if (doneCount < total)
		status.push(
			<span key="run" className="inline-flex items-center gap-0.5">
				<Icon name="hourglass" size={11} />
				{total - doneCount}
			</span>,
		);
	const statusEl = (
		<span className="inline-flex items-center gap-1.5">{status}</span>
	);

	return (
		<ProcessCard
			tone="accent"
			icon={<Icon name="wrench" />}
			title={t("blocks.toolCall.groupTitle", { total })}
			meta={
				doneCount < total && isStreaming ? (
					<>
						<Spinner />
						{statusEl}
					</>
				) : (
					statusEl
				)
			}
			open={open}
			onToggle={toggle}
			muted={doneCount === total}
			testId="toolcall-group"
		>
			<div className="space-y-1.5">
				{toolCalls.map((tc: any) => (
					<Fragment key={tc.id}>{render(tc)}</Fragment>
				))}
			</div>
		</ProcessCard>
	);
}
