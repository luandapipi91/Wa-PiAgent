// 青蛙动画触发接线：agent_end 终态 → triggerTaskDoneFrog(sessionId)
import { beforeEach, expect, mock, test } from "bun:test";
import type { SDKEventEnvelope } from "@wa-pi/shared";

const frogCalls = { trigger: 0 };

mock.module("../src/util/frog", () => ({
	triggerTaskDoneFrog: (_sessionId: string) => frogCalls.trigger++,
	pickFrogVariant: () => "sign",
	pickFrogSpot: () => "dl",
	resetFrogVariantCycle: () => {},
	FROG_VARIANTS: ["sign"],
	FROG_SPOTS: ["dl"],
}));

mock.module("../src/util/sound", () => ({
	playTaskDone: () => {},
	playNeedsAction: () => {},
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
	frogCalls.trigger = 0;
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

test("agent_end 终态（willRetry:false）→ 触发一次青蛙动画", () => {
	useSessionStore
		.getState()
		.handleSDKEvent(
			"s1",
			envelope({ type: "agent_end", willRetry: false } as any),
		);
	expect(frogCalls.trigger).toBe(1);
});

test("agent_end 中间态（willRetry:true，自动重试退避中）→ 不触发", () => {
	useSessionStore
		.getState()
		.handleSDKEvent(
			"s1",
			envelope({ type: "agent_end", willRetry: true } as any),
		);
	expect(frogCalls.trigger).toBe(0);
});

test("IM 渠道会话（im- 前缀）→ 不触发", () => {
	useSessionStore
		.getState()
		.handleSDKEvent(
			"im-x",
			envelope({ type: "agent_end", willRetry: false } as any, "im-x"),
		);
	expect(frogCalls.trigger).toBe(0);
});

test("agent_end 合成事件（synthetic:true，kernel 兑底复位）→ 不触发青蛙动画", () => {
	// kernel 的扩展命令/compact/abort 兑底合成 agent_end 不是真实任务完成，不蹦青蛙
	useSessionStore
		.getState()
		.handleSDKEvent(
			"s1",
			envelope({ type: "agent_end", willRetry: false, synthetic: true } as any),
		);
	expect(frogCalls.trigger).toBe(0);
});
