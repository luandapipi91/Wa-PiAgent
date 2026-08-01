import type { ReactNode } from "react";
import type { ToolCall, ToolResultMessage } from "@wa-pi/shared";
import { ProcessCard, Spinner } from "./ProcessCard";
import { useAutoCollapse } from "./useAutoCollapse";

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

/** 多行/长字符串代码块样式：真实换行缩进展示，限高防撑爆 UI */
const CODE_BLOCK_CLS =
	"max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-surface px-2 py-1 text-[11px] text-secondary my-1 font-mono";

/** 递归渲染参数值：多行/长字符串以真实文本代码块展示，其余保持 JSON 风格 */
function ArgValue({ v }: { v: any }): ReactNode {
	if (typeof v === "string") {
		if (v.includes("\n") || v.length > 60) {
			return <pre className={CODE_BLOCK_CLS}>{v}</pre>;
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
					<div className="text-[11px] text-tertiary font-semibold mb-0.5">
						{edits.length > 1 ? `编辑 ${i + 1}` : "内容变更"}
					</div>
					{e.oldText !== undefined && (
						<>
							<div className="text-[11px] text-tertiary">旧</div>
							<pre className={CODE_BLOCK_CLS}>{e.oldText}</pre>
						</>
					)}
					{e.newText !== undefined && (
						<>
							<div className="text-[11px] text-tertiary">新</div>
							<pre className={CODE_BLOCK_CLS}>{e.newText}</pre>
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
			icon={!result ? "🔧" : failed ? "✗" : "✓"}
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

	const status: string[] = [];
	if (successCount > 0) status.push(`✓${successCount}`);
	if (failedCount > 0) status.push(`✗${failedCount}`);
	if (doneCount < total) status.push(`⏳${total - doneCount}`);

	return (
		<ProcessCard
			tone="accent"
			icon="🔧"
			title={`${total} 个工具调用`}
			meta={
				doneCount < total && isStreaming ? (
					<>
						<Spinner />
						<span>{status.join(" ")}</span>
					</>
				) : (
					status.join(" ")
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
