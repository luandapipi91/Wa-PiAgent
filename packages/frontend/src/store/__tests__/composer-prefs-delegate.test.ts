// 会话级委派设置（delegateModel / delegateThinking）store 层契约 + delegateEcho 回显纯函数：
// 1. delegateEcho：两栏独立回显，各自缺省为 null，两栏全部缺省合并 collapsed=true
// 2. loadSession 读旧记录（无 delegate 字段）→ 读出值按 undefined（跟随）处理
// 3. clearStaleModels 悬空清理只作用于 delegateModel，不碰 delegateThinking（两栏独立）
import { test, expect, beforeEach, mock } from "bun:test";

// ---- mock composer-db：内存模拟 IndexedDB 记录与 defaults，捕获写盘 ----
const storedMap = new Map<string, any>();
const idbWrites: any[] = [];
let defaultsStore: {
	model: string | null;
	thinkingByModel: Record<string, string>;
	delegateModel?: string | null;
	delegateThinking?: string | null;
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

import { useProvidersStore } from "../providers";

const {
	useComposerPrefsStore,
	_resetDefaultsHydration,
	_resetSessionHydration,
	delegateEcho,
} = await import("../composer-prefs");

function resetAll() {
	_resetDefaultsHydration();
	_resetSessionHydration();
	useComposerPrefsStore.setState({
		defaults: {
			model: "global/default-model",
			thinkingByModel: {},
			delegateModel: null,
			delegateThinking: null,
		},
		bySession: {},
		loadedBySession: {},
		newSessionIds: {},
	});
	// fresh 分支悬空校验要读 providers store：重置避免跨用例泄漏
	useProvidersStore.setState({ providers: [] });
	storedMap.clear();
	idbWrites.length = 0;
	defaultsStore = {
		model: "global/default-model",
		thinkingByModel: {},
		delegateModel: null,
		delegateThinking: null,
	};
}

beforeEach(() => resetAll());

// 测试用 provider 目录：prov/m1 存在，prov/gone 不存在（悬空）
const providers: any[] = [
	{
		id: "p1",
		name: "Prov",
		baseUrl: "https://api.prov.com/v1",
		apiKey: "sk-test",
		api: "openai-completions",
		slug: "prov",
		models: [{ id: "m1", contextWindow: 128000, maxTokens: 4096 }],
	},
];

test("delegateEcho：两栏独立回显，全缺省合并 collapsed=true", () => {
	// 全部缺省（无参 / null / undefined）→ 合并单段形态，两栏均为 null（展示层显示「跟随」）
	expect(delegateEcho()).toEqual({
		collapsed: true,
		modelText: null,
		thinkingText: null,
	});
	expect(delegateEcho(null, null)).toEqual({
		collapsed: true,
		modelText: null,
		thinkingText: null,
	});
	expect(delegateEcho(undefined, undefined)).toEqual({
		collapsed: true,
		modelText: null,
		thinkingText: null,
	});
	// 只有模型：modelText 短名 = "/" 后段；思考栏缺省为 null（跟随）
	expect(delegateEcho("prov/m1", null)).toEqual({
		collapsed: false,
		modelText: "m1",
		thinkingText: null,
	});
	// 只有思考：模型栏缺省为 null（跟随）
	expect(delegateEcho(null, "max")).toEqual({
		collapsed: false,
		modelText: null,
		thinkingText: "max",
	});
	// 两栏都有值
	expect(delegateEcho("prov/m1", "max")).toEqual({
		collapsed: false,
		modelText: "m1",
		thinkingText: "max",
	});
});

test("loadSession 读旧记录（无 delegate 字段）→ delegate 字段为 undefined（跟随）", async () => {
	storedMap.set("sess-old", {
		sessionId: "sess-old",
		model: "prov/m1",
		thinking: "high",
		attachments: [],
		updatedAt: 1,
		// 旧记录：无 delegateModel / delegateThinking 字段
	});
	await useComposerPrefsStore.getState().loadSession("sess-old");

	const prefs = useComposerPrefsStore.getState().bySession["sess-old"];
	expect(prefs?.delegateModel).toBeUndefined();
	expect(prefs?.delegateThinking).toBeUndefined();
});

test("clearStaleModels：悬空 delegateModel 清 null、delegateThinking 不动（两栏独立）", async () => {
	storedMap.set("sess-del", {
		sessionId: "sess-del",
		model: "prov/m1",
		thinking: "high",
		attachments: [],
		delegateModel: "prov/gone",
		delegateThinking: "max",
		updatedAt: 1,
	});
	await useComposerPrefsStore.getState().loadSession("sess-del");
	idbWrites.length = 0; // 清掉 loadSession 无关写盘，聚焦 clearStaleModels 的落盘

	useComposerPrefsStore.getState().clearStaleModels(providers);

	const prefs = useComposerPrefsStore.getState().bySession["sess-del"];
	// 悬空委派模型清 null；委派思考保持不动；主模型可用也不清
	expect(prefs?.delegateModel).toBe(null);
	expect(prefs?.delegateThinking).toBe("max");
	expect(prefs?.model).toBe("prov/m1");
	// 落盘同样只清 delegateModel、保留 delegateThinking 与主模型
	const rec = idbWrites.find((r) => r.sessionId === "sess-del");
	expect(rec?.delegateModel).toBe(null);
	expect(rec?.delegateThinking).toBe("max");
	expect(rec?.model).toBe("prov/m1");
});

// ---- null 特判回归（审查修复）：normalizeThinkingLevel(null) 会兜底成 "default"，
// 而 loadSession 落盘缺省形状就是 delegateThinking: null——读回时必须保持「跟随」，
// 不得被归一成显式档位并二次落盘固化。fresh 与 existing 两分支分别覆盖 ----
test("loadSession 读持久层 delegateThinking: null（fresh 分支）→ 保持跟随，不归一成显式 default", async () => {
	storedMap.set("sess-null-fresh", {
		sessionId: "sess-null-fresh",
		model: "prov/m1",
		thinking: "high",
		attachments: [],
		delegateModel: "prov/m1",
		delegateThinking: null, // 本任务 loadSession 统一落盘产生的缺省形状
		updatedAt: 1,
	});
	await useComposerPrefsStore.getState().loadSession("sess-null-fresh");

	const prefs = useComposerPrefsStore.getState().bySession["sess-null-fresh"];
	expect(prefs?.delegateModel).toBe("prov/m1");
	// null/undefined 均为「跟随」：不得变成显式 "default"（会回显「委派 · 跟随 / default」）
	expect(prefs?.delegateThinking == null).toBe(true);
});

test("loadSession 二次读取（existing 分支）null delegateThinking → 保持跟随，落盘不固化成 default", async () => {
	storedMap.set("sess-null-exist", {
		sessionId: "sess-null-exist",
		model: "prov/m1",
		thinking: "high",
		attachments: [],
		delegateModel: "prov/m1",
		delegateThinking: null,
		updatedAt: 1,
	});
	await useComposerPrefsStore.getState().loadSession("sess-null-exist"); // 第一次：fresh 分支
	idbWrites.length = 0;
	await useComposerPrefsStore.getState().loadSession("sess-null-exist"); // 第二次：existing 分支（无 gap，统一落盘）

	const prefs = useComposerPrefsStore.getState().bySession["sess-null-exist"];
	expect(prefs?.delegateThinking == null).toBe(true);
	// 落盘必须保持 null（跟随），不得把归一结果 "default" 固化进持久层
	const rec = idbWrites.find((r) => r.sessionId === "sess-null-exist");
	expect(rec?.delegateThinking).toBe(null);
});

// ---- 全局默认层（defaults）：手动选择回写 + 新会话初始化 ----

/** 委派用 providers（prov/m1 存在）注入 providers store：fresh 分支悬空校验从 store 现读 */
function seedDelegateProviders() {
	useProvidersStore.setState({ providers });
}

// ① 手动改委派 → 全局默认回写（内存 + 持久层）
test("① 手动改委派 → defaults 回写 delegateModel/delegateThinking（含持久化）", async () => {
	await useComposerPrefsStore.getState().loadDefaults(); // 先 hydrate，回写才允许落盘

	useComposerPrefsStore
		.getState()
		.setSessionPrefs("s1", { delegateModel: "prov/m1", delegateThinking: "max" });

	// 内存 defaults
	expect(useComposerPrefsStore.getState().defaults.delegateModel).toBe("prov/m1");
	expect(useComposerPrefsStore.getState().defaults.delegateThinking).toBe("max");
	// 持久层（mock setDefaults 合并写回）同样拿到
	expect(defaultsStore.delegateModel).toBe("prov/m1");
	expect(defaultsStore.delegateThinking).toBe("max");
});

// ② 手动改回跟随 → 全局默认记 null
test("② 手动改回跟随 → defaults 记 null（跟随）", async () => {
	// 安排：defaults 已有上次的 m1/max（store + 持久层一致）再 hydrate
	defaultsStore = {
		model: "global/default-model",
		thinkingByModel: {},
		delegateModel: "prov/m1",
		delegateThinking: "max",
	};
	await useComposerPrefsStore.getState().loadDefaults();

	useComposerPrefsStore
		.getState()
		.setSessionPrefs("s1", { delegateModel: null, delegateThinking: null });

	expect(useComposerPrefsStore.getState().defaults.delegateModel).toBe(null);
	expect(useComposerPrefsStore.getState().defaults.delegateThinking).toBe(null);
	expect(defaultsStore.delegateModel).toBe(null);
	expect(defaultsStore.delegateThinking).toBe(null);
});

// ③ 程序化写入不污染全局
test("③ syncDefaults:false 的写入不改 defaults（保持 ② 后的 null）", async () => {
	// 安排：先手动改回跟随（② 的终态）
	await useComposerPrefsStore.getState().loadDefaults();
	useComposerPrefsStore
		.getState()
		.setSessionPrefs("s1", { delegateModel: null, delegateThinking: null });

	useComposerPrefsStore
		.getState()
		.setSessionPrefs("s2", { delegateModel: "prov/m2" }, { syncDefaults: false });

	expect(useComposerPrefsStore.getState().defaults.delegateModel).toBe(null);
	expect(defaultsStore.delegateModel).toBe(null);
});

// ③b hydration guard：loadDefaults 完成前的委派回写同样不得持久化
test("③b hydration guard：未 loadDefaults 前委派回写只更新内存，不持久化", () => {
	useComposerPrefsStore
		.getState()
		.setSessionPrefs("s1", { delegateModel: "prov/m1", delegateThinking: "max" });

	// 内存已更新
	expect(useComposerPrefsStore.getState().defaults.delegateModel).toBe("prov/m1");
	// 持久层未被污染（仍是 resetAll 的 null，不得写入 delegate 字段）
	expect(defaultsStore.delegateModel).toBe(null);
	expect(defaultsStore.delegateThinking).toBe(null);
});

// ④ 旧持久化结构兼容：getDefaults 输出无 delegate 字段 → loadDefaults 后两字段 === null，不报错
test("④ 旧持久化结构（无 delegate 字段）→ loadDefaults 后 delegate 两字段 === null", async () => {
	defaultsStore = {
		model: "global/default-model",
		thinkingByModel: { "prov/m1": "high" },
	} as any; // 旧结构：无 delegate 字段

	await useComposerPrefsStore.getState().loadDefaults();

	const defaults = useComposerPrefsStore.getState().defaults;
	expect(defaults.delegateModel).toBe(null);
	expect(defaults.delegateThinking).toBe(null);
});

// ⑤ fresh 会话初始化：无存储记录的新 sessionId 从 defaults 读委派初始值
test("⑤ fresh 会话初始化：defaults 的 delegateModel/delegateThinking 带入新会话", async () => {
	seedDelegateProviders();
	defaultsStore = {
		model: "prov/m1",
		thinkingByModel: {},
		delegateModel: "prov/m1",
		delegateThinking: "max",
	};
	await useComposerPrefsStore.getState().loadDefaults();

	await useComposerPrefsStore.getState().loadSession("sess-fresh"); // 无存储记录

	const prefs = useComposerPrefsStore.getState().bySession["sess-fresh"];
	expect(prefs?.delegateModel).toBe("prov/m1");
	expect(prefs?.delegateThinking).toBe("max");
});

// ⑥ 会话已有自己的值优先：fresh 初始化不用 defaults 覆盖
test("⑥ stored 已有 delegateThinking（high）→ 不被 defaults 的 max 覆盖", async () => {
	seedDelegateProviders();
	defaultsStore = {
		model: "prov/m1",
		thinkingByModel: {},
		delegateModel: "prov/m1",
		delegateThinking: "max",
	};
	await useComposerPrefsStore.getState().loadDefaults();
	storedMap.set("sess-own", {
		sessionId: "sess-own",
		model: "prov/m1",
		thinking: "high",
		attachments: [],
		delegateThinking: "high", // 会话自己的委派思考记录（无 delegateModel 字段）
		updatedAt: 1,
	});

	await useComposerPrefsStore.getState().loadSession("sess-own");

	const prefs = useComposerPrefsStore.getState().bySession["sess-own"];
	expect(prefs?.delegateThinking).toBe("high");
	// 无 delegateModel 字段的栏独立从 defaults 读（两栏独立）
	expect(prefs?.delegateModel).toBe("prov/m1");
});

// ⑦ 全局默认悬空：fresh 初始化 delegateModel 回退 null（跟随），delegateThinking 保持 defaults 值
test("⑦ defaults.delegateModel 悬空 → fresh 初始化回退 null，delegateThinking 保持 defaults", async () => {
	seedDelegateProviders(); // prov/gone 不在列表 → 悬空
	defaultsStore = {
		model: "prov/m1",
		thinkingByModel: {},
		delegateModel: "prov/gone",
		delegateThinking: "max",
	};
	await useComposerPrefsStore.getState().loadDefaults();

	await useComposerPrefsStore.getState().loadSession("sess-stale");

	const prefs = useComposerPrefsStore.getState().bySession["sess-stale"];
	expect(prefs?.delegateModel).toBe(null);
	expect(prefs?.delegateThinking).toBe("max");
});
