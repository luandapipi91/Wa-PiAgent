// duplicate key 回归测试：修复 MessageList 渲染列表出现 React "same key" 警告。
// 根因：同 turn 的 assistant 消息被 subagent-notification custom 消息隔断，
// collapseSameTurnAssistants 因 custom 占独立行无法合并 → 两条同 agent+timestamp 行 → key 冲突。
// 修复：① preprocess 跳过 subagent-notification（渲染层已过滤，数据层不应占行）
//       ② listRows key 重复时追加序号后缀保证唯一
import { test, expect, beforeEach } from "bun:test";
import { render, screen } from "@testing-library/react";
import { VirtuosoMockContext } from "react-virtuoso";
import type { SessionMessage } from "@wa-pi/shared";
import { MessageList } from "../src/components/MessageList";
import { useSessionStore } from "../src/store/session";
import { useProjectsStore } from "../src/store/projects";

function userMsg(ts: number, text: string): SessionMessage {
	return {
		agentName: undefined,
		message: { role: "user", content: text, timestamp: ts },
	} as SessionMessage;
}
function assistantMsg(
	ts: number,
	text: string,
	agentName = "dev",
): SessionMessage {
	return {
		agentName,
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			model: "m",
			stopReason: "end_turn",
			timestamp: ts,
		},
	} as SessionMessage;
}
function subagentNotification(ts: number, content = "done"): SessionMessage {
	return {
		agentName: undefined,
		message: {
			role: "custom",
			customType: "subagent-notification",
			content,
			timestamp: ts,
		},
	} as any;
}

function renderList(sessionId = "s1") {
	return render(
		<VirtuosoMockContext.Provider
			value={{ viewportHeight: 800, itemHeight: 60 }}
		>
			<MessageList sessionId={sessionId} />
		</VirtuosoMockContext.Provider>,
	);
}

beforeEach(() => {
	useSessionStore.setState({
		messagesBySession: {},
		streamingBySession: {},
		statusBySession: {},
		historyLoadingBySession: {},
	});
	useProjectsStore.setState({ sessions: [] });
});

test("subagent-notification 不打断同 turn assistant 合并（两段文本合为一行）", () => {
	// 同一 turn：assistant(第一段) → subagent-notification → assistant(第二段)
	// notification 渲染层 return null，数据层也应跳过 → collapseSameTurnAssistants 能合并
	useSessionStore.setState({
		messagesBySession: {
			s1: [
				userMsg(1, "问题"),
				assistantMsg(100, "第一段"),
				subagentNotification(
					100,
					"<task-notification>子代理完成</task-notification>",
				),
				assistantMsg(100, "第二段"),
			],
		},
	});
	renderList();
	// 两段文本都应渲染
	expect(screen.getByText("第一段")).toBeTruthy();
	expect(screen.getByText("第二段")).toBeTruthy();
	// notification 内容不渲染
	expect(screen.queryByText("子代理完成")).toBeNull();
});

test("同 agent 同 timestamp 的不同 turn 不产生 duplicate key（序号后缀去重）", () => {
	// 不同 turn（中间有 user 隔断）但 timestamp 巧合相同 → key 基础部分重复
	// 修复：listRows 对重复 key 追加 #序号 → react-virtuoso computeItemKey 全局唯一
	const errors: string[] = [];
	const origError = console.error;
	console.error = (...args: any[]) => {
		errors.push(args.map(String).join(" "));
		origError(...args);
	};

	useSessionStore.setState({
		messagesBySession: {
			s1: [
				userMsg(1, "问题一"),
				assistantMsg(100, "回答一"),
				userMsg(2, "问题二"),
				assistantMsg(100, "回答二"), // 同 agent 同 ts，不同 turn
			],
		},
	});
	renderList();

	console.error = origError;
	// 不应有 React duplicate key 警告
	expect(errors.some((e) => e.includes("same key"))).toBe(false);
	// 两条 assistant 都应渲染
	expect(screen.getByText("回答一")).toBeTruthy();
	expect(screen.getByText("回答二")).toBeTruthy();
});

test("subagent-notification 在不同 agent 回合间也不影响渲染", () => {
	// delegate 场景：主 agent 回复后子代理 notification，再主 agent 续答
	// notification 跳过后两条主 agent assistant 连续 → 合并为一行
	useSessionStore.setState({
		messagesBySession: {
			s1: [
				userMsg(1, "帮我调研"),
				assistantMsg(100, "开始分析", "main"),
				subagentNotification(101, "调研子代理已完成"),
				assistantMsg(100, "分析结论", "main"),
			],
		},
	});
	renderList();
	expect(screen.getByText("开始分析")).toBeTruthy();
	expect(screen.getByText("分析结论")).toBeTruthy();
});
