import { test, expect, beforeEach, mock } from "bun:test";
import { render, act } from "@testing-library/react";
import type { SessionMessage } from "@wa-pi/shared";

// 流式卡顿回归测试：mock react-markdown 并统计渲染次数。
// 修复前：streaming 每帧变化 → MessageList 全量重渲染 → 所有历史行的 Markdown 重新解析。
// 修复后：preprocess useMemo + MessageRow memo → 只有合并的流式末行重渲染。
let mdRenderCount = 0;
// 简化 Virtuoso 的 Context stub（全量渲染 mock 下无尺寸语义）
const VirtuosoMockContext = { Provider: ({ children }: any) => children };
mock.module("react-markdown", () => ({
	default: (props: any) => {
		mdRenderCount++;
		return <div data-testid="md-mock">{props.children}</div>;
	},
}));

import { MessageList } from "../src/components/MessageList";
// MessageList 现带 initialTopMostItemIndex（末行贴底），VirtuosoMockContext 下会从
// 末行起渲染导致历史行不在视口、计数为 0。此测试契约是「历史行不重解析」的渲染计数，
// 用全量渲染的简化 Virtuoso（所有行参与计数，契约更严）。
mock.module("react-virtuoso", () => ({
	Virtuoso: (props: any) => {
		const { data, itemContent, computeItemKey, ...rest } = props;
		void rest;
		return (
			<div data-testid="message-list">
				{data.map((vr: any, i: number) => (
					<div key={computeItemKey ? computeItemKey(i, vr) : i}>
						{itemContent(i, vr)}
					</div>
				))}
			</div>
		);
	},
	VirtuosoMockContext: { Provider: ({ children }: any) => children },
	VirtuosoHandle: null,
}));
import { useSessionStore } from "../src/store/session";
import { useProjectsStore } from "../src/store/projects";

function userMsg(timestamp: number, text: string): SessionMessage {
	return {
		agentName: undefined,
		message: { role: "user", content: text, timestamp },
	} as SessionMessage;
}

function assistantMsg(
	timestamp: number,
	text: string,
	agentName: SessionMessage["agentName"] = "product",
): SessionMessage {
	return {
		agentName,
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			model: "pi-test",
			stopReason: "end_turn",
			timestamp,
		},
	} as SessionMessage;
}

function streamingMsg(text: string): SessionMessage {
	return {
		agentName: "product",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			model: "pi-test",
			timestamp: 99,
		},
	} as SessionMessage;
}

beforeEach(() => {
	mdRenderCount = 0;
	useSessionStore.setState({ messagesBySession: {}, streamingBySession: {} });
	useProjectsStore.setState({ sessions: [] });
});

test("流式更新时历史消息行不重渲染（Markdown 不重解析）", () => {
	useSessionStore.setState({
		messagesBySession: {
			s1: [
				userMsg(1, "问题一"),
				assistantMsg(2, "回答一"),
				userMsg(3, "问题二"),
				assistantMsg(4, "回答二"),
			],
		},
	});
	// 注：MessageList 现带 initialTopMostItemIndex（末行贴底），mock Virtuoso 的
	// 视口从末行起渲染——4 条消息合并后行数少，两条 assistant 均在渲染范围内。
	render(
		<VirtuosoMockContext.Provider
			value={{ viewportHeight: 800, itemHeight: 60 }}
		>
			<MessageList sessionId="s1" />
		</VirtuosoMockContext.Provider>,
	);
	// 初始：两条 assistant 各渲染一次 Markdown
	const initial = mdRenderCount;
	expect(initial).toBe(2);

	// 流式帧 1：同 agent 的 assistant 增量并入最后一条已完稿 assistant 行（合并行）。
	// 合并行 content = 回答二 + 流式文本 → 2 个 text block；历史行 0 次。
	// 分片 memo：已定稿 block「回答二」被复用（text 引用不变，跨帧跳过），
	// 只有流式中的新 block「流式中」首次渲染 → +1（若整段重解析会 +2）。
	act(() => {
		useSessionStore.setState({
			streamingBySession: { s1: streamingMsg("流式中") },
		});
	});
	expect(mdRenderCount - initial).toBe(1);

	// 流式帧 2：内容增长，仍只有流式中的末 block 重渲染（text 引用变化），已定稿 block 跳过。
	// 节流方案（useThrottledValue）：流式块的 markdown 解析频率有上限（150ms 一次），
	// display 同步会带来一次额外解析；核心契约是历史行（回答一/问题行）永不重解析，
	// 总增量有界且不随历史行数增长（若历史行参与解析会 +4 以上）。
	act(() => {
		useSessionStore.setState({
			streamingBySession: { s1: streamingMsg("流式中……更长了") },
		});
	});
	expect(mdRenderCount - initial).toBeLessThanOrEqual(3);
});

// 全新回合流式路径覆盖：llm-ui 已移除，流式 text 段走 MarkdownBlock（与定稿同路径），
// 由上方"流式更新时历史消息行不重渲染"用例覆盖，不再需要 StreamingMarkdown 专属断言。
