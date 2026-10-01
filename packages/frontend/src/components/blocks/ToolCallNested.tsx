import type { ReactNode } from "react";
import { memo } from "react";
import type { ToolCall, ToolResultMessage } from "@wa-pi/shared";
import { ToolCallCard, ToolGroupCard, formatArgs } from "./ToolCallCard";
import { Linkify } from "./linkify";
import { Spinner } from "./ProcessCard";
import { Icon } from "../ui/Icon";
import { useSessionStore } from "../../store/session";

/**
 * 嵌套工具调用（F18）：codemode 等工具经 `ctx.executeTool()` 发起的调用。
 *
 * pi 侧这类调用**不进 transcript**（不进 assistant 消息的 toolCall 块、也不产生 toolResult 消息），
 * 只以独立事件到达：`tool_execution_start/update/end`，`toolCallId` 形如 `<父id>/N`，
 * 并带 `parentToolCallId`。若不按父 id 归并，聊天区会出现两张平级卡片，用户看不出
 * 「这是脚本里调的一个工具」。历史会话则只有父工具结果上的 `nestedCalls` 有界记录（无结果内容）。
 */
export interface ToolCallView {
	toolCallId: string;
	toolName: string;
	args?: unknown;
	result?: ToolCallResultView;
	parentToolCallId?: string;
	/** 终态：实时来自 tool_execution_end；历史来自 nestedCalls.status；缺省=running（执行中） */
	status?: "running" | "ok" | "error";
}

/** 工具结果在视图中需要的最小形状（内容块 + 结构化 details，供结果文本/diff 统计渲染） */
export interface ToolCallResultView {
	content?: Array<{ type: string; text?: string }>;
	details?: unknown;
}

export interface ToolCallGroup {
	parent: ToolCallView;
	children: ToolCallView[];
}

/** F18：嵌套调用的 id 形如 <parentId>/N，并带 parentToolCallId */
export function groupToolCalls(calls: ToolCallView[]): ToolCallGroup[] {
	const byId = new Map(calls.map((c) => [c.toolCallId, c]));
	const childrenOf = new Map<string, ToolCallView[]>();
	const roots: ToolCallView[] = [];
	for (const call of calls) {
		const parentId =
			call.parentToolCallId ??
			(call.toolCallId.includes("/")
				? call.toolCallId.slice(0, call.toolCallId.indexOf("/"))
				: undefined);
		if (parentId && byId.has(parentId)) {
			const list = childrenOf.get(parentId) ?? [];
			list.push(call);
			childrenOf.set(parentId, list);
		} else {
			roots.push(call);
		}
	}
	return roots.map((parent) => ({
		parent,
		children: childrenOf.get(parent.toolCallId) ?? [],
	}));
}

/** 父工具结果里持久化的嵌套调用记录（pi nested-tool-calls：`<父id>/N` + name/arguments/status）。
 *  历史消息只有这份记录、没有结果内容；实时链路以事件流数据为准（优先）。形状不符的条目直接丢弃
 *  ——记录来自会话文件，畸形数据不能拖垮整行渲染。 */
export function persistedNestedCalls(result: unknown): ToolCallView[] {
	const records = (result as { nestedCalls?: unknown } | undefined)?.nestedCalls;
	if (!Array.isArray(records)) return [];
	const views: ToolCallView[] = [];
	for (const rec of records) {
		if (!rec || typeof rec !== "object") continue;
		const r = rec as Record<string, unknown>;
		if (typeof r.id !== "string" || typeof r.name !== "string") continue;
		views.push({
			toolCallId: r.id,
			toolName: r.name,
			args: r.arguments,
			status:
				r.status === "error" ? "error" : r.status === "unfinished" ? "running" : "ok",
		});
	}
	return views;
}

/** ToolCallView → ToolCallCard 入参（参数非对象时退化为空参数，不让畸形数据炸掉卡片） */
function viewToToolCall(view: ToolCallView): ToolCall {
	const args =
		view.args && typeof view.args === "object"
			? (view.args as Record<string, unknown>)
			: {};
	return { type: "toolCall", id: view.toolCallId, name: view.toolName, arguments: args };
}

/** ToolCallView → ToolResultMessage 形（供父卡复用既有结果渲染/统计逻辑；无结果返回 undefined=执行中） */
function viewToResult(view: ToolCallView): ToolResultMessage | undefined {
	if (!view.result) return undefined;
	return {
		role: "toolResult",
		toolCallId: view.toolCallId,
		toolName: view.toolName,
		content: (view.result.content ?? []) as ToolResultMessage["content"],
		isError: view.status === "error",
		timestamp: 0,
		details: view.result.details,
	};
}

/** 内层子卡：紧凑单行（工具名 + 参数摘要 + 状态），结果紧随其后。
 *  有意不复用 ToolCallCard 的折叠态——子卡是「脚本调了哪些工具」的答案，
 *  父卡折叠时也必须可见；且内层结果通常很短，不值得再点一次。 */
const NestedToolCallCard = memo(function NestedToolCallCard({
	view,
}: {
	view: ToolCallView;
}) {
	const status = view.status ?? (view.result ? "ok" : "running");
	const tone =
		status === "error"
			? "text-danger"
			: status === "running"
				? "text-accent"
				: "text-success";
	const icon: "x" | "wrench" | "check" =
		status === "error" ? "x" : status === "running" ? "wrench" : "check";
	return (
		<div
			data-testid={`toolcall-nested-item-${view.toolCallId}`}
			data-status={status}
			className="rounded border border-hairline bg-surface px-2 py-1 min-w-0"
		>
			<div className="flex items-center gap-1.5 min-w-0">
				<span className={`inline-flex flex-shrink-0 ${tone}`}>
					<Icon name={icon} size={11} />
				</span>
				<span className="font-mono text-[calc(11.5px*var(--font-scale))] text-primary truncate">
					{view.toolName}
				</span>
				<span className="text-[calc(11px*var(--font-scale))] text-tertiary truncate min-w-0">
					({formatArgs(viewToToolCall(view).arguments)})
				</span>
				{status === "running" && (
					<span className="ml-auto flex-shrink-0">
						<Spinner />
					</span>
				)}
			</div>
			{view.result?.content?.map(
				(c, i) =>
					c?.type === "text" &&
					c.text != null && (
						<div
							key={i}
							className={`mt-0.5 text-[calc(11.5px*var(--font-scale))] ${status === "error" ? "text-danger" : "text-secondary"}`}
						>
							<Linkify text={c.text} />
						</div>
					),
			)}
		</div>
	);
});

/** 缩进子卡列表（挂在父卡之后，与父卡左边缘以竖线相连） */
function NestedToolCallList({ views }: { views: ToolCallView[] }) {
	return (
		<div className="mt-1 ml-3 pl-2 border-l border-hairline space-y-1">
			{views.map((view) => (
				<NestedToolCallCard key={view.toolCallId} view={view} />
			))}
		</div>
	);
}

/** 嵌套调用组：外层卡（复用 ToolCallCard 的头部/参数/结果渲染）+ 缩进内层子卡 */
export const ToolCallNested = memo(function ToolCallNested({
	group,
	isStreaming,
}: {
	group: ToolCallGroup;
	isStreaming?: boolean;
}) {
	return (
		<div data-testid={`toolcall-nested-${group.parent.toolCallId}`}>
			<ToolCallCard
				toolCall={viewToToolCall(group.parent)}
				result={viewToResult(group.parent)}
				isStreaming={isStreaming}
			/>
			{group.children.length > 0 && <NestedToolCallList views={group.children} />}
		</div>
	);
});

/** 组装一段连续工具调用的渲染视图：段内父调用 + 各自的嵌套子调用。
 *  子调用来源二选一（同一 toolCallId 以实时事件流为准）：store 的实时表、父结果的持久化记录。 */
function segmentViews(
	toolCalls: any[],
	results: Map<string, ToolResultMessage>,
	liveByParent: Record<string, ToolCallView[]> | undefined,
): ToolCallView[] {
	const views: ToolCallView[] = [];
	for (const tc of toolCalls) {
		const result = results.get(tc.id);
		views.push({
			toolCallId: tc.id,
			toolName: tc.name,
			args: tc.arguments,
			result: result
				? { content: result.content as ToolCallResultView["content"], details: result.details }
				: undefined,
			status: result ? (result.isError ? "error" : "ok") : "running",
		});
		const seen = new Set<string>();
		for (const child of liveByParent?.[tc.id] ?? []) {
			seen.add(child.toolCallId);
			views.push(child);
		}
		for (const child of persistedNestedCalls(result)) {
			if (seen.has(child.toolCallId)) continue;
			views.push({ ...child, parentToolCallId: tc.id });
		}
	}
	return views;
}

/**
 * 一段连续工具调用的渲染入口（MessageList 的 toolCalls 段）。
 *
 * 先把本段的父调用与其嵌套子调用归并成组（groupToolCalls），再交给 ToolGroupCard 渲染：
 * 无嵌套子调用的调用走既有平铺卡片路径（DOM 与改造前一致），有子调用的调用渲染为
 * 「外层卡 + 缩进子卡」。分组/计数/折叠仍由 ToolGroupCard 负责，本组件只做视图组装。
 */
export function ToolCallsSegment({
	sessionId,
	toolCalls,
	results,
	isStreaming,
}: {
	sessionId: string;
	toolCalls: any[];
	results: Map<string, ToolResultMessage>;
	isStreaming?: boolean;
}) {
	// 嵌套调用表按会话读取：部分状态替身（历史单测的 mock store）没有该字段，
	// 缺省当「无嵌套调用」处理，不因缺字段拖垬整行渲染
	const liveByParent = useSessionStore((s) => s.nestedCallsBySession?.[sessionId]);
	const groups = groupToolCalls(segmentViews(toolCalls, results, liveByParent));
	const groupsById = new Map(groups.map((g) => [g.parent.toolCallId, g]));
	const renderItem = (tc: any): ReactNode => {
		const group = groupsById.get(tc.id);
		if (!group || group.children.length === 0) {
			return (
				<ToolCallCard
					toolCall={tc}
					result={results.get(tc.id)}
					isStreaming={isStreaming}
				/>
			);
		}
		return <ToolCallNested group={group} isStreaming={isStreaming} />;
	};
	return (
		<ToolGroupCard
			toolCalls={toolCalls}
			results={results}
			isStreaming={isStreaming}
			renderItem={renderItem}
		/>
	);
}
