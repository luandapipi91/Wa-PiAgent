import type { ToolCall, ToolResultMessage } from "@hiagent/shared";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ProcessCard, Spinner } from "./ProcessCard";
import { useAutoCollapse } from "./useAutoCollapse";
import { createMarkdownComponents } from "./markdown-components";

interface Props {
	sessionId: string;
	toolCall: ToolCall;
	result?: ToolResultMessage;
	isStreaming?: boolean;
}

/** 并行派发卡片：展示 fleet（多智能体并行）的委派信息，子任务列表 + 聚合结果 */
export function FleetCard({ sessionId, toolCall, result, isStreaming }: Props) {
	const args = toolCall.arguments as {
		tasks?: Array<{ agent: string; task: string }>;
	};
	const tasks = args.tasks ?? [];
	const { open, toggle } = useAutoCollapse({ isStreaming, isDone: !!result });
	const failed = !!result?.isError;
	const full =
		result?.content
			.map((c: ToolResultMessage["content"][number]) =>
				c.type === "text" ? c.text : "",
			)
			.join("\n") ?? "";
	const mdComponents = createMarkdownComponents(sessionId);
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
			onToggle={toggle}
			muted={!isStreaming}
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
			{result && (
				<div
					data-testid="text-block"
					className={`mt-2 pt-2 border-t border-hairline ${failed ? "text-danger" : ""}`}
				>
					<ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
						{full}
					</ReactMarkdown>
				</div>
			)}
		</ProcessCard>
	);
}
