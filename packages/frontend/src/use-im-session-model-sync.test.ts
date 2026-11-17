// IM 会话进入时输入框模型同步 hook 的行为契约。
// 修复背景（最终审查 Important-2）：缺 bot 且 bots 为空时补拉一次——原实现无守卫，
// loadBots 对空结果也总是产生新数组引用 → effect 恒真重跑 → 无限 GET /api/channels。
// 本套件锁：补拉在挂载生命周期内至多一次；bots 恒空时切换会话也不再发起第二次请求；
// 同时锁住原有语义（非空缺 bot 放弃同步 / bot 存在时写入解析出的模型）。
import { test, expect, beforeEach, afterEach } from "bun:test";
import { renderHook, act, cleanup } from "@testing-library/react";

import { useImSessionModelSync } from "./use-im-session-model-sync";
import { useProjectsStore } from "./store/projects";
import { useChannelsStore } from "./store/channels";
import { useAgentsStore } from "./store/agents";
import { useComposerPrefsStore } from "./store/composer-prefs";

let loadBotsCalls: number;
let initModelCalls: Array<[string, string | null]>;

function resetStores() {
	loadBotsCalls = 0;
	initModelCalls = [];
	(useProjectsStore.setState as any)({ currentSessionId: null });
	(useChannelsStore.setState as any)({
		bots: [],
		conversations: [],
		loadBots: async () => {
			loadBotsCalls += 1;
			// 复刻真实 store：空结果也总是 set 新数组引用（这正是循环的成因）
			(useChannelsStore.setState as any)({ bots: [] });
		},
	});
	(useAgentsStore.setState as any)({ list: [] });
	(useComposerPrefsStore.setState as any)({
		initSessionModel: async (sessionId: string, model: string | null) => {
			initModelCalls.push([sessionId, model]);
		},
	});
}

function setScenario(opts: {
	currentSessionId: string | null;
	conversations: Array<{ sessionId: string; channelId: string }>;
	bots: Array<any>;
}) {
	(useProjectsStore.setState as any)({ currentSessionId: opts.currentSessionId });
	(useChannelsStore.setState as any)({
		conversations: opts.conversations,
		bots: opts.bots,
	});
}

beforeEach(resetStores);
afterEach(() => {
	cleanup();
	resetStores();
});

test("bots 恒空：缺 bot 补拉一次后不再重试（切会话重跑 effect 也不二次请求）", () => {
	setScenario({
		currentSessionId: "im-1",
		conversations: [{ sessionId: "im-1", channelId: "bot-x" }],
		bots: [],
	});
	renderHook(() => useImSessionModelSync());
	expect(loadBotsCalls).toBe(1);

	// 切到另一个 IM 会话：effect 重跑，但补拉守卫已置位，不得再发请求
	act(() => {
		setScenario({
			currentSessionId: "im-2",
			conversations: [
				{ sessionId: "im-1", channelId: "bot-x" },
				{ sessionId: "im-2", channelId: "bot-y" },
			],
			bots: [],
		});
	});
	expect(loadBotsCalls).toBe(1);
	// 双方都未配置：不写模型
	expect(initModelCalls).toEqual([]);
});

test("bots 非空但缺该 bot（机器人已删除、会话映射残留）→ 放弃同步且不补拉", () => {
	setScenario({
		currentSessionId: "im-1",
		conversations: [{ sessionId: "im-1", channelId: "bot-x" }],
		bots: [{ id: "bot-other", model: "m-9", agentName: "a9" }],
	});
	renderHook(() => useImSessionModelSync());
	expect(loadBotsCalls).toBe(0);
	expect(initModelCalls).toEqual([]);
});

test("bot 存在且配置了模型 → initSessionModel 写入 channel.model", () => {
	setScenario({
		currentSessionId: "im-1",
		conversations: [{ sessionId: "im-1", channelId: "bot-x" }],
		bots: [{ id: "bot-x", model: "m-1", agentName: "a1" }],
	});
	renderHook(() => useImSessionModelSync());
	expect(loadBotsCalls).toBe(0);
	expect(initModelCalls).toEqual([["im-1", "m-1"]]);
});

test("非 IM 会话（无匹配 conversation）→ 不动作", () => {
	setScenario({
		currentSessionId: "web-1",
		conversations: [],
		bots: [{ id: "bot-x", model: "m-1", agentName: "a1" }],
	});
	renderHook(() => useImSessionModelSync());
	expect(loadBotsCalls).toBe(0);
	expect(initModelCalls).toEqual([]);
});
