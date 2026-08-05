import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import type { ToolCall, ToolResultMessage } from "@wa-pi/shared";
import { ProcessCard, Spinner } from "./ProcessCard";
import { useAutoCollapse } from "./useAutoCollapse";
import { Icon } from "../ui/Icon";

/** 格式化工具调用参数 — 截断长值避免撑爆 UI（自 MessageList 迁入） */
export function formatArgs(args: Record<string, any>): string {
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
					stickRef.current =
						el.scrollHeight - el.scrollTop - el.clientHeight < 20;
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
function PrettyArgsView({ args }: { args: Record<string, any> }) {
	return <ArgValue v={args} />;
}

/** edit 工具专用参数视图：文件路径 + 新旧内容代码块（兼容 edits 数组与平铺两种参数结构） */
function EditArgsView({ args }: { args: Record<string, any> }) {
	const edits = Array.isArray(args.edits)
		? args.edits
		: args.oldText !== undefined || args.newText !== undefined
			? [{ oldText: args.oldText, newText: args.newText }]
			: [];
	// 参数来自 LLM 输出，流式中可能是截断/畸形的 JSON（如 edits: [null]、oldText 为对象）。
	// 形状不符时降级到通用视图——通用视图对任意输入安全，避免单张卡片拖垮整个消息列表渲染。
	const valid = edits.every(
		(e) =>
			e &&
			typeof e === "object" &&
			(e.oldText === undefined || typeof e.oldText === "string") &&
			(e.newText === undefined || typeof e.newText === "string"),
	);
	if (!valid) return <PrettyArgsView args={args} />;
	return (
		<div className="space-y-2">
			{edits.map((e, i) => (
				<div key={i} className="min-w-0">
					<div className="text-[calc(11px*var(--font-scale))] text-tertiary font-semibold mb-0.5">
						{edits.length > 1 ? `编辑 ${i + 1}` : "内容变更"}
					</div>
					{e.oldText !== undefined && (
						<>
							<div className="text-[calc(11px*var(--font-scale))] text-tertiary">旧</div>
							<AutoScrollPre text={e.oldText} />
						</>
					)}
					{e.newText !== undefined && (
						<>
							<div className="text-[calc(11px*var(--font-scale))] text-tertiary">新</div>
							<AutoScrollPre text={e.newText} />
						</>
					)}
				</div>
			))}
		</div>
	);
}

/** 卡片标题：edit 显示文件名，其余工具显示名称 + 截断参数 */
function toolCallTitle(toolCall: ToolCall): ReactNode {
	const name = toolCall.name === "ask_user_question" ? "问答" : toolCall.name;
	if (toolCall.name === "edit") {
		const path =
			typeof toolCall.arguments.path === "string"
				? toolCall.arguments.path
				: undefined;
		return (
			<span className="font-mono">
				edit {path && <span className="text-tertiary">({path})</span>}
			</span>
		);
	}
	return (
		<span className="font-mono">
			{name}{" "}
			<span className="text-tertiary">({formatArgs(toolCall.arguments)})</span>
		</span>
	);
}

/** 单个工具调用卡片：完成即折叠；成功绿 / 失败红 / 执行中 accent */
export function ToolCallCard({
	toolCall,
	result,
	isStreaming,
}: {
	toolCall: ToolCall;
	result?: ToolResultMessage;
	isStreaming?: boolean;
}) {
	const { open, toggle } = useAutoCollapse({
		isStreaming,
		isDone: !!result,
		executingMode: true,
	});
	const failed = !!result?.isError;
	const tone = !result ? "accent" : failed ? "danger" : "success";
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
			title={toolCallTitle(toolCall)}
			meta={!result ? <Spinner /> : failed ? "失败" : "完成"}
			open={open}
			onToggle={toggle}
			muted={!!result}
			testId={`toolcall-${toolCall.id}`}
		>
			{toolCall.name === "edit" ? (
				<EditArgsView args={toolCall.arguments} />
			) : (
				<PrettyArgsView args={toolCall.arguments} />
			)}
			{result && (
				<div
					className={`mt-1 pt-1 border-t border-hairline ${failed ? "text-danger" : "text-success"}`}
				>
					{result.content.map(
						(c: any, i: number) =>
							c.type === "text" && <div key={i}>{c.text}</div>,
					)}
				</div>
			)}
		</ProcessCard>
	);
}

/** 工具调用分组：>1 个连续调用归成一张组卡；单工具直接渲染单卡 */
export function ToolGroupCard({
	toolCalls,
	results,
	isStreaming,
}: {
	toolCalls: any[];
	results: Map<string, ToolResultMessage>;
	isStreaming?: boolean;
}) {
	if (toolCalls.length === 1) {
		return (
			<ToolCallCard
				toolCall={toolCalls[0]}
				result={results.get(toolCalls[0].id)}
				isStreaming={isStreaming}
			/>
		);
	}
	return (
		<ToolGroupCardInner
			toolCalls={toolCalls}
			results={results}
			isStreaming={isStreaming}
		/>
	);
}

function ToolGroupCardInner({
	toolCalls,
	results,
	isStreaming,
}: {
	toolCalls: any[];
	results: Map<string, ToolResultMessage>;
	isStreaming?: boolean;
}) {
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
	const { open, toggle } = useAutoCollapse({
		isStreaming,
		isDone: doneCount === total,
		executingMode: true,
	});

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
			title={`${total} 个工具调用`}
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
					<ToolCallCard
						key={tc.id}
						toolCall={tc}
						result={results.get(tc.id)}
						isStreaming={isStreaming}
					/>
				))}
			</div>
		</ProcessCard>
	);
}
