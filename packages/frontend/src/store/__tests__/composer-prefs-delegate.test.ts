// 会话级委派设置（delegateModel / delegateThinking）store 层契约 + delegateLabel 回显纯函数：
// 1. delegateLabel：两栏独立回显，各自缺省显示「跟随」，两栏全部缺省合并为「委派 · 跟随」
// 2. loadSession 读旧记录（无 delegate 字段）→ 读出值按 undefined（跟随）处理
// 3. clearStaleModels 悬空清理只作用于 delegateModel，不碰 delegateThinking（两栏独立）
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

const {
	useComposerPrefsStore,
	_resetDefaultsHydration,
	_resetSessionHydration,
	delegateLabel,
} = await import("../composer-prefs");

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

test("delegateLabel：两栏独立回显，全缺省合并为「委派 · 跟随」", () => {
	// 全部缺省（无参 / null / undefined）→ 跟随
	expect(delegateLabel()).toBe("委派 · 跟随");
	expect(delegateLabel(null, null)).toBe("委派 · 跟随");
	expect(delegateLabel(undefined, undefined)).toBe("委派 · 跟随");
	// 只有模型：modelId 短名 = "/" 后段；思考栏缺省显示「跟随」
	expect(delegateLabel("prov/m1", null)).toBe("委派 · m1 / 跟随");
	// 只有思考：模型栏缺省显示「跟随」
	expect(delegateLabel(null, "max")).toBe("委派 · 跟随 / max");
	// 两栏都有值
	expect(delegateLabel("prov/m1", "max")).toBe("委派 · m1 / max");
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
	// 主模型 prov/m1 可用；委派模型 prov/gone 已不在 provider 目录（悬空）
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
