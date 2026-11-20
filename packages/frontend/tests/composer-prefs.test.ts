// fake-indexeddb/auto：side-effect 注册内存版 IndexedDB，供测试使用（无需类型压制，types 可正常解析）
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "bun:test";
import {
	useComposerPrefsStore,
	_resetDefaultsHydration,
	_resetSessionHydration,
	thinkingForModel,
	resolveThinking,
} from "../src/store/composer-prefs";
import {
	getDefaults,
	getNewSessionIds,
	getSessionPrefs,
	setDefaults as dbSetDefaults,
	setNewSessionIds as dbSetNewSessionIds,
	setSessionPrefs as dbSetSessionPrefs,
} from "../src/store/composer-db";

describe("composer-prefs store", () => {
	beforeEach(async () => {
		// 先触发 idb 的数据库初始化，避免后续直接操作 indexedDB 时创建空版本
		await getDefaults();
		// 注意：不用独立 connection 清理 idb（会破坏 getDb 的 dbPromise 缓存，
		// 导致后续 setSessionPrefs 写入丢失）。测试间隔离靠唯一 sessionId + 重置 store 内存态。
		// defaults/recording/newSessionIds 走 localStorage，需清理
		localStorage.clear();
		// 重置 hydration 标志：模拟软件重启后尚未 loadDefaults 的初始状态
		_resetDefaultsHydration();
		_resetSessionHydration();
		useComposerPrefsStore.setState({
			defaults: { model: null, thinkingByModel: {} },
			bySession: {},
			loadedBySession: {},
			newSessionIds: {},
		});
	});

	it("loadDefaults 从持久层恢复 model 与按模型的思考档", async () => {
		await dbSetDefaults({
			model: "claude-sonnet",
			thinkingByModel: { "claude-sonnet": "high" },
		});

		await useComposerPrefsStore.getState().loadDefaults();

		expect(useComposerPrefsStore.getState().defaults).toEqual({
			model: "claude-sonnet",
			thinkingByModel: { "claude-sonnet": "high" },
		});
	});

	// 竞态复现：getDefaults 同步读 localStorage（T0 快照在 loadSession() 调用时即捕获），
	// getSessionPrefs 是真实 IDB 读（挂起窗口）。在 loadSession() 返回后同步改 defaults，
	// 必然落在窗口内——不依赖时序运气，确定性复现「切换模型后会被回滚」。
	it("竞态：loadSession 进行中用户改 defaults，完成时不得用 T0 快照回滚内存", async () => {
		await useComposerPrefsStore.getState().loadDefaults(); // hydrate（读空 localStorage）
		useComposerPrefsStore.getState().setDefaults({ model: "A" }); // 持久化 + 内存 = A
		expect(useComposerPrefsStore.getState().defaults.model).toBe("A");

		// loadSession 同步执行 getDefaults()（T0 快照 = "A"），随后挂在 await getSessionPrefs（IDB）
		const p = useComposerPrefsStore.getState().loadSession("s-race");
		// 同步改 defaults 为 "B"——loadSession 仍挂在 IDB await 上，必然在窗口内
		useComposerPrefsStore.getState().setDefaults({ model: "B" });
		expect(useComposerPrefsStore.getState().defaults.model).toBe("B"); // 内存已是 B
		await p;
		// BUG：else 分支用 T0 快照 "A" 无条件覆盖内存 defaults → 期望 "B"，实际被回滚成 "A"
		expect(useComposerPrefsStore.getState().defaults.model).toBe("B");
	});

	it("loadSession loads per-session prefs from IndexedDB", async () => {
		await dbSetDefaults({
			model: "default-model",
			thinkingByModel: { "default-model": "disabled" },
		});
		await dbSetSessionPrefs({
			sessionId: "s1",
			model: "session-model",
			thinking: "high",
			attachments: [{ kind: "snippet", name: "note", content: "hi" }],
			updatedAt: Date.now(),
		});

		await useComposerPrefsStore.getState().loadSession("s1");

		const state = useComposerPrefsStore.getState();
		expect(state.defaults).toEqual({
			model: "default-model",
			thinkingByModel: { "default-model": "disabled" },
		});
		expect(state.bySession["s1"]).toEqual({
			model: "session-model",
			thinking: "high",
			attachments: [{ kind: "snippet", name: "note", content: "hi" }],
		});
	});

	it("loadSession falls back to defaults when no session record exists", async () => {
		await dbSetDefaults({
			model: "fallback-model",
			thinkingByModel: { "fallback-model": "high" },
		});

		await useComposerPrefsStore.getState().loadSession("missing-session");

		const state = useComposerPrefsStore.getState();
		expect(state.defaults).toEqual({
			model: "fallback-model",
			thinkingByModel: { "fallback-model": "high" },
		});
		// 无 session 记录时：model 回退 defaults，thinking 保持 undefined（未显式设置）
		// 组件读取 thinking 时用 resolveThinking 按模型记录算
		expect(state.bySession["missing-session"]).toEqual({
			model: "fallback-model",
			attachments: [],
		});
	});

	it("loadSession 完成后标记 loadedBySession（Composer 据此门控 auto-select）", async () => {
		await dbSetDefaults({ model: null, thinkingByModel: {} });
		// 加载前未标记
		expect(
			useComposerPrefsStore.getState().loadedBySession["s-load"],
		).toBeFalsy();

		await useComposerPrefsStore.getState().loadSession("s-load");

		expect(useComposerPrefsStore.getState().loadedBySession["s-load"]).toBe(true);
	});

	it("setDefaults updates state and persists to IndexedDB", async () => {
		// 应用启动：先 hydrate（真实场景用户设置时应用早已加载完成，未 hydrate 时持久化被守卫跳过）
		await useComposerPrefsStore.getState().loadDefaults();
		useComposerPrefsStore.getState().setDefaults({
			model: "persisted-model",
			thinkingByModel: { "persisted-model": "high" },
		});
		await new Promise((r) => setTimeout(r, 10)); // 等 fire-and-forget 写入完成

		expect(useComposerPrefsStore.getState().defaults).toEqual({
			model: "persisted-model",
			thinkingByModel: { "persisted-model": "high" },
		});
		expect(await getDefaults()).toEqual({
			model: "persisted-model",
			thinkingByModel: { "persisted-model": "high" },
		});
	});

	it("重启往返：按模型存的思考档 → 重置内存态 → loadDefaults 应恢复", async () => {
		// 应用启动：先 hydrate（真实场景用户设置时应用早已加载完成）
		await useComposerPrefsStore.getState().loadDefaults();
		useComposerPrefsStore
			.getState()
			.setDefaults({ thinkingByModel: { "p/m1": "high" } });
		// 等待 fire-and-forget 的写入完成
		await new Promise((r) => setTimeout(r, 10));

		// 模拟软件重启：内存态回到初始值，hydration 标志也重置（持久化数据保留）
		_resetDefaultsHydration();
		useComposerPrefsStore.setState({
			defaults: { model: null, thinkingByModel: {} },
			bySession: {},
			loadedBySession: {},
			newSessionIds: {},
		});

		// 重新加载（NewSessionPane 挂载时触发）
		await useComposerPrefsStore.getState().loadDefaults();

		// 关键断言：模型记录应从持久层恢复
		expect(
			useComposerPrefsStore.getState().defaults.thinkingByModel["p/m1"],
		).toBe("high");
	});

	it("setNewSessionId persists new session ids to IndexedDB", async () => {
		await dbSetNewSessionIds({ p1: "ns-1" });

		await useComposerPrefsStore.getState().loadDefaults();

		expect(useComposerPrefsStore.getState().newSessionIds).toEqual({
			p1: "ns-1",
		});
		expect(await getNewSessionIds()).toEqual({ p1: "ns-1" });
	});

	it("复现：冷启动挂载时 setNewSessionId 写随机 id，不应覆盖 localStorage 持久化的 newSessionIds 映射", async () => {
		// 上次会话已持久化旧映射（beforeEach 已 _resetDefaultsHydration，模拟未 hydrate）
		await dbSetNewSessionIds({ p1: "old-draft" });

		// 模拟 NewSessionPane 挂载 effect：hydrate 前写入随机 id
		useComposerPrefsStore.getState().setNewSessionId("p1", "fresh-random");

		// 关键断言1：守卫拦下——localStorage 仍保持旧映射，未被随机覆盖
		expect(await getNewSessionIds()).toEqual({ p1: "old-draft" });

		// loadDefaults 姗姗来迟完成：从持久层恢复旧映射
		await useComposerPrefsStore.getState().loadDefaults();
		expect(useComposerPrefsStore.getState().newSessionIds).toEqual({
			p1: "old-draft",
		});
		// 关键断言2：store 内存态也被随机 id 污染的情况在 load 后被纠正
	});

	it("loadSession 不应覆盖已由 setSessionPrefs 设置的 prefs（竞态：auto-select 先于 loadSession 完成）", async () => {
		await dbSetDefaults({ model: null, thinkingByModel: {} });

		// 模拟：auto-select 先触发 setSessionPrefs
		useComposerPrefsStore
			.getState()
			.setSessionPrefs("new-session", { model: "openai/gpt-4o" });

		// 模拟：loadSession 在 setSessionPrefs 之后才完成（此时 DB 中仍无记录）
		await useComposerPrefsStore.getState().loadSession("new-session");

		// loadSession 不应覆盖 auto-select 结果
		const state = useComposerPrefsStore.getState();
		expect(state.bySession["new-session"].model).toBe("openai/gpt-4o");
	});

	it("复现 hydration 竞态：localStorage 已存模型思考档，loadDefaults 完成前改 model，不应把空模型表写回覆盖", async () => {
		// 真实场景：上次已把某模型的思考档持久化（beforeEach 已 _resetDefaultsHydration）
		await dbSetDefaults({
			model: null,
			thinkingByModel: { "p/m1": "high" },
		});
		// 内存态此时是初始空模型表（beforeEach 设置），hydration=false（尚未 loadDefaults）

		// 竞态点：loadDefaults 尚未触发/完成（异步 gap），用户在新建页改了 model。
		// hydration guard 必须拦下这次写回，否则空模型表会覆盖已存的 high 记录。
		useComposerPrefsStore.getState().setDefaults({ model: "openai/gpt-4o" });
		await new Promise((r) => setTimeout(r, 10)); // 等 fire-and-forget 写入完成

		// 关键断言1：localStorage 的模型思考档必须还在
		expect((await getDefaults()).thinkingByModel["p/m1"]).toBe("high");

		// loadDefaults 姗姗来迟完成：内存态合并——保留竞态期间用户选的 model，恢复模型思考档
		await useComposerPrefsStore.getState().loadDefaults();

		// 关键断言2：内存态模型记录恢复
		expect(
			useComposerPrefsStore.getState().defaults.thinkingByModel["p/m1"],
		).toBe("high");
		// 竞态期间用户改的 model 仍在内存中（未被 loadDefaults 覆盖为 null）
		expect(useComposerPrefsStore.getState().defaults.model).toBe("openai/gpt-4o");
	});

	it("复现：重启后 ModelSelector 自动选中第一个模型，不应覆盖 localStorage 中用户上次选的 model", async () => {
		// 真实场景：用户上次在新建页选了 openai/gpt-4o，已持久化到 localStorage
		await dbSetDefaults({
			model: "openai/gpt-4o",
			thinkingByModel: { "openai/gpt-4o": "high" },
		});
		// 内存态是初始值（beforeEach 已重置），hydration=false

		// 竞态点：NewSessionPane 挂载，loadDefaults() 异步未完成；
		// 但 ModelSelector 因 value=null 已同步触发 auto-select → setDefaults({ 第一个模型 })。
		// 这里用 "anthropic/claude-sonnet" 模拟 providers 列表里的第一个模型。
		useComposerPrefsStore
			.getState()
			.setDefaults({ model: "anthropic/claude-sonnet" });

		// loadDefaults 姗姗来迟完成
		await useComposerPrefsStore.getState().loadDefaults();

		// 关键断言：重启后应恢复用户上次持久化的 openai/gpt-4o，
		// 而非被 ModelSelector 自动选中的第一个模型（anthropic/claude-sonnet）覆盖。
		// 修复前：loadDefaults 里 `s.defaults.model != null ? s.defaults.model : defs.model`
		// 因 auto-select 已把 s.defaults.model 设成非 null，会丢弃 defs.model（openai/gpt-4o）。
		expect(useComposerPrefsStore.getState().defaults.model).toBe("openai/gpt-4o");
	});

	it("复现：模型 A 设 max → 切到有 off 记录的老会话 → 重启后 A 的记录仍是 max", async () => {
		// 老会话已有 off 偏好（会话级）
		await dbSetDefaults({
			model: null,
			thinkingByModel: { "openai/gpt-4o": "max" },
		});
		await dbSetSessionPrefs({
			sessionId: "old-session",
			model: "p/other",
			thinking: "disabled",
			attachments: [],
			updatedAt: Date.now(),
		});

		// 应用启动：先 hydrate（真实场景用户设置时应用早已加载完成）
		await useComposerPrefsStore.getState().loadDefaults();

		// 1. 切到老会话：Composer 挂载 → loadSession(old-session)
		await useComposerPrefsStore.getState().loadSession("old-session");
		// 老会话读到自己的 disabled（会话级保留）
		expect(useComposerPrefsStore.getState().bySession["old-session"].thinking).toBe(
			"disabled",
		);

		// 2. 软件重启：内存态重置，hydration 标志也重置，持久化数据保留
		_resetDefaultsHydration();
		useComposerPrefsStore.setState({
			defaults: { model: null, thinkingByModel: {} },
			bySession: {},
			newSessionIds: {},
		});

		// 3. 重开 → loadDefaults
		await useComposerPrefsStore.getState().loadDefaults();

		// 关键断言：模型级的 max 记录被保留，没被老会话的 disabled 污染
		expect(
			useComposerPrefsStore.getState().defaults.thinkingByModel[
				"openai/gpt-4o"
			],
		).toBe("max");
	});

	it("会话未显式设置 thinking 时，bySession.thinking 保持 undefined（读取由组件 resolveThinking 兜底）", async () => {
		await dbSetDefaults({
			model: null,
			thinkingByModel: { "p/m1": "max" },
		});
		// 不写入任何 session prefs（模拟全新会话，用户从没设过思考强度）

		await useComposerPrefsStore.getState().loadDefaults();
		await useComposerPrefsStore.getState().loadSession("s-no-thinking");

		// bySession 里 thinking 应为 undefined（未显式设置）
		const sess = useComposerPrefsStore.getState().bySession["s-no-thinking"];
		expect(sess.thinking).toBeUndefined();
		// 模型记录仍在
		expect(
			useComposerPrefsStore.getState().defaults.thinkingByModel["p/m1"],
		).toBe("max");
	});

	it("会话显式设置过 thinking 后，切换 defaults 不影响该会话", async () => {
		await dbSetDefaults({ model: null, thinkingByModel: {} });
		await dbSetSessionPrefs({
			sessionId: "s-fixed",
			model: null,
			thinking: "high",
			attachments: [],
			updatedAt: Date.now(),
		});

		await useComposerPrefsStore.getState().loadDefaults();
		await useComposerPrefsStore.getState().loadSession("s-fixed");
		// 会话固定 high
		expect(useComposerPrefsStore.getState().bySession["s-fixed"].thinking).toBe(
			"high",
		);

		// 用户改了某模型的记录为 max
		useComposerPrefsStore
			.getState()
			.setDefaults({ thinkingByModel: { "p/m1": "max" } });
		// 已设过 high 的会话不受影响
		expect(useComposerPrefsStore.getState().bySession["s-fixed"].thinking).toBe(
			"high",
		);
	});

	it("复现 hydration 竞态：loadSession 完成前 auto-select 写 model，不应丢失 IDB 里的附件和 thinking", async () => {
		await dbSetDefaults({ model: null, thinkingByModel: {} });
		// 上次会话已在 IDB 持久化了片段附件和显式 thinking
		await dbSetSessionPrefs({
			sessionId: "s-gap-att",
			model: "old/model",
			thinking: "high",
			attachments: [{ kind: "snippet", name: "note", content: "hi" }],
			updatedAt: Date.now(),
		});

		// 竞态：reload 后 Composer 挂载，loadSession 已发起但未完成（异步 gap）；
		// ModelSelector 因 value=null 抢先 auto-select → setSessionPrefs({ model })
		const loadPromise = useComposerPrefsStore.getState().loadSession("s-gap-att");
		useComposerPrefsStore
			.getState()
			.setSessionPrefs("s-gap-att", { model: "auto/first-model" });
		await loadPromise;
		await new Promise((r) => setTimeout(r, 10)); // 等 fire-and-forget 写入完成

		const sess = useComposerPrefsStore.getState().bySession["s-gap-att"];
		// gap 期间显式设置的 model 保留（既有行为：auto-select 结果不被 loadSession 覆盖）
		expect(sess.model).toBe("auto/first-model");
		// 未触碰的字段以持久层为准恢复（修复前：existing 守卫整体跳过，attachments 永远是 []）
		expect(sess.attachments).toEqual([
			{ kind: "snippet", name: "note", content: "hi" },
		]);
		expect(sess.thinking).toBe("high");
		// IDB 记录也不能被 gap 写入覆写丢附件
		const stored = await getSessionPrefs("s-gap-att");
		expect(stored?.attachments).toEqual([
			{ kind: "snippet", name: "note", content: "hi" },
		]);
		expect(stored?.model).toBe("auto/first-model");
	});

	it("复现：auto-select 先于 loadSession 发起（React 子 effect 先执行的真实时序），附件也不应丢失", async () => {
		await dbSetDefaults({ model: null, thinkingByModel: {} });
		await dbSetSessionPrefs({
			sessionId: "s-gap-early",
			model: "old/model",
			thinking: "high",
			attachments: [{ kind: "snippet", name: "note", content: "hi" }],
			updatedAt: Date.now(),
		});

		// 真实浏览器时序：ModelSelector 是 Composer 的子组件，React 子 effect 先执行——
		// auto-select 的 setSessionPrefs 甚至早于 loadSession 被调用
		useComposerPrefsStore
			.getState()
			.setSessionPrefs("s-gap-early", { model: "auto/first-model" });
		await useComposerPrefsStore.getState().loadSession("s-gap-early");
		await new Promise((r) => setTimeout(r, 10));

		const sess = useComposerPrefsStore.getState().bySession["s-gap-early"];
		expect(sess.model).toBe("auto/first-model");
		expect(sess.attachments).toEqual([
			{ kind: "snippet", name: "note", content: "hi" },
		]);
		expect(sess.thinking).toBe("high");
		const stored = await getSessionPrefs("s-gap-early");
		expect(stored?.attachments).toEqual([
			{ kind: "snippet", name: "note", content: "hi" },
		]);
	});

	it("loadSession 恢复 text 草稿", async () => {
		await dbSetDefaults({ model: null, thinkingByModel: {} });
		await dbSetSessionPrefs({
			sessionId: "s-draft",
			model: null,
			thinking: "disabled",
			attachments: [],
			text: "写了一半的消息",
			updatedAt: Date.now(),
		});

		await useComposerPrefsStore.getState().loadSession("s-draft");

		expect(useComposerPrefsStore.getState().bySession["s-draft"].text).toBe(
			"写了一半的消息",
		);
	});

	it("gap 期间写入的 text 在 loadSession 合并中胜出", async () => {
		await dbSetDefaults({ model: null, thinkingByModel: {} });
		await dbSetSessionPrefs({
			sessionId: "s-gap-text",
			model: null,
			thinking: "disabled",
			attachments: [],
			text: "持久层草稿",
			updatedAt: Date.now(),
		});

		// 异步 gap：loadSession 发起但未完成时，组件先写入了 text
		const loadPromise = useComposerPrefsStore
			.getState()
			.loadSession("s-gap-text");
		useComposerPrefsStore
			.getState()
			.setSessionPrefs("s-gap-text", { text: "gap 期间输入" });
		await loadPromise;
		await new Promise((r) => setTimeout(r, 10));

		expect(useComposerPrefsStore.getState().bySession["s-gap-text"].text).toBe(
			"gap 期间输入",
		);
	});

	it("发送清空（text: 空串）后 loadSession 不恢复文本", async () => {
		await dbSetDefaults({ model: null, thinkingByModel: {} });
		await dbSetSessionPrefs({
			sessionId: "s-sent",
			model: null,
			thinking: "disabled",
			attachments: [],
			text: "已发送的草稿",
			updatedAt: Date.now(),
		});
		await useComposerPrefsStore.getState().loadSession("s-sent");
		useComposerPrefsStore.getState().setSessionPrefs("s-sent", { text: "" });
		await new Promise((r) => setTimeout(r, 10));

		// 模拟重启：内存态重置，持久化数据保留
		useComposerPrefsStore.setState({ bySession: {}, loadedBySession: {} });
		await useComposerPrefsStore.getState().loadSession("s-sent");

		expect(useComposerPrefsStore.getState().bySession["s-sent"].text ?? "").toBe(
			"",
		);
	});

	it("老记录（无 text 字段）加载后 text 为 undefined", async () => {
		await dbSetDefaults({ model: null, thinkingByModel: {} });
		await dbSetSessionPrefs({
			sessionId: "s-old",
			model: null,
			thinking: "disabled",
			attachments: [],
			updatedAt: Date.now(),
		});

		await useComposerPrefsStore.getState().loadSession("s-old");

		expect(
			useComposerPrefsStore.getState().bySession["s-old"].text,
		).toBeUndefined();
	});

	it("removeSessionPrefs 清内存 + IndexedDB 记录", async () => {
		await dbSetDefaults({ model: null, thinkingByModel: {} });
		await dbSetSessionPrefs({
			sessionId: "s-del",
			model: null,
			thinking: "disabled",
			attachments: [],
			text: "待删除草稿",
			updatedAt: Date.now(),
		});
		await useComposerPrefsStore.getState().loadSession("s-del");
		expect(useComposerPrefsStore.getState().bySession["s-del"]).toBeDefined();

		useComposerPrefsStore.getState().removeSessionPrefs("s-del");
		await new Promise((r) => setTimeout(r, 10)); // 等 fire-and-forget 写入完成

		expect(useComposerPrefsStore.getState().bySession["s-del"]).toBeUndefined();
		expect(
			useComposerPrefsStore.getState().loadedBySession["s-del"],
		).toBeUndefined();
		expect(await getSessionPrefs("s-del")).toBeUndefined();
	});

	// === clearStaleModels：provider 保存/改 model id 后清除悬空引用 ===
	// 场景：聊天窗选了 "deepseek/deepseek-chat"，用户到模型管理把 model id 改成
	// "deepseek-v4"（删旧增新）。保存后 providers 里只剩 "deepseek/deepseek-v4"，
	// 而 composer-prefs 还存着旧 id → isModelAvailable false → 发送按钮静默置灰。
	// clearStaleModels 应把失效的会话级 + 默认模型引用清 null，让用户重选。
	const deepseekProvider = () => ({
		id: "p1",
		name: "DeepSeek",
		baseUrl: "https://api.deepseek.com/v1",
		apiKey: "k",
		api: "openai-completions" as const,
		models: [{ id: "deepseek-v4", contextWindow: 128000, maxTokens: 4096 }],
	});

	it("clearStaleModels 清除指向已改 id 模型的悬空会话引用", async () => {
		useComposerPrefsStore.setState({
			defaults: { model: null, thinkingByModel: {} },
			bySession: {
				s1: {
					model: "deepseek/deepseek-chat", // 旧 id，已失效
					thinking: "high",
					attachments: [],
				},
			},
		});

		useComposerPrefsStore.getState().clearStaleModels([deepseekProvider()]);

		expect(useComposerPrefsStore.getState().bySession["s1"].model).toBeNull();
		// 其它字段不受影响
		expect(useComposerPrefsStore.getState().bySession["s1"].thinking).toBe(
			"high",
		);
	});

	it("clearStaleModels 清除失效的默认模型引用", async () => {
		useComposerPrefsStore.setState({
			defaults: { model: "deepseek/deepseek-chat", thinkingByModel: {} },
			bySession: {},
		});

		useComposerPrefsStore.getState().clearStaleModels([deepseekProvider()]);

		expect(useComposerPrefsStore.getState().defaults.model).toBeNull();
	});

	it("clearStaleModels 保留仍然有效的模型引用", async () => {
		useComposerPrefsStore.setState({
			defaults: { model: null, thinkingByModel: {} },
			bySession: {
				s1: { model: "deepseek/deepseek-v4", thinking: undefined, attachments: [] },
			},
		});

		useComposerPrefsStore.getState().clearStaleModels([deepseekProvider()]);

		// 新 id 有效，不应被清除
		expect(useComposerPrefsStore.getState().bySession["s1"].model).toBe(
			"deepseek/deepseek-v4",
		);
	});

	// ─── 按模型保存思考档：纯函数 + 写入路径 ─────────────────────────────────

	it("thinkingForModel：无记录返回 default", () => {
		expect(thinkingForModel("p/m", {})).toBe("default");
		expect(thinkingForModel("p/m", { "p/m": "high" })).toBe("high");
		expect(thinkingForModel(null, { "p/m": "high" })).toBe("default");
	});

	it("resolveThinking：模型记录优先于会话值，无记录才回退会话值", () => {
		expect(resolveThinking("p/m", "disabled", { "p/m": "high" })).toBe("high");
		// 无该模型记录 → 回退会话值（老数据兼容路径）
		expect(resolveThinking("p/n", "disabled", { "p/m": "high" })).toBe(
			"disabled",
		);
		expect(resolveThinking("p/n", undefined, {})).toBe("default");
		expect(resolveThinking(null, undefined, {})).toBe("default");
	});

	it("setSessionPrefs({thinking}) 把档位记到当前模型名下", async () => {
		await useComposerPrefsStore.getState().loadDefaults();
		useComposerPrefsStore.getState().setSessionPrefs("s1", { model: "p/m" });
		useComposerPrefsStore.getState().setSessionPrefs("s1", { thinking: "max" });
		await new Promise((r) => setTimeout(r, 10));

		expect(useComposerPrefsStore.getState().defaults.thinkingByModel["p/m"]).toBe(
			"max",
		);
		expect((await getDefaults()).thinkingByModel["p/m"]).toBe("max");
		// 会话自身也记下了
		expect(useComposerPrefsStore.getState().bySession["s1"].thinking).toBe("max");
	});

	it("setSessionPrefs({thinking}) 无模型时只写会话不写模型表", async () => {
		await useComposerPrefsStore.getState().loadDefaults();
		useComposerPrefsStore.getState().setSessionPrefs("s1", { thinking: "high" });
		await new Promise((r) => setTimeout(r, 10));

		expect(useComposerPrefsStore.getState().bySession["s1"].thinking).toBe("high");
		expect(useComposerPrefsStore.getState().defaults.thinkingByModel).toEqual({});
	});

	it("setSessionPrefs({model, thinking}) 同时给出时按新模型记账", async () => {
		await useComposerPrefsStore.getState().loadDefaults();
		useComposerPrefsStore
			.getState()
			.setSessionPrefs("s1", { model: "p/a", thinking: "high" });
		await new Promise((r) => setTimeout(r, 10));

		expect(useComposerPrefsStore.getState().defaults.thinkingByModel["p/a"]).toBe(
			"high",
		);
	});

	it("setSessionModel：切到从没设过的模型 → 默认；切回来 → 仍是原记录", async () => {
		await useComposerPrefsStore.getState().loadDefaults();
		useComposerPrefsStore.getState().setSessionPrefs("s1", { model: "p/a" });
		useComposerPrefsStore.getState().setSessionPrefs("s1", { thinking: "high" });
		expect(useComposerPrefsStore.getState().bySession["s1"].thinking).toBe("high");

		useComposerPrefsStore.getState().setSessionModel("s1", "p/b");
		expect(useComposerPrefsStore.getState().bySession["s1"].thinking).toBe(
			"default",
		);
		expect(useComposerPrefsStore.getState().defaults.model).toBe("p/b");

		useComposerPrefsStore.getState().setSessionModel("s1", "p/a");
		expect(useComposerPrefsStore.getState().bySession["s1"].thinking).toBe("high");
		expect(useComposerPrefsStore.getState().defaults.model).toBe("p/a");
	});

	it("setSessionModel 不污染其它模型的记录", async () => {
		await useComposerPrefsStore.getState().loadDefaults();
		useComposerPrefsStore.getState().setSessionPrefs("s1", { model: "p/a" });
		useComposerPrefsStore.getState().setSessionPrefs("s1", { thinking: "max" });
		useComposerPrefsStore.getState().setSessionModel("s1", "p/b");
		useComposerPrefsStore.getState().setSessionPrefs("s1", { thinking: "disabled" });

		expect(useComposerPrefsStore.getState().defaults.thinkingByModel).toEqual({
			"p/a": "max",
			"p/b": "disabled",
		});
	});


	it("回归：setSessionModel（auto-select 路径）不得把推断出的 default 写进模型表，以免盖掉持久层记录", async () => {
		// 场景：持久层里 p/a 已有 high 记录（用户上次的选择）
		await dbSetDefaults({
			model: "p/a",
			thinkingByModel: { "p/a": "high" },
		});
		await useComposerPrefsStore.getState().loadDefaults();
		// 内存态此时未 hydrate —— 模拟 ModelSelector 在 loadDefaults 完成前 auto-select
		_resetDefaultsHydration();
		useComposerPrefsStore.setState({
			defaults: { model: null, thinkingByModel: {} },
			bySession: {},
			loadedBySession: {},
			newSessionIds: {},
		});

		// auto-select 选到一个「从没设置过」的模型：推断档位为 default
		useComposerPrefsStore.getState().setSessionModel("s-auto", "p/new");

		// 关键断言：不能凭空为 p/new 建一条 default 记录
		expect(useComposerPrefsStore.getState().defaults.thinkingByModel).toEqual({});

		// loadDefaults 完成后，持久层 p/a 的 high 必须完整恢复
		await useComposerPrefsStore.getState().loadDefaults();
		expect(useComposerPrefsStore.getState().defaults.thinkingByModel).toEqual({
			"p/a": "high",
		});
	});


	it("R2：gap 期 setSessionModel 不得把推断出的档位固化进 gapWrites（应由 loadSession 恢复持久层值）", async () => {
		// 持久层：p/old 有 high 记录；会话 s-gap 的 IDB 里 thinking 也是 high
		await dbSetDefaults({
			model: null,
			thinkingByModel: { "p/old": "high" },
		});
		await dbSetSessionPrefs({
			sessionId: "s-gap-2",
			model: "p/old",
			thinking: "high",
			attachments: [],
			updatedAt: Date.now(),
		});
		await useComposerPrefsStore.getState().loadDefaults();

		// gap：loadSession 尚未完成，用户把模型切到 p/new（p/new 无记录 → 推断为 default）
		const loadPromise = useComposerPrefsStore.getState().loadSession("s-gap-2");
		useComposerPrefsStore.getState().setSessionModel("s-gap-2", "p/new");
		await loadPromise;
		await new Promise((r) => setTimeout(r, 10));

		const sess = useComposerPrefsStore.getState().bySession["s-gap-2"];
		expect(sess.model).toBe("p/new");
		// 推断值 default 只用于显示，不应被当成「用户选择」写进 IDB
		const stored = await getSessionPrefs("s-gap-2");
		expect(stored?.model).toBe("p/new");
		// 关键：旧模型 p/old 的 high 绝不能跟到新模型 p/new 上落到 IDB。
		// （p/new 无记录时落 default 是结构性占位，符合语义；落 high 就是 bug）
		expect(stored?.thinking).not.toBe("high");
		// 关键：内存显示值按语义应为 default（p/new 无记录）
		expect(sess.thinking).toBe("default");
		// 且 p/old 的 high 记录完好无损
		expect(useComposerPrefsStore.getState().defaults.thinkingByModel["p/old"]).toBe(
			"high",
		);
	});

	it("R1：loadSession 的 defaults 补齐应是字段级合并，不得整块覆盖内存里已有的模型记录", async () => {
		// 持久层只有 model，无模型表
		await dbSetDefaults({ model: "p/a", thinkingByModel: {} });
		// 内存里已有一条别的模型的记录（模拟用户刚改过、尚未 loadDefaults 完成）
		useComposerPrefsStore.setState({
			defaults: { model: null, thinkingByModel: { "p/b": "max" } },
			bySession: {},
			loadedBySession: {},
			newSessionIds: {},
		} as any);

		await useComposerPrefsStore.getState().loadSession("s-r1");

		const d = useComposerPrefsStore.getState().defaults;
		expect(d.model).toBe("p/a");
		// 内存里 p/b 的记录不能被 T0 快照整块冲掉
		expect(d.thinkingByModel["p/b"]).toBe("max");
	});

});
