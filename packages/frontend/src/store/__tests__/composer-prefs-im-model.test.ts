// IM 接入会话进入时同步机器人模型（initSessionModel）的 store 层契约：
// 1. 仅当该会话在持久层无显式模型记录时写入（不覆盖用户手动选择/已有记录）
// 2. 程序化写入不回写全局 defaults（区别于用户手动 setSessionPrefs——
//    否则点开一个 IM 会话就把「新会话默认模型」污染成机器人模型）
// 3. 与 Composer 挂载 loadSession 的竞态安全（gap 写入合并后仍为机器人模型）
import { test, expect, beforeEach, mock } from "bun:test";

// ---- mock composer-db：内存模拟 IndexedDB 记录与 defaults，捕获写盘 ----
const storedMap = new Map<string, any>();
const idbWrites: any[] = [];
let defaultsStore: {
	model: string | null;
	thinkingByModel: Record<string, string>;
} = {
	model: "global/default-model",
	thinkingByModel: {},
};
mock.module("../composer-db", () => ({
	getSessionPrefs: async (id: string) => storedMap.get(id),
	setSessionPrefs: async (rec: any) => {
		idbWrites.push(rec);
		storedMap.set(rec.sessionId, rec);
	},
	deleteSessionPrefs: async (id: string) => {
		storedMap.delete(id);
	},
	getDefaults: async () => defaultsStore,
	setDefaults: async (d: any) => {
		defaultsStore = { ...defaultsStore, ...d };
	},
	getNewSessionIds: async () => ({}),
	setNewSessionIds: async () => {},
}));

const { useComposerPrefsStore, _resetDefaultsHydration, _resetSessionHydration } =
	await import("../composer-prefs");

function resetAll() {
	_resetDefaultsHydration();
	_resetSessionHydration();
	useComposerPrefsStore.setState({
		defaults: { model: "global/default-model", thinkingByModel: {} },
		bySession: {},
		loadedBySession: {},
		newSessionIds: {},
	});
	storedMap.clear();
	idbWrites.length = 0;
	defaultsStore = { model: "global/default-model", thinkingByModel: {} };
}

beforeEach(() => resetAll());

test("initSessionModel：会话无显式模型记录 → 写入机器人模型，且不回写全局 defaults", async () => {
	const s = useComposerPrefsStore.getState();
	await s.initSessionModel("sess-im-1", "prov/bot-model");

	const prefs = useComposerPrefsStore.getState().bySession["sess-im-1"];
	expect(prefs?.model).toBe("prov/bot-model");
	// 关键契约：程序化同步不污染「新会话默认模型」
	expect(useComposerPrefsStore.getState().defaults.model).toBe(
		"global/default-model",
	);
});

test("initSessionModel：会话已有显式模型记录（用户改过）→ 不覆盖", async () => {
	storedMap.set("sess-im-2", {
		sessionId: "sess-im-2",
		model: "user/picked-model",
		thinking: "high",
		attachments: [],
		updatedAt: 1,
	});
	const s = useComposerPrefsStore.getState();
	// 模拟真实时序：Composer 挂载先 loadSession 恢复用户已有选择，再触发同步
	await s.loadSession("sess-im-2");
	await s.initSessionModel("sess-im-2", "prov/bot-model");

	expect(useComposerPrefsStore.getState().bySession["sess-im-2"]?.model).toBe(
		"user/picked-model",
	);
	// 守卫生效：没有发生任何写盘（用户选择未被机器人模型覆写）
	expect(idbWrites).toHaveLength(0);
});

test("initSessionModel：model 为 null（机器人未配置且智能体未配置）→ no-op", async () => {
	const s = useComposerPrefsStore.getState();
	await s.initSessionModel("sess-im-3", null);
	expect(useComposerPrefsStore.getState().bySession["sess-im-3"]).toBeUndefined();
});

test("initSessionModel：早于 loadSession 调用（Composer 挂载竞态）→ 合并后仍为机器人模型", async () => {
	const s = useComposerPrefsStore.getState();
	// 模拟真实时序：App 的同步 effect 与 Composer 挂载 loadSession 竞争，此处 sync 先跑
	await s.initSessionModel("sess-race", "prov/bot-model");
	await s.loadSession("sess-race");

	expect(useComposerPrefsStore.getState().bySession["sess-race"]?.model).toBe(
		"prov/bot-model",
	);
	// 全局 defaults 不被竞态路径污染
	expect(useComposerPrefsStore.getState().defaults.model).toBe(
		"global/default-model",
	);
});

test("setSessionPrefs 默认行为不变：显式改 model 仍同步全局 defaults（现有语义回归保护）", async () => {
	const s = useComposerPrefsStore.getState();
	await s.loadSession("sess-manual");
	s.setSessionPrefs("sess-manual", { model: "user/switched" });

	expect(useComposerPrefsStore.getState().defaults.model).toBe("user/switched");
});

test("setSessionPrefs 传 syncDefaults:false → defaults 不变（程序化写入复用守卫逻辑）", async () => {
	const s = useComposerPrefsStore.getState();
	await s.loadSession("sess-opt");
	s.setSessionPrefs("sess-opt", { model: "prov/bot-model" }, { syncDefaults: false });

	expect(useComposerPrefsStore.getState().bySession["sess-opt"]?.model).toBe(
		"prov/bot-model",
	);
	expect(useComposerPrefsStore.getState().defaults.model).toBe(
		"global/default-model",
	);
});

test("initSessionModel：同步模型后，会话思考档按新模型记录重算（不残留旧模型档位）", async () => {
	// 该会话在 IDB 里存着旧模型时期留下的 thinking=max，但**没有**显式 model
	// （initSessionModel 的前提是 stored.model 为空；thinking 是历史残留）
	storedMap.set("sess-im-think", {
		sessionId: "sess-im-think",
		thinking: "max",
		attachments: [],
	});

	await useComposerPrefsStore.getState().initSessionModel("sess-im-think", "p/bot");

	const prefs = useComposerPrefsStore.getState().bySession["sess-im-think"];
	expect(prefs?.model).toBe("p/bot");
	// 关键断言：p/bot 无记录 → 该会话思考档应为 default，而不是沿用旧模型 p/old 的 max
	expect(prefs?.thinking).toBe("default");
});
