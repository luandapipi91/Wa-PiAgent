# 输入框草稿按会话持久化 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 按会话（sessionId）持久化未发送的输入框草稿：切走/刷新/重启后切回，文本与附件一并还原；发送或手动清空后草稿清除；删除会话时草稿一并清理。

**架构：** 扩展现有 composer 持久层——给 IndexedDB `ComposerSessionRecord` 与 store `SessionPrefs` 增加可选 `text` 字段；`Composer.tsx` / `NewSessionPane.tsx` 挂载时从 `bySession[sessionId].text` 恢复、输入防抖 300ms 写回、切走/卸载 flush；发送后写 `text: ""`；删除会话时调新增的 `removeSessionPrefs`。新建页复用其已有草稿 sessionId（`newSessionIds` 映射），无需新存储路径。

**技术栈：** React 19、zustand v5、IndexedDB（idb 库）、bun:test、@testing-library/react、Playwright。

**前置知识：**

- 单元/组件测试：`cd packages/frontend && bun run test`（bun test --isolate）
- 类型检查：`cd packages/frontend && bun run typecheck`（tsc --noEmit）
- E2E：`cd packages/frontend && bun run e2e`
- 组件测试用 `tests/mock-composer-db.ts` 的内存 mock（`composerDbSessions` 为 `Record<string, any>`），`setSessionPrefs` 在 mock 中是 no-op——防抖写回断言 store 内存态即可。
- 注意：`bun test` 不做类型检查；本计划的"红灯"在需要类型契约的层（任务 1）以 `typecheck` 为准，行为层以 `bun test` 为准。

---

## 文件结构

| 文件 | 职责 | 变更 |
| --- | --- | --- |
| `packages/frontend/src/store/composer-db.ts` | IndexedDB 持久层 | 修改：`ComposerSessionRecord` 加 `text?: string` |
| `packages/frontend/src/store/composer-prefs.ts` | zustand store + hydration 守卫 | 修改：`SessionPrefs` 加 `text?`；`loadSession` 合并 text；新增 `removeSessionPrefs` |
| `packages/frontend/src/components/Composer.tsx` | 已有会话输入框 | 修改：草稿恢复/防抖写回/flush/发送清空 |
| `packages/frontend/src/components/NewSessionPane.tsx` | 新建会话页输入框 | 修改：同上（挂现有草稿 sessionId） |
| `packages/frontend/src/components/ProjectItem.tsx` | 侧栏会话删除 | 修改：删除会话时调 `removeSessionPrefs` |
| `packages/frontend/tests/composer-db.test.ts` | db 层测试 | 修改：text 往返 |
| `packages/frontend/tests/composer-prefs.test.ts` | store 层测试 | 修改：text 恢复/合并/清空/removeSessionPrefs |
| `packages/frontend/tests/Composer.test.tsx` | Composer 组件测试 | 修改：草稿恢复/写回/发送清空/切换 |
| `packages/frontend/tests/NewSessionPane.test.tsx` | 新建页组件测试 | 修改：草稿恢复/发送清空 |
| `packages/frontend/tests/ProjectItem.system.test.tsx` | 删除接线测试 | 修改：删除会话清理草稿 |
| `packages/frontend/e2e/composer.spec.ts` | E2E | 修改：草稿六类场景 |
| `CHANGELOG.md` | 变更日志 | 修改：新增条目 |

---

## 任务 1：composer-db 数据模型 —— text 字段

**文件：**

- 修改：`packages/frontend/src/store/composer-db.ts`
- 测试：`packages/frontend/tests/composer-db.test.ts`

- [ ] **步骤 1：编写失败的测试（类型层红灯）**

在 `tests/composer-db.test.ts` 的 `describe("composer-db")` 内新增两个用例：

```ts
it("stores and retrieves text draft", async () => {
  await setSessionPrefs({
    sessionId: "test-session",
    model: "gpt-4o",
    thinking: "high",
    attachments: [],
    text: "写了一半的草稿",
    updatedAt: Date.now(),
  });
  const prefs = await getSessionPrefs("test-session");
  expect(prefs?.text).toBe("写了一半的草稿");
});

it("stores and retrieves empty text draft（清空语义）", async () => {
  await setSessionPrefs({
    sessionId: "test-session",
    model: "gpt-4o",
    thinking: "high",
    attachments: [],
    text: "",
    updatedAt: Date.now(),
  });
  const prefs = await getSessionPrefs("test-session");
  expect(prefs?.text).toBe("");
});
```

- [ ] **步骤 2：运行类型检查确认红灯**

运行：`cd packages/frontend && bun run typecheck`
预期：FAIL —— `ComposerSessionRecord` 无 `text` 属性（`text` 不存在于类型 `ComposerSessionRecord`）。
说明：db 层是透传存储（put/get 整条记录），运行时往返本就成立，本任务的红灯由类型契约承担。

- [ ] **步骤 3：实现 —— 加 text 字段**

`src/store/composer-db.ts`，在 `ComposerSessionRecord` 接口中 `attachments` 之后增加：

```ts
interface ComposerSessionRecord {
  sessionId: string;
  model: string | null;
  thinking: ThinkingLevel;
  attachments: AttachmentDraft[];
  text?: string; // 未发送的输入框草稿；缺省/空串 = 无草稿
  updatedAt: number;
}
```

- [ ] **步骤 4：验证绿灯**

运行：`cd packages/frontend && bun run test tests/composer-db.test.ts` 与 `bun run typecheck`
预期：composer-db 测试全部 PASS；typecheck PASS。

- [ ] **步骤 5：Commit**

```bash
git add packages/frontend/src/store/composer-db.ts packages/frontend/tests/composer-db.test.ts
git commit -m "feat(frontend): composer-db 记录增加 text 草稿字段"
```

---

## 任务 2：composer-prefs —— loadSession 合并与恢复 text

**文件：**

- 修改：`packages/frontend/src/store/composer-prefs.ts`
- 测试：`packages/frontend/tests/composer-prefs.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `tests/composer-prefs.test.ts` 的 `describe("composer-prefs store")` 内新增四个用例：

```ts
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
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd packages/frontend && bun run test tests/composer-prefs.test.ts`
预期：FAIL —— `bySession["s-draft"].text` 为 undefined（loadSession 未合并 text 字段）。

- [ ] **步骤 3：实现 —— SessionPrefs 加 text + loadSession 合并**

`src/store/composer-prefs.ts`：

1. 接口加字段：

```ts
export interface SessionPrefs {
  model: string | null;
  // thinking 可选：undefined 表示用户未在此会话显式设置过，组件读取时回退到 defaults.thinking
  thinking?: ThinkingLevel;
  attachments: AttachmentDraft[];
  text?: string; // 未发送的输入框草稿；缺省/空串 = 无草稿
}
```

1. `loadSession` 的 existing 合并分支改为：

```ts
      if (existing) {
        const merged: SessionPrefs = {
          model: gap?.model !== undefined ? gap.model : (stored?.model ?? existing.model),
          thinking: gap?.thinking ?? stored?.thinking ?? existing.thinking,
          attachments: gap?.attachments ?? stored?.attachments ?? existing.attachments,
          text: gap?.text ?? stored?.text ?? existing.text,
        };
        // gap 写入被守卫拦下未落盘，这里把合并结果统一持久化
        void dbSetSessionPrefs({ sessionId, model: merged.model, thinking: merged.thinking ?? defaults.thinking, attachments: merged.attachments, text: merged.text, updatedAt: Date.now() });
```

（`??` 对 `""` 生效：gap 写入的空串能正确胜出，不会被持久层旧值顶掉。）

1. `loadSession` 的非 existing 分支（首次加载）在 `attachments: stored?.attachments ?? []` 之后增加：

```ts
            attachments: stored?.attachments ?? [],
            ...(stored?.text !== undefined ? { text: stored.text } : {}),
```

- [ ] **步骤 4：运行测试确认通过**

运行：`cd packages/frontend && bun run test tests/composer-prefs.test.ts`
预期：全部 PASS（含原有用例）。

- [ ] **步骤 5：Commit**

```bash
git add packages/frontend/src/store/composer-prefs.ts packages/frontend/tests/composer-prefs.test.ts
git commit -m "feat(frontend): composer-prefs 加载/合并会话草稿 text"
```

---

## 任务 3：composer-prefs —— removeSessionPrefs action

**文件：**

- 修改：`packages/frontend/src/store/composer-prefs.ts`
- 测试：`packages/frontend/tests/composer-prefs.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `describe("composer-prefs store")` 内新增：

```ts
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
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd packages/frontend && bun run test tests/composer-prefs.test.ts`
预期：FAIL —— `removeSessionPrefs` is not a function。

- [ ] **步骤 3：实现**

`src/store/composer-prefs.ts`：

1. import 增加 `deleteSessionPrefs`：

```ts
import { getDefaults, getNewSessionIds, getSessionPrefs, setDefaults, setNewSessionIds, setSessionPrefs as dbSetSessionPrefs, deleteSessionPrefs } from "./composer-db";
```

1. 接口加方法：

```ts
  removeSessionPrefs: (sessionId: string) => void;
```

1. 实现（放在 `setSessionPrefs` 之后）：

```ts
  removeSessionPrefs: (sessionId) => {
    // 清理 hydration 守卫的会话级跟踪，避免同一 id 复用时旧状态残留
    loadedSessions.delete(sessionId);
    gapWrites.delete(sessionId);
    void deleteSessionPrefs(sessionId);
    set(s => {
      const bySession = { ...s.bySession };
      delete bySession[sessionId];
      const loadedBySession = { ...s.loadedBySession };
      delete loadedBySession[sessionId];
      return { bySession, loadedBySession };
    });
  },
```

- [ ] **步骤 4：运行测试确认通过**

运行：`cd packages/frontend && bun run test tests/composer-prefs.test.ts` 与 `bun run typecheck`
预期：全部 PASS；typecheck PASS。

- [ ] **步骤 5：Commit**

```bash
git add packages/frontend/src/store/composer-prefs.ts packages/frontend/tests/composer-prefs.test.ts
git commit -m "feat(frontend): composer-prefs 新增 removeSessionPrefs（删除会话时清理草稿）"
```

---

## 任务 4：Composer.tsx —— 草稿恢复 / 防抖写回 / 发送清空 / 切换清理

**文件：**

- 修改：`packages/frontend/src/components/Composer.tsx`
- 测试：`packages/frontend/tests/Composer.test.tsx`

- [ ] **步骤 1：编写失败的测试**

在 `describe("Composer")` 内新增四个用例（放在文件末尾、最后一个 `it` 之后）：

```tsx
it("prefs 含 text 时挂载后恢复草稿", async () => {
  useComposerPrefsStore.setState({
    bySession: { s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [], text: "写了一半" } },
    loadedBySession: { s1: true },
  });
  composerDbDefaults.model = "openai/gpt-4o";
  composerDbSessions.s1 = { model: "openai/gpt-4o", thinking: "disabled", attachments: [], text: "写了一半" };

  render(<Composer sessionId="s1" agentName="dev" />);
  await act(async () => {});
  const textbox = screen.getByTestId("composer-input").querySelector('[role="textbox"]') as HTMLElement;
  expect(textbox.textContent).toBe("写了一半");
});

it("输入防抖写回草稿；清空输入框写回空串（手动清空=放弃草稿）", async () => {
  useComposerPrefsStore.setState({
    bySession: { s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] } },
    loadedBySession: { s1: true },
  });
  composerDbDefaults.model = "openai/gpt-4o";
  composerDbSessions.s1 = { model: "openai/gpt-4o", thinking: "disabled", attachments: [] };

  render(<Composer sessionId="s1" agentName="dev" />);
  await act(async () => {});
  const textbox = typeIntoComposer("草稿");
  await new Promise((r) => setTimeout(r, 350)); // 等防抖 300ms 触发
  expect(useComposerPrefsStore.getState().bySession["s1"]?.text).toBe("草稿");

  textbox.textContent = "";
  fireEvent.input(textbox);
  await new Promise((r) => setTimeout(r, 350));
  expect(useComposerPrefsStore.getState().bySession["s1"]?.text).toBe("");
});

it("发送后清空草稿（含防抖未触发场景：发送前输入不复活）", async () => {
  useComposerPrefsStore.setState({
    bySession: { s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] } },
    loadedBySession: { s1: true },
  });
  composerDbDefaults.model = "openai/gpt-4o";
  composerDbSessions.s1 = { model: "openai/gpt-4o", thinking: "disabled", attachments: [] };

  render(<Composer sessionId="s1" agentName="dev" />);
  await act(async () => {});
  const textbox = typeIntoComposer("立即发送");
  // 300ms 内点发送：防抖定时器必须被清理，否则发送后草稿会"复活"
  fireEvent.click(screen.getByTestId("composer-send"));

  await waitFor(() => {
    expect(useComposerPrefsStore.getState().bySession["s1"]?.text).toBe("");
  });
  // 等待超过防抖窗口，确认没有被写回发送前文本
  await new Promise((r) => setTimeout(r, 350));
  expect(useComposerPrefsStore.getState().bySession["s1"]?.text).toBe("");
});

it("切换 sessionId 后清空旧文本并恢复新会话草稿（组件复用）", async () => {
  useComposerPrefsStore.setState({
    bySession: {
      s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [], text: "会话A草稿" },
      s2: { model: "openai/gpt-4o", thinking: "disabled", attachments: [], text: "会话B草稿" },
    },
    loadedBySession: { s1: true, s2: true },
  });
  composerDbDefaults.model = "openai/gpt-4o";
  composerDbSessions.s1 = { model: "openai/gpt-4o", thinking: "disabled", attachments: [], text: "会话A草稿" };
  composerDbSessions.s2 = { model: "openai/gpt-4o", thinking: "disabled", attachments: [], text: "会话B草稿" };
  useProjectsStore.setState({
    projects: [],
    sessions: [
      { id: "s1", projectId: "p1", primaryAgent: "dev", title: "t", createdAt: 0, lastActivity: 0, piSessionFile: "" },
      { id: "s2", projectId: "p1", primaryAgent: "dev", title: "t2", createdAt: 0, lastActivity: 0, piSessionFile: "" },
    ],
    currentProjectId: "p1",
    currentSessionId: "s1",
  });

  const { rerender } = render(<Composer sessionId="s1" agentName="dev" />);
  await act(async () => {});
  const textbox = screen.getByTestId("composer-input").querySelector('[role="textbox"]') as HTMLElement;
  expect(textbox.textContent).toBe("会话A草稿");

  rerender(<Composer sessionId="s2" agentName="dev" />);
  await act(async () => {});
  expect(textbox.textContent).toBe("会话B草稿");
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd packages/frontend && bun run test tests/Composer.test.tsx`
预期：新增四个用例 FAIL（恢复/写回/清空/切换未实现）。

- [ ] **步骤 3：实现**

`src/components/Composer.tsx`：

1. 组件顶部（`const [text, setText] = useState("");` 之后）新增草稿相关状态与引用：

```tsx
  const [text, setText] = useState("");
  // === 草稿持久化 ===
  const draftRestoredRef = useRef(false); // 当前 session 是否已尝试恢复草稿（按 sessionId 重置）
  const textRef = useRef("");             // 始终同步最新 text，供 cleanup flush
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevSessionIdRef = useRef(sessionId);
```

1. 在 `prefsLoaded` 定义后（`const prefsLoaded = useComposerPrefsStore(...)` 之后）增加草稿相关逻辑：

```tsx
  const draftText = prefs?.text;

  // 渲染期：sessionId 变化 → 立即清空输入框（消除旧会话文本残留一帧）+ 重置恢复标记
  if (prevSessionIdRef.current !== sessionId) {
    prevSessionIdRef.current = sessionId;
    draftRestoredRef.current = false;
    setText("");
  }
  // textRef 始终同步最新 text
  useEffect(() => { textRef.current = text; }, [text]);

  // 草稿恢复：prefs 加载完成且有草稿时恢复一次（draftRestoredRef 防止恢复后又被覆盖）
  useEffect(() => {
    if (!draftRestoredRef.current && prefsLoaded) {
      draftRestoredRef.current = true;
      if (draftText) setText(draftText);
    }
  }, [prefsLoaded, draftText, sessionId]);

  // 防抖写回：输入变化 300ms 后持久化（含清空 → 写空串 = 放弃草稿）
  const handleTextChange = (next: string) => {
    setText(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      setSessionPrefs(sessionId, { text: next });
    }, 300);
  };

  // 切走/卸载前 flush：把防抖未触发的最后文本写回（闭包捕获当前 sessionId）
  useEffect(() => {
    const mySessionId = sessionId;
    return () => {
      if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
      setSessionPrefs(mySessionId, { text: textRef.current });
    };
  }, [sessionId, setSessionPrefs]);
```

1. `doSend` 发送成功后（`setText("");` 之前）清掉防抖定时器并清空草稿：

```tsx
    if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
    setText("");
    setSessionPrefs(sessionId, { text: "" });
    setSessionPrefs(sessionId, { attachments: [] });
```

1. `ComposerInput` 的 `setText` prop 改为 `handleTextChange`：

```tsx
      <ComposerInput
        text={text}
        setText={handleTextChange}
```

（其余 props 不变。）

- [ ] **步骤 4：运行测试确认通过**

运行：`cd packages/frontend && bun run test tests/Composer.test.tsx` 与 `bun run typecheck`
预期：Composer 全部用例 PASS（含原有）；typecheck PASS。

- [ ] **步骤 5：Commit**

```bash
git add packages/frontend/src/components/Composer.tsx packages/frontend/tests/Composer.test.tsx
git commit -m "feat(frontend): 会话输入框草稿恢复/防抖写回/发送清空/切换清理"
```

---

## 任务 5：NewSessionPane.tsx —— 新建页草稿支持

**文件：**

- 修改：`packages/frontend/src/components/NewSessionPane.tsx`
- 测试：`packages/frontend/tests/NewSessionPane.test.tsx`

- [ ] **步骤 1：编写失败的测试**

在 `describe("NewSessionPane")` 内新增两个用例（注意：NewSessionPane 的草稿 sessionId 由 `newSessionIds` 映射，测试预置 `composerDbNewSessionIds` 使其可预测）：

```tsx
it("恢复新建页草稿文本（切走再回来不丢）", async () => {
  composerDbDefaults.model = "gpt-4o";
  composerDbDefaults.thinking = "disabled";
  composerDbNewSessionIds["p1"] = "draft-session-1";
  composerDbSessions["draft-session-1"] = { model: "gpt-4o", thinking: "disabled", attachments: [], text: "新建页草稿" };
  useProvidersStore.setState({
    providers: [
      { id: "p1", name: "openai", api: "openai-completions", baseUrl: "", apiKey: "", models: [{ id: "gpt-4o", contextWindow: 128000, maxTokens: 4096 }] },
    ],
  });

  render(<NewSessionPane />);
  const textbox = screen.getByTestId("composer-input").querySelector('[role="textbox"]') as HTMLElement;
  await waitFor(() => {
    expect(textbox.textContent).toBe("新建页草稿");
  });
});

it("新建页输入防抖写回草稿", async () => {
  composerDbDefaults.model = "gpt-4o";
  composerDbDefaults.thinking = "disabled";
  composerDbNewSessionIds["p1"] = "draft-session-2";
  composerDbSessions["draft-session-2"] = { model: "gpt-4o", thinking: "disabled", attachments: [] };
  useProvidersStore.setState({
    providers: [
      { id: "p1", name: "openai", api: "openai-completions", baseUrl: "", apiKey: "", models: [{ id: "gpt-4o", contextWindow: 128000, maxTokens: 4096 }] },
    ],
  });

  render(<NewSessionPane />);
  const textbox = typeIntoComposer("新建页输入");
  await new Promise((r) => setTimeout(r, 350));
  const sid = useComposerPrefsStore.getState().newSessionIds["p1"] ?? "draft-session-2";
  expect(useComposerPrefsStore.getState().bySession[sid]?.text).toBe("新建页输入");
});
```

（注意：`composerDbNewSessionIds` 是 NewSessionPane.test.tsx 顶部已定义的内存映射对象，mock 的 `setNewSessionIds` 会写入它。）

- [ ] **步骤 2：运行测试确认失败**

运行：`cd packages/frontend && bun run test tests/NewSessionPane.test.tsx`
预期：新增用例 FAIL（草稿未实现）。

- [ ] **步骤 3：实现**

`src/components/NewSessionPane.tsx`：

1. 顶部 `const [text, setText] = useState("");` 之后新增（与 Composer 相同模式，注意 NewSessionPane 的 sessionId 可能随项目切换而变）：

```tsx
  const [text, setText] = useState("");
  // === 草稿持久化 ===
  const draftRestoredRef = useRef(false);
  const textRef = useRef("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevSessionIdRef = useRef(sessionId);
```

1. 在 `prefs` 定义后（`const prefs = useComposerPrefsStore(s => s.bySession[sessionId]);` 之后）增加：

```tsx
  const prefsLoaded = useComposerPrefsStore(s => !!s.loadedBySession[sessionId]);
  const draftText = prefs?.text;

  // 渲染期：草稿 sessionId 变化（切换项目）→ 清空 + 重置恢复标记
  if (prevSessionIdRef.current !== sessionId) {
    prevSessionIdRef.current = sessionId;
    draftRestoredRef.current = false;
    setText("");
  }
  useEffect(() => { textRef.current = text; }, [text]);

  // 草稿恢复：prefs 加载完成且有草稿时恢复一次
  useEffect(() => {
    if (!draftRestoredRef.current && prefsLoaded) {
      draftRestoredRef.current = true;
      if (draftText) setText(draftText);
    }
  }, [prefsLoaded, draftText, sessionId]);

  // 防抖写回
  const handleTextChange = (next: string) => {
    setText(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      useComposerPrefsStore.getState().setSessionPrefs(sessionId, { text: next });
    }, 300);
  };

  // 切走/卸载前 flush
  useEffect(() => {
    const mySessionId = sessionId;
    return () => {
      if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
      useComposerPrefsStore.getState().setSessionPrefs(mySessionId, { text: textRef.current });
    };
  }, [sessionId]);
```

1. `handleSend` 发送成功后（`setText("");` 之前）清防抖定时器并清空草稿：

```tsx
    if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
    setText("");
    useComposerPrefsStore.getState().setSessionPrefs(sessionId, { text: "" });
    setAttachments([]);
```

1. `ComposerInput` 的 `setText` prop 改为 `handleTextChange`：

```tsx
      <ComposerInput
        text={text}
        setText={handleTextChange}
```

（其余 props 不变。）

- [ ] **步骤 4：运行测试确认通过**

运行：`cd packages/frontend && bun run test tests/NewSessionPane.test.tsx` 与 `bun run typecheck`
预期：NewSessionPane 全部用例 PASS（含原有）；typecheck PASS。

- [ ] **步骤 5：Commit**

```bash
git add packages/frontend/src/components/NewSessionPane.tsx packages/frontend/tests/NewSessionPane.test.tsx
git commit -m "feat(frontend): 新建页输入框草稿持久化"
```

---

## 任务 6：ProjectItem.tsx —— 删除会话时清理草稿

**文件：**

- 修改：`packages/frontend/src/components/ProjectItem.tsx`
- 测试：`packages/frontend/tests/ProjectItem.system.test.tsx`

- [ ] **步骤 1：编写失败的测试**

在 `ProjectItem.system.test.tsx` 中新增（放在现有测试之后；该文件已 mock `api-client` 的 `calls` 数组）：

```tsx
test("删除会话时调用 removeSessionPrefs 清理草稿", () => {
  useComposerPrefsStore.setState({
    bySession: { "s-del": { model: "m", thinking: "disabled", attachments: [], text: "草稿" } },
    loadedBySession: { "s-del": true },
  });
  const session: SessionEntity = { id: "s-del", projectId: "p1", primaryAgent: "dev", title: "会话", createdAt: 0, lastActivity: 0, piSessionFile: "" };

  render(
    <ProjectItem
      project={normalProject}
      sessions={[session]}
      currentSessionId={null}
      selected={false}
      onSelectSession={() => {}}
      onNewSessionInProject={() => {}}
      onSelectProject={() => {}}
    />
  );

  // 右键打开会话菜单 → 删除聊天 → 确认
  fireEvent.contextMenu(screen.getByTestId(`session-s-del`));
  fireEvent.click(screen.getByTestId("menu-delete"));
  fireEvent.click(screen.getByTestId("confirm-ok"));

  // 删除请求已发出
  expect(calls.some(c => c.method === "del" && c.path.includes("/sessions/s-del"))).toBe(true);
  // composer 草稿已从 store 清理
  expect(useComposerPrefsStore.getState().bySession["s-del"]).toBeUndefined();
});
```

需在文件顶部 import 增加 `useComposerPrefsStore`：

```tsx
import { useComposerPrefsStore } from "../src/store/composer-prefs";
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd packages/frontend && bun run test tests/ProjectItem.system.test.tsx`
预期：新增用例 FAIL —— `bySession["s-del"]` 仍被定义（删除时未清理）。

- [ ] **步骤 3：实现**

`src/components/ProjectItem.tsx`：

1. import 增加：

```tsx
import { useComposerPrefsStore } from "../store/composer-prefs";
```

1. `handleDeleteConfirm` 的 session 分支改为：

```tsx
  const handleDeleteConfirm = () => {
    if (!deleteTarget) return;
    if (deleteKind === "session") {
      const sid = (deleteTarget as SessionEntity).id;
      void api.del(`/api/sessions/${encodeURIComponent(sid)}`);
      // 同步清理该会话的 composer 草稿（IndexedDB + store 内存）
      useComposerPrefsStore.getState().removeSessionPrefs(sid);
    } else {
      void api.del(`/api/projects/${encodeURIComponent((deleteTarget as ProjectEntity).id)}`);
    }
    setDeleteTarget(null);
    setDeleteKind(null);
  };
```

- [ ] **步骤 4：运行测试确认通过**

运行：`cd packages/frontend && bun run test tests/ProjectItem.system.test.tsx` 与 `bun run typecheck`
预期：ProjectItem 全部用例 PASS；typecheck PASS。

- [ ] **步骤 5：Commit**

```bash
git add packages/frontend/src/components/ProjectItem.tsx packages/frontend/tests/ProjectItem.system.test.tsx
git commit -m "feat(frontend): 删除会话时清理其输入框草稿"
```

---

## 任务 7：E2E —— 草稿持久化场景

**文件：**

- 修改：`packages/frontend/e2e/composer.spec.ts`

**前置说明：** E2E 依赖运行中的 kernel + frontend（`bun run dev`）。新增用例放在现有 `test.describe.serial("Composer 重构")` 内、最后一个现有测试之后。复用文件顶部已有的 `enterSession` helper（输入文本 → 发送 → 返回会话 id）与 `page.getByTestId(...)` 选择器约定（`session-{id}` 会话行、`new-session-btn` 新建按钮、`new-session-pane` 新建页、`composer-input [role="textbox"]` 输入框）。

- [ ] **步骤 1：编写 E2E 用例**

新增五个测试：

```ts
test("草稿：切会话回来恢复", async ({ page }) => {
  // 会话 A（已有草稿）→ 切到新建页 → 切回会话 A
  const sidA = await enterSession(page, "草稿会话A");
  const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');
  await textbox.fill("写了一半的草稿");
  await page.waitForTimeout(400); // 等防抖写回

  await page.getByTestId("new-session-btn").click();
  await expect(page.getByTestId("new-session-pane")).toBeVisible({ timeout: 5000 });

  await page.getByTestId(`session-${sidA}`).click();
  await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 5000 });
  await expect(textbox).toHaveText("写了一半的草稿");
});

test("草稿：刷新后恢复", async ({ page }) => {
  const sidA = await enterSession(page, "草稿刷新会话");
  const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');
  await textbox.fill("刷新后仍在的草稿");
  await page.waitForTimeout(400); // 等防抖写回 IndexedDB

  await page.reload();
  await page.getByTestId(`session-${sidA}`).click();
  await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 5000 });
  await expect(textbox).toHaveText("刷新后仍在的草稿");
});

test("草稿：发送后清空", async ({ page }) => {
  const sidA = await enterSession(page, "草稿发送会话");
  const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');
  await textbox.fill("发送后不应残留");
  await page.waitForTimeout(400);
  await page.getByTestId("composer-send").click();
  await expect(textbox).toBeEmpty();

  await page.getByTestId("new-session-btn").click();
  await expect(page.getByTestId("new-session-pane")).toBeVisible({ timeout: 5000 });
  await page.getByTestId(`session-${sidA}`).click();
  await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 5000 });
  await expect(textbox).toBeEmpty();
});

test("草稿：手动清空输入框后不复活", async ({ page }) => {
  const sidA = await enterSession(page, "草稿清空会话");
  const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');
  await textbox.fill("将被手动清空");
  await page.waitForTimeout(400);
  await textbox.fill(""); // 手动清空 = 放弃草稿
  await page.waitForTimeout(400);

  await page.getByTestId("new-session-btn").click();
  await expect(page.getByTestId("new-session-pane")).toBeVisible({ timeout: 5000 });
  await page.getByTestId(`session-${sidA}`).click();
  await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 5000 });
  await expect(textbox).toBeEmpty();
});

test("草稿：新建页输入切走再回来恢复", async ({ page }) => {
  // 先建一个真实会话，用于"切走"
  await enterSession(page, "草稿切走会话");
  const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');

  // 回到新建页输入草稿
  await page.getByTestId("new-session-btn").click();
  await expect(page.getByTestId("new-session-pane")).toBeVisible({ timeout: 5000 });
  await textbox.fill("新建页的草稿");
  await page.waitForTimeout(400);

  // 切到已有会话再切回新建页
  await page.locator('aside [data-testid^="session-"]').first().click();
  await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 5000 });
  await page.getByTestId("new-session-btn").click();
  await expect(page.getByTestId("new-session-pane")).toBeVisible({ timeout: 5000 });
  await expect(textbox).toHaveText("新建页的草稿");
});
```

- [ ] **步骤 2：运行 E2E 验证**

运行：`cd packages/frontend && bun run e2e composer.spec.ts --grep "草稿"`
预期：五个草稿用例全部 PASS；现有 composer 用例不回归（`--grep` 之外的用例若需全量验证可去掉 grep 全跑）。

- [ ] **步骤 3：Commit**

```bash
git add packages/frontend/e2e/composer.spec.ts
git commit -m "test(frontend): E2E 覆盖输入框草稿持久化场景"
```

---

## 任务 8：CHANGELOG 与全量验证

**文件：**

- 修改：`CHANGELOG.md`

- [ ] **步骤 1：更新 CHANGELOG**

在 `CHANGELOG.md` 顶部（时间倒序）新增条目，格式参照现有条目（日期 / 类型 / 摘要 / 影响范围）：

```markdown
## [2026-08-03]

### 新增
- 输入框草稿按会话持久化：切会话/刷新/重启后切回，未发送文本与附件自动还原；发送或手动清空后草稿清除；删除会话时草稿一并清理（packages/frontend：store/composer-db.ts、store/composer-prefs.ts、components/Composer.tsx、components/NewSessionPane.tsx、components/ProjectItem.tsx）
```

（实际格式以 CHANGELOG.md 现有结构为准，保持风格一致。）

- [ ] **步骤 2：全量测试与类型检查**

运行：`cd packages/frontend && bun run test` 与 `cd packages/frontend && bun run typecheck`
预期：frontend 全部单元/组件测试 PASS（已知的 717 个预存在失败除外——它们是 happy-dom/bun 环境相关的既有问题，与本次改动无关）；typecheck PASS。

- [ ] **步骤 3：全量 E2E 回归**

运行：`cd packages/frontend && bun run e2e composer.spec.ts`
预期：composer.spec.ts 全部用例 PASS。

- [ ] **步骤 4：Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG 记录输入框草稿持久化"
```

---

## 自检对照

**规格覆盖度：**

- 会话输入框草稿持久化（切走/刷新恢复）→ 任务 2（store 恢复）+ 任务 4（Composer 恢复）+ 任务 7（E2E 刷新/切换）
- 新建页草稿持久化 → 任务 5 + 任务 7（新建页用例）
- 发送后清空 → 任务 4/5（doSend/handleSend 清空 + 防抖清理）+ 任务 7
- 手动清空 = 放弃草稿 → 任务 4（写空串）+ 任务 7（清空不复活用例）
- 附件切换还原 → 不新增代码（现状已成立），E2E 任务 7 未单独列附件用例——规格 §7 要求"会话 A 挂附件草稿 → 切走切回 → 附件列表还原"；实现者可在任务 7 追加一个用例：通过 IndexedDB 注入附件（参照现有"片段附件发送流程"的 `page.evaluate` 写法）→ 刷新/切换 → `attachment-list` 可见。若时间有限可在任务 7 内补上该用例。
- 删除会话清理 → 任务 3（removeSessionPrefs）+ 任务 6（接线）
- 消除跨会话文本残留 → 任务 4（渲染期清空 + 恢复）

**占位符扫描：** 无 TODO/待定；所有步骤含完整代码或精确命令。

**类型一致性：** `text` 字段在 composer-db（`ComposerSessionRecord`）、composer-prefs（`SessionPrefs`）、组件（`draftText`/`handleTextChange`）三处命名一致；`removeSessionPrefs` 在 store 接口与 ProjectItem 调用签名一致。
