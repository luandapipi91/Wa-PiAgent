import { useState } from "react";
import type { ToolCall, ToolResultMessage } from "@wa-pi/shared";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ProcessCard, Spinner } from "./ProcessCard";
import { useAutoCollapse } from "./useAutoCollapse";
import { createMarkdownComponents } from "./markdown-components";
import { useSessionStore } from "../../store/session";

interface Props {
	sessionId: string;
	toolCall: ToolCall;
	result?: ToolResultMessage;
	isStreaming?: boolean;
}

// 子代理状态文案映射：SubagentProgressEvent.status → 中文展示
function statusLabel(status: string): string {
	if (status === "running") return "运行中";
	if (status === "done") return "完成";
	return "出错";
}

/** 并行派发卡片：展示 fleet（多智能体并行）的委派信息，子任务列表 + 聚合结果。
 *  有实时进度时：默认折叠，摘要行「N 个子智能体：X 运行中 / Y 完成 / Z 出错」+ ▶/▼，
 *  展开后按 agent 分组（每组同 DelegateCard 展开态：agent 名 + 状态 + output + 工具时间线）。
 *  与 delegate 的差异：fleet 一个 toolCallId 下多个 agent，直接消费整个内层 map。 */
export function FleetCard({ sessionId, toolCall, result, isStreaming }: Props) {
	const args = toolCall.arguments as {
		tasks?: Array<{ agent: string; task: string }>;
	};
	const tasks = args.tasks ?? [];
	const { open: autoOpen, toggle } = useAutoCollapse({ isStreaming, isDone: !!result, executingMode: true });

	// 子代理进度：fleet 直接消费整个内层 map（多个 agent 共享同一 toolCallId）
	const agentMap = useSessionStore((s) => s.progressByToolCall[toolCall.id]);
	const agents = agentMap ? Object.values(agentMap) : [];
	const hasProgress = agents.length > 0;

	// 进度态：外层始终展开（保摘要可见），进度详情由 progressExpanded 独立控制（与 DelegateCard 一致）
	const [progressExpanded, setProgressExpanded] = useState(false);
	const open = hasProgress || autoOpen;
	// 有进度时头部点击联动 progressExpanded，与摘要行开关一致
	const handleToggle = hasProgress ? () => setProgressExpanded((v) => !v) : toggle;

	const failed = !!result?.isError;
	const full =
		result?.content
			.map((c: ToolResultMessage["content"][number]) => (c.type === "text" ? c.text : ""))
			.join("\n") ?? "";
	// 将【Agent名】转为 markdown 粗体标题 + 分隔，让各 agent 回复视觉独立
	const formattedFull = full.replace(/【(.+?)】/g, "\n---\n**$1**  \n");
	const mdComponents = createMarkdownComponents(sessionId);

	// 进度摘要计数：按 status 分桶
	const counts = { running: 0, done: 0, error: 0 };
	for (const a of agents) counts[a.status as keyof typeof counts] = (counts[a.status as keyof typeof counts] ?? 0) + 1;

	return (
		<ProcessCard
			tone="warning"
			icon="↪"
			title={`并行派发 ${tasks.length} 个任务`}
			meta={
				!result ? (
					<>
						<Spinner />
						<span>执行中</span>
					</>
				) : failed ? (
					"✗ 失败"
				) : (
					"✓ 完成"
				)
			}
			open={open}
			onToggle={handleToggle}
			muted={!!result}
			testId={`fleet-${toolCall.id}`}
		>
			<div className="mb-1 space-y-1">
				{tasks.map((t, i) => (
					<div key={i} className="flex items-start gap-1.5">
						<span className="text-tertiary flex-shrink-0 mt-0.5">↳</span>
						<span>
							<span className="font-semibold">{t.agent}</span>：{t.task}
						</span>
					</div>
				))}
			</div>
			{hasProgress && (
				<div className="mt-2 pt-2 border-t border-hairline" data-testid={`fleet-progress-${toolCall.id}`}>
					{/* 摘要行：始终可见，点击切换各 agent 进度详情 */}
					<button
						type="button"
						aria-label={progressExpanded ? "折叠" : "展开"}
						onClick={() => setProgressExpanded((v) => !v)}
						className="w-full flex items-center gap-1.5 text-[11px] text-tertiary py-1"
						style={{ cursor: "pointer" }}
					>
						<span>
							{agents.length} 个子智能体：{counts.running} 运行中 / {counts.done} 完成 / {counts.error} 出错
						</span>
						<span className="ml-auto">{progressExpanded ? "▼" : "▶"}</span>
					</button>
					{progressExpanded && (
						<div className="mt-1 min-w-0 space-y-2">
							{agents.map((p) => (
								<div key={p.agent} className="min-w-0">
									{/* 分组标题：agent 名 + 状态 + 耗时 + 工具数 */}
									<div className="text-[11px] text-secondary">
										<span className="font-semibold">{p.agent}</span> · {statusLabel(p.status)} ·{" "}
										{Math.round(p.elapsedMs / 1000)}s · {p.tools.length} 个工具
									</div>
									{/* 实时 output */}
									{p.output && (
										<pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-surface px-2 py-1 text-[11px] text-secondary mb-1">
											{p.output}
										</pre>
									)}
									{/* 工具时间线 */}
									{p.tools.length > 0 && (
										<ul className="text-[11px] text-tertiary space-y-0.5 mb-1">
											{p.tools.map((t) => (
												<li key={t.id}>
													{t.name} · {t.status}
												</li>
											))}
										</ul>
									)}
								</div>
							))}
						</div>
					)}
				</div>
			)}
			{result && (!hasProgress || progressExpanded) && (
				<div
					data-testid="text-block"
					className={`mt-2 pt-2 border-t border-hairline ${failed ? "text-danger" : ""}`}
				>
					<div className="text-[11px] text-tertiary mb-1">📤 回复：</div>
					<ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
						{formattedFull}
					</ReactMarkdown>
				</div>
			)}
		</ProcessCard>
	);
}
