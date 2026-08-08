// 提示音触发接线：agent_end 终态 → playTaskDone；新 ask_user_question → playNeedsAction
import { beforeEach, expect, mock, test } from "bun:test";
import type { SDKEventEnvelope } from "@wa-pi/shared";

const soundCalls = { taskDone: 0, needsAction: 0 };

mock.module("../src/util/sound", () => ({
	playTaskDone: () => soundCalls.taskDone++,
	playNeedsAction: () => soundCalls.needsAction++,
	previewTaskDone: () => {},
	previewNeedsAction: () => {},
	resetSoundForTests: () => {},
}));

// session store 会经 api-client 拉历史/统计，mock 掉避免真实请求
mock.module("../src/api-client", () => ({
	api: {
		get: () => Promise.resolve({ messages: [] }),
		post: () => Promise.resolve({}),
		put: () => Promise.resolve({}),
		del: () => Promise.resolve({}),
	},
}));

import { useSessionStore } from "../src/store/session";
import { useProjectsStore } from "../src/store/projects";

function envelope(
	event: SDKEventEnvelope["event"],
	sessionId = "s1",
): SDKEventEnvelope {
	return {
		type: "sdk:event",
		projectId: "p1",
		sessionId,
		agentName: "dev",
		event,
	};
}

beforeEach(() => {
	soundCalls.taskDone = 0;
	soundCalls.needsAction = 0;
	useSessionStore.setState({
		messagesBySession: {},
		streamingBySession: {},
		statusBySession: {},
		thinkingSinceBySession: {},
		retryBySession: {},
		optimisticEchoBySession: {},
		unreadBySession: {},
		lastUsageBySession: {},
	});
	useProjectsStore.setState({ currentSessionId: "s1" });
});

test("agent_end 终态（willRetry:false）→ 播放任务完成提示音一次", () => {
	useSessionStore
		.getState()
		.handleSDKEvent("s1", envelope({ type: "agent_end", willRetry: false } as any));
	expect(soundCalls.taskDone).toBe(1);
});

test("agent_end 中间态（willRetry:true，自动重试退避中）→ 不播放", () => {
	useSessionStore
		.getState()
		.handleSDKEvent("s1", envelope({ type: "agent_end", willRetry: true } as any));
	expect(soundCalls.taskDone).toBe(0);
});

test("message_end 含新 ask_user_question 工具调用 → 播放需要操作提示音", () => {
	useSessionStore.getState().handleSDKEvent(
		"s1",
		envelope({
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc-1",
						name: "ask_user_question",
						arguments: { question: "选哪个？" },
					},
				],
			},
		} as any),
	);
	expect(soundCalls.needsAction).toBe(1);
});

test("message_end 普通文本回复 → 不播放需要操作提示音", () => {
	useSessionStore.getState().handleSDKEvent(
		"s1",
		envelope({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "你好" }],
			},
		} as any),
	);
	expect(soundCalls.needsAction).toBe(0);
});

test("message_end toolResult → 不播放需要操作提示音", () => {
	useSessionStore.getState().handleSDKEvent(
		"s1",
		envelope({
			type: "message_end",
			message: { role: "toolResult", toolCallId: "tc-1", content: [] },
		} as any),
	);
	expect(soundCalls.needsAction).toBe(0);
});
