// 青蛙动画触发接线：agent_end 终态 → triggerTaskDoneFrog(sessionId)
import { beforeEach, expect, mock, test } from "bun:test";
import type { SDKEventEnvelope } from "@wa-pi/shared";

const frogCalls = { trigger: 0 };

mock.module("../src/util/frog", () => ({
	triggerTaskDoneFrog: (_sessionId: string) => frogCalls.trigger++,
	pickFrogPose: () => "sit",
	pickFrogCorner: () => "bl",
	FROG_POSES: ["jump", "sit", "wave", "sleep"],
	FROG_CORNERS: ["tl", "tr", "bl", "br"],
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
