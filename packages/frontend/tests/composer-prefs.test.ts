// @ts-ignore：fake-indexeddb 的 types 在 exports 解析上有问题，运行时无影响
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "bun:test";
import { useComposerPrefsStore, _resetDefaultsHydration, _resetSessionHydration } from "../src/store/composer-prefs";
import {
  getDefaults,
  getNewSessionIds,
  getSessionPrefs,
  setDefaults as dbSetDefaults,
  setNewSessionIds as dbSetNewSessionIds,
  setSessionPrefs as dbSetSessionPrefs,
} from "../src/store/composer-db";

const DB_NAME = "wa-pi-composer";

/** 清空 IndexedDB 中的 sessions store（defaults 已改用 localStorage，由 localStorage.clear() 清理） */
async function clearStores(): Promise<void> {
  const request = indexedDB.open(DB_NAME);
  await new Promise<void>((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const storeNames = Array.from(db.objectStoreNames);
      // 仅清理存在的 store（defaults 已迁 localStorage，可能不在 idb 里）
      const targets = ["sessions"].filter(n => storeNames.includes(n));
      if (targets.length === 0) { db.close(); resolve(); return; }
      const tx = db.transaction(targets, "readwrite");
      for (const n of targets) tx.objectStore(n).clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

describe("composer-prefs store", () => {
  beforeEach(async () => {
    // 先触发 idb 的数据库初始化，避免后续直接操作 indexedDB 时创建空版本
    await getDefaults();
    // 注意：不调 clearStores（它用独立 connection open 同名 db 会破坏 getDb 的 dbPromise 缓存，
    // 导致后续 setSessionPrefs 写入丢失）。测试间隔离靠唯一 sessionId + 重置 store 内存态。
    // defaults/recording/newSessionIds 走 localStorage，需清理
    localStorage.clear();
    // 重置 hydration 标志：模拟软件重启后尚未 loadDefaults 的初始状态
    _resetDefaultsHydration();
    _resetSessionHydration();
    useComposerPrefsStore.setState({
      defaults: { model: null, thinking: "disabled" },
      bySession: {},
      loadedBySession: {},
      newSessionIds: {},
    });
  });

  it("loadDefaults loads defaults from IndexedDB into state", async () => {
    await dbSetDefaults({ model: "claude-sonnet", thinking: "high" });

    await useComposerPrefsStore.getState().loadDefaults();

    expect(useComposerPrefsStore.getState().defaults).toEqual({
      model: "claude-sonnet",
      thinking: "high",
    });
  });

  it("loadSession loads per-session prefs from IndexedDB", async () => {
    await dbSetDefaults({ model: "default-model", thinking: "disabled" });
    await dbSetSessionPrefs({
      sessionId: "s1",
      model: "session-model",
      thinking: "high",
      attachments: [{ kind: "snippet", name: "note", content: "hi" }],
      updatedAt: Date.now(),
    });

    await useComposerPrefsStore.getState().loadSession("s1");

    const state = useComposerPrefsStore.getState();
    expect(state.defaults).toEqual({ model: "default-model", thinking: "disabled" });
    expect(state.bySession["s1"]).toEqual({
      model: "session-model",
      thinking: "high",
      attachments: [{ kind: "snippet", name: "note", content: "hi" }],
    });
  });

  it("loadSession falls back to defaults when no session record exists", async () => {
    await dbSetDefaults({ model: "fallback-model", thinking: "high" });

    await useComposerPrefsStore.getState().loadSession("missing-session");

    const state = useComposerPrefsStore.getState();
    expect(state.defaults).toEqual({ model: "fallback-model", thinking: "high" });
    // 无 session 记录时：model 回退 defaults，thinking 保持 undefined（未显式设置）
    // 组件读取 thinking 时回退到 defaults.thinking
    expect(state.bySession["missing-session"]).toEqual({
      model: "fallback-model",
      attachments: [],
    });
  });

  it("loadSession 完成后标记 loadedBySession（Composer 据此门控 auto-select）", async () => {
    await dbSetDefaults({ model: null, thinking: "disabled" });
    // 加载前未标记
    expect(useComposerPrefsStore.getState().loadedBySession["s-load"]).toBeFalsy();

    await useComposerPrefsStore.getState().loadSession("s-load");

    expect(useComposerPrefsStore.getState().loadedBySession["s-load"]).toBe(true);
  });

  it("setDefaults updates state and persists to IndexedDB", async () => {
    // 应用启动：先 hydrate（真实场景用户设置时应用早已加载完成，未 hydrate 时持久化被守卫跳过）
    await useComposerPrefsStore.getState().loadDefaults();
    useComposerPrefsStore.getState().setDefaults({ model: "persisted-model", thinking: "high" });
    await new Promise((r) => setTimeout(r, 10)); // 等 fire-and-forget 写入完成

    expect(useComposerPrefsStore.getState().defaults).toEqual({
      model: "persisted-model",
      thinking: "high",
    });
    expect(await getDefaults()).toEqual({ model: "persisted-model", thinking: "high" });
  });

  it("重启往返：setDefaults({thinking}) → 重置内存态 → loadDefaults 应恢复存储的 thinking", async () => {
    // 应用启动：先 hydrate（真实场景用户设置时应用早已加载完成）
    await useComposerPrefsStore.getState().loadDefaults();
    // 模拟用户在新建页设置思考强度
    useComposerPrefsStore.getState().setDefaults({ thinking: "high" });
    // 等待 fire-and-forget 的写入完成
    await new Promise((r) => setTimeout(r, 10));

    // 模拟软件重启：内存态回到初始值，hydration 标志也重置（持久化数据保留）
    _resetDefaultsHydration();
    useComposerPrefsStore.setState({
      defaults: { model: null, thinking: "disabled" },
      bySession: {},
      loadedBySession: {},
      newSessionIds: {},
    });

    // 重新加载（NewSessionPane 挂载时触发）
    await useComposerPrefsStore.getState().loadDefaults();

    // 关键断言：思考强度应从持久层恢复为 high，而非停留在 disabled
    expect(useComposerPrefsStore.getState().defaults.thinking).toBe("high");
  });

  it("setNewSessionId persists new session ids to IndexedDB", async () => {
    await dbSetNewSessionIds({ p1: "ns-1" });

    await useComposerPrefsStore.getState().loadDefaults();

    expect(useComposerPrefsStore.getState().newSessionIds).toEqual({ p1: "ns-1" });
    expect(await getNewSessionIds()).toEqual({ p1: "ns-1" });
  });

  it("loadSession 不应覆盖已由 setSessionPrefs 设置的 prefs（竞态：auto-select 先于 loadSession 完成）", async () => {
    await dbSetDefaults({ model: null, thinking: "disabled" });

    // 模拟：auto-select 先触发 setSessionPrefs
    useComposerPrefsStore.getState().setSessionPrefs("new-session", { model: "openai/gpt-4o" });

    // 模拟：loadSession 在 setSessionPrefs 之后才完成（此时 DB 中仍无记录）
    await useComposerPrefsStore.getState().loadSession("new-session");

    // loadSession 不应覆盖 auto-select 结果
    const state = useComposerPrefsStore.getState();
    expect(state.bySession["new-session"].model).toBe("openai/gpt-4o");
  });

  it("复现 hydration 竞态：localStorage 已存 high，loadDefaults 完成前改 model，不应把初始 disabled 写回覆盖 high", async () => {
    // 真实场景：上次会话已把 thinking=high 持久化（beforeEach 已 _resetDefaultsHydration）
    await dbSetDefaults({ model: null, thinking: "high" });
    // 内存态此时是初始 disabled（beforeEach 设置），hydration=false（尚未 loadDefaults）

    // 竞态点：loadDefaults 尚未触发/完成（异步 gap），用户在新建页改了 model。
    // 修复前：setDefaults 内部 {...s.defaults(thinking=disabled), ...{model}} 把 disabled 写回，覆盖 high。
    // 修复后：hydration guard 阻止未 hydrate 的写入，localStorage 的 thinking 保持 high。
    useComposerPrefsStore.getState().setDefaults({ model: "openai/gpt-4o" });
    await new Promise((r) => setTimeout(r, 10)); // 等 fire-and-forget 写入完成

    // 关键断言1：localStorage 的 thinking 必须是 high，不能被初始 disabled 覆盖
    expect((await getDefaults()).thinking).toBe("high");

    // loadDefaults 姗姗来迟完成：内存态合并——保留竞态期间用户选的 model，恢复存储的 thinking
    await useComposerPrefsStore.getState().loadDefaults();

    // 关键断言2：内存态 thinking 恢复为 high（而非停留在初始 disabled）
    expect(useComposerPrefsStore.getState().defaults.thinking).toBe("high");
    // 竞态期间用户改的 model 仍在内存中（未被 loadDefaults 覆盖为 null）
    expect(useComposerPrefsStore.getState().defaults.model).toBe("openai/gpt-4o");
  });

  it("复现：重启后 ModelSelector 自动选中第一个模型，不应覆盖 localStorage 中用户上次选的 model", async () => {
    // 真实场景：用户上次在新建页选了 openai/gpt-4o，已持久化到 localStorage
    await dbSetDefaults({ model: "openai/gpt-4o", thinking: "high" });
    // 内存态是初始值（beforeEach 已重置），hydration=false

    // 竞态点：NewSessionPane 挂载，loadDefaults() 异步未完成；
    // 但 ModelSelector 因 value=null 已同步触发 auto-select → setDefaults({ 第一个模型 })。
    // 这里用 "anthropic/claude-sonnet" 模拟 providers 列表里的第一个模型。
    useComposerPrefsStore.getState().setDefaults({ model: "anthropic/claude-sonnet" });

    // loadDefaults 姗姗来迟完成
    await useComposerPrefsStore.getState().loadDefaults();

    // 关键断言：重启后应恢复用户上次持久化的 openai/gpt-4o，
    // 而非被 ModelSelector 自动选中的第一个模型（anthropic/claude-sonnet）覆盖。
    // 修复前：loadDefaults 里 `s.defaults.model != null ? s.defaults.model : defs.model`
    // 因 auto-select 已把 s.defaults.model 设成非 null，会丢弃 defs.model（openai/gpt-4o）。
    expect(useComposerPrefsStore.getState().defaults.model).toBe("openai/gpt-4o");
    // thinking 仍正确恢复
    expect(useComposerPrefsStore.getState().defaults.thinking).toBe("high");
  });

  it("复现：新会话设 max → 切到老会话(off) → 重启后 defaults 应保持 max", async () => {
    // 老会话已有 off 偏好
    await dbSetDefaults({ model: null, thinking: "disabled" });
    await dbSetSessionPrefs({
      sessionId: "old-session", model: null, thinking: "disabled",
      attachments: [], updatedAt: Date.now(),
    });

    // 应用启动：先 hydrate（真实场景用户设置时应用早已加载完成）
    await useComposerPrefsStore.getState().loadDefaults();
    // 1. 用户在新会话设置思考强度 max（NewSessionPane.setDefaults）
    useComposerPrefsStore.getState().setDefaults({ thinking: "max" });
    await new Promise((r) => setTimeout(r, 10)); // 等 fire-and-forget 写入完成

    // 2. 切到老会话：Composer 挂载 → loadSession(old-session)
    await useComposerPrefsStore.getState().loadSession("old-session");

    // 2b. 在老会话里改了 model（Composer.setModel 走 setSessionPrefs）
    useComposerPrefsStore.getState().setSessionPrefs("old-session", { model: "openai/gpt-4o" });
    await new Promise((r) => setTimeout(r, 10));

    // 3. 软件重启：内存态重置，hydration 标志也重置，持久化数据保留
    _resetDefaultsHydration();
    useComposerPrefsStore.setState({
      defaults: { model: null, thinking: "disabled" },
      bySession: {}, newSessionIds: {},
    });

    // 4. 重开 → NewSessionPane 挂载 → loadDefaults
    await useComposerPrefsStore.getState().loadDefaults();

    // 关键断言：用户在新会话设的 max 应被保留，而非被老会话的 off 覆盖
    expect(useComposerPrefsStore.getState().defaults.thinking).toBe("max");
  });

  it("会话未显式设置 thinking 时，回退到 defaults.thinking 而非硬编码 disabled", async () => {
    // defaults 设为 max
    await dbSetDefaults({ model: null, thinking: "max" });
    // 不写入任何 session prefs（模拟全新会话，用户从没设过思考强度）

    await useComposerPrefsStore.getState().loadDefaults();
    await useComposerPrefsStore.getState().loadSession("s-no-thinking");

    // bySession 里 thinking 应为 undefined（未显式设置），读取时由组件回退到 defaults
    const sess = useComposerPrefsStore.getState().bySession["s-no-thinking"];
    expect(sess.thinking).toBeUndefined();
    // defaults 仍是 max
    expect(useComposerPrefsStore.getState().defaults.thinking).toBe("max");
  });

  it("会话显式设置过 thinking 后，切换 defaults 不影响该会话", async () => {
    await dbSetDefaults({ model: null, thinking: "disabled" });
    await dbSetSessionPrefs({
      sessionId: "s-fixed", model: null, thinking: "high",
      attachments: [], updatedAt: Date.now(),
    });

    await useComposerPrefsStore.getState().loadDefaults();
    await useComposerPrefsStore.getState().loadSession("s-fixed");
    // 会话固定 high
    expect(useComposerPrefsStore.getState().bySession["s-fixed"].thinking).toBe("high");

    // 用户改了全局默认为 max
    useComposerPrefsStore.getState().setDefaults({ thinking: "max" });
    // 已设过 high 的会话不受影响
    expect(useComposerPrefsStore.getState().bySession["s-fixed"].thinking).toBe("high");
  });

  it("复现 hydration 竞态：loadSession 完成前 auto-select 写 model，不应丢失 IDB 里的附件和 thinking", async () => {
    await dbSetDefaults({ model: null, thinking: "disabled" });
    // 上次会话已在 IDB 持久化了片段附件和显式 thinking
    await dbSetSessionPrefs({
      sessionId: "s-gap-att", model: "old/model", thinking: "high",
      attachments: [{ kind: "snippet", name: "note", content: "hi" }],
      updatedAt: Date.now(),
    });

    // 竞态：reload 后 Composer 挂载，loadSession 已发起但未完成（异步 gap）；
    // ModelSelector 因 value=null 抢先 auto-select → setSessionPrefs({ model })
    const loadPromise = useComposerPrefsStore.getState().loadSession("s-gap-att");
    useComposerPrefsStore.getState().setSessionPrefs("s-gap-att", { model: "auto/first-model" });
    await loadPromise;
    await new Promise((r) => setTimeout(r, 10)); // 等 fire-and-forget 写入完成

    const sess = useComposerPrefsStore.getState().bySession["s-gap-att"];
    // gap 期间显式设置的 model 保留（既有行为：auto-select 结果不被 loadSession 覆盖）
    expect(sess.model).toBe("auto/first-model");
    // 未触碰的字段以持久层为准恢复（修复前：existing 守卫整体跳过，attachments 永远是 []）
    expect(sess.attachments).toEqual([{ kind: "snippet", name: "note", content: "hi" }]);
    expect(sess.thinking).toBe("high");
    // IDB 记录也不能被 gap 写入覆写丢附件
    const stored = await getSessionPrefs("s-gap-att");
    expect(stored?.attachments).toEqual([{ kind: "snippet", name: "note", content: "hi" }]);
    expect(stored?.model).toBe("auto/first-model");
  });

  it("复现：auto-select 先于 loadSession 发起（React 子 effect 先执行的真实时序），附件也不应丢失", async () => {
    await dbSetDefaults({ model: null, thinking: "disabled" });
    await dbSetSessionPrefs({
      sessionId: "s-gap-early", model: "old/model", thinking: "high",
      attachments: [{ kind: "snippet", name: "note", content: "hi" }],
      updatedAt: Date.now(),
    });

    // 真实浏览器时序：ModelSelector 是 Composer 的子组件，React 子 effect 先执行——
    // auto-select 的 setSessionPrefs 甚至早于 loadSession 被调用
    useComposerPrefsStore.getState().setSessionPrefs("s-gap-early", { model: "auto/first-model" });
    await useComposerPrefsStore.getState().loadSession("s-gap-early");
    await new Promise((r) => setTimeout(r, 10));

    const sess = useComposerPrefsStore.getState().bySession["s-gap-early"];
    expect(sess.model).toBe("auto/first-model");
    expect(sess.attachments).toEqual([{ kind: "snippet", name: "note", content: "hi" }]);
    expect(sess.thinking).toBe("high");
    const stored = await getSessionPrefs("s-gap-early");
    expect(stored?.attachments).toEqual([{ kind: "snippet", name: "note", content: "hi" }]);
  });

  it("loadSession 恢复 text 草稿", async () => {
    await dbSetDefaults({ model: null, thinking: "disabled" });
    await dbSetSessionPrefs({
      sessionId: "s-draft", model: null, thinking: "disabled",
      attachments: [], text: "写了一半的消息", updatedAt: Date.now(),
    });

    await useComposerPrefsStore.getState().loadSession("s-draft");

    expect(useComposerPrefsStore.getState().bySession["s-draft"].text).toBe("写了一半的消息");
  });

  it("gap 期间写入的 text 在 loadSession 合并中胜出", async () => {
    await dbSetDefaults({ model: null, thinking: "disabled" });
    await dbSetSessionPrefs({
      sessionId: "s-gap-text", model: null, thinking: "disabled",
      attachments: [], text: "持久层草稿", updatedAt: Date.now(),
    });

    // 异步 gap：loadSession 发起但未完成时，组件先写入了 text
    const loadPromise = useComposerPrefsStore.getState().loadSession("s-gap-text");
    useComposerPrefsStore.getState().setSessionPrefs("s-gap-text", { text: "gap 期间输入" });
    await loadPromise;
    await new Promise((r) => setTimeout(r, 10));

    expect(useComposerPrefsStore.getState().bySession["s-gap-text"].text).toBe("gap 期间输入");
  });

  it("发送清空（text: 空串）后 loadSession 不恢复文本", async () => {
    await dbSetDefaults({ model: null, thinking: "disabled" });
    await dbSetSessionPrefs({
      sessionId: "s-sent", model: null, thinking: "disabled",
      attachments: [], text: "已发送的草稿", updatedAt: Date.now(),
    });
    await useComposerPrefsStore.getState().loadSession("s-sent");
    useComposerPrefsStore.getState().setSessionPrefs("s-sent", { text: "" });
    await new Promise((r) => setTimeout(r, 10));

    // 模拟重启：内存态重置，持久化数据保留
    useComposerPrefsStore.setState({ bySession: {}, loadedBySession: {} });
    await useComposerPrefsStore.getState().loadSession("s-sent");

    expect(useComposerPrefsStore.getState().bySession["s-sent"].text ?? "").toBe("");
  });

  it("老记录（无 text 字段）加载后 text 为 undefined", async () => {
    await dbSetDefaults({ model: null, thinking: "disabled" });
    await dbSetSessionPrefs({
      sessionId: "s-old", model: null, thinking: "disabled",
      attachments: [], updatedAt: Date.now(),
    });

    await useComposerPrefsStore.getState().loadSession("s-old");

    expect(useComposerPrefsStore.getState().bySession["s-old"].text).toBeUndefined();
  });

  it("removeSessionPrefs 清内存 + IndexedDB 记录", async () => {
    await dbSetDefaults({ model: null, thinking: "disabled" });
    await dbSetSessionPrefs({
      sessionId: "s-del", model: null, thinking: "disabled",
      attachments: [], text: "待删除草稿", updatedAt: Date.now(),
    });
    await useComposerPrefsStore.getState().loadSession("s-del");
    expect(useComposerPrefsStore.getState().bySession["s-del"]).toBeDefined();

    useComposerPrefsStore.getState().removeSessionPrefs("s-del");
    await new Promise((r) => setTimeout(r, 10)); // 等 fire-and-forget 写入完成

    expect(useComposerPrefsStore.getState().bySession["s-del"]).toBeUndefined();
    expect(useComposerPrefsStore.getState().loadedBySession["s-del"]).toBeUndefined();
    expect(await getSessionPrefs("s-del")).toBeUndefined();
  });
});
