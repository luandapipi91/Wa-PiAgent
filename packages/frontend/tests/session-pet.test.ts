// 桌面宠物庆祝接线：agent_end 真实终态 → celebrateDesktopPet()
import { beforeEach, expect, mock, test } from "bun:test";
import type { SDKEventEnvelope } from "@wa-pi/shared";

const petCalls = { celebrate: 0, frog: 0 };

mock.module("../src/util/desktop-pet", () => ({
	setDesktopPetEnabled: () => {},
	celebrateDesktopPet: () => petCalls.celebrate++,
	onDesktopPetEvent: () => () => {},
}));

mock.module("../src/util/frog", () => ({
	triggerTaskDoneFrog: () => petCalls.frog++,
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
	petCalls.celebrate = 0;
	petCalls.frog = 0;
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

test("agent_end 终态 → 宠物庆祝一次", () => {
	useSessionStore
		.getState()
		.handleSDKEvent("s1", envelope({ type: "agent_end", willRetry: false } as any));
	expect(petCalls.celebrate).toBe(1);
});

test("agent_end 中间态（willRetry:true）→ 不庆祝", () => {
	useSessionStore
		.getState()
		.handleSDKEvent("s1", envelope({ type: "agent_end", willRetry: true } as any));
	expect(petCalls.celebrate).toBe(0);
});

test("合成 agent_end（synthetic:true，abort/compact 兜底）→ 不庆祝", () => {
	useSessionStore
		.getState()
		.handleSDKEvent(
			"s1",
			envelope({ type: "agent_end", willRetry: false, synthetic: true } as any),
		);
	expect(petCalls.celebrate).toBe(0);
});

test("IM 渠道会话（im- 前缀）→ 宠物照常庆祝（与青蛙动画的取舍无关）", () => {
	useSessionStore
		.getState()
		.handleSDKEvent(
			"im-x",
			envelope({ type: "agent_end", willRetry: false } as any, "im-x"),
		);
	expect(petCalls.celebrate).toBe(1);
	expect(petCalls.frog).toBe(0);
});

test("定时任务会话（sched- 前缀）→ 宠物照常庆祝", () => {
	useSessionStore
		.getState()
		.handleSDKEvent(
			"sched-1",
			envelope({ type: "agent_end", willRetry: false } as any, "sched-1"),
		);
	expect(petCalls.celebrate).toBe(1);
});
