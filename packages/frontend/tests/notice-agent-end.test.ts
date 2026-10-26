// 任务完成通知触发接线：agent_end 真实终态 → requestTaskDoneNotice（与提示音/青蛙/庆祝同口径：
// 非 im- 前缀、非 sched- 前缀、非 synthetic、非 willRetry 中间态）
import { beforeEach, expect, mock, test } from "bun:test";
import type { SDKEventEnvelope } from "@wa-pi/shared";

const noticeCalls: string[] = [];

// mock 掉通知模块，只计数 requestTaskDoneNotice 的调用（session.ts 是它唯一的消费方）
mock.module("../src/store/notice", () => ({
	requestTaskDoneNotice: (sessionId: string) => {
		noticeCalls.push(sessionId);
	},
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

// 提示音 mock 掉，避免测试期间真实响铃
mock.module("../src/util/sound", () => ({
	playTaskDone: () => {},
	playNeedsAction: () => {},
	previewTaskDone: () => {},
	previewNeedsAction: () => {},
	resetSoundForTests: () => {},
}));

import { useSessionStore } from "../src/store/session";
import { useProjectsStore } from "../src/store/projects";
import { useUiPrefsStore } from "../src/store/ui-prefs";

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
	noticeCalls.length = 0;
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
	useUiPrefsStore.setState({ soundSchedTaskDone: false });
});

test("普通会话 agent_end（willRetry:false、非 synthetic）→ 调一次，参数为 sessionId", () => {
	useSessionStore
		.getState()
		.handleSDKEvent(
			"s1",
			envelope({ type: "agent_end", willRetry: false } as any),
		);
	expect(noticeCalls).toEqual(["s1"]);
});

test("im- 前缀会话 → 不调", () => {
	// 即使 soundSchedTaskDone 之类开关为真，IM 渠道会话也不发通知（与提示音同口径）
	const imSessionId = "im-wecom-p1-123";
	useUiPrefsStore.setState({ soundSchedTaskDone: true });
	useSessionStore
		.getState()
		.handleSDKEvent(
			imSessionId,
			envelope({ type: "agent_end", willRetry: false } as any, imSessionId),
		);
	expect(noticeCalls).toEqual([]);
});

test("sched- 前缀会话 → 不调", () => {
	const schedSessionId = "sched-p1-abc123";
	useSessionStore
		.getState()
		.handleSDKEvent(
			schedSessionId,
			envelope({ type: "agent_end", willRetry: false } as any, schedSessionId),
		);
	expect(noticeCalls).toEqual([]);
});

test("synthetic agent_end → 不调", () => {
	// kernel 兑底合成的 agent_end（扩展命令/compact/abort 复位）不是真实任务完成
	useSessionStore
		.getState()
		.handleSDKEvent(
			"s1",
			envelope({ type: "agent_end", willRetry: false, synthetic: true } as any),
		);
	expect(noticeCalls).toEqual([]);
});

test("willRetry:true 中间态 → 不调", () => {
	// 自动重试退避中的单次失败只是中间态，等真正终态才通知
	useSessionStore
		.getState()
		.handleSDKEvent(
			"s1",
			envelope({ type: "agent_end", willRetry: true } as any),
		);
	expect(noticeCalls).toEqual([]);
});
