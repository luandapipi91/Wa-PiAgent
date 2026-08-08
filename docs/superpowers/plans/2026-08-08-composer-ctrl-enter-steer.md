# Composer Ctrl+Enter 引导发送 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 输入框新增 `Ctrl+Enter`（macOS 为 `Cmd+Enter`）：agent 运行中把输入框内容作为引导（steering）消息发送（调 `/steer`），空闲时等同普通发送；`Enter` 行为不变。

**架构：** `ComposerInput` 新增可选 prop `onSendSteer`，在 `handleKeyDown` 中拦截 `Ctrl/Cmd+Enter` 并上抛；`Composer` 新增 `handleSendSteer` 回调：空闲走现有 `doSend`，运行中乐观更新 steering 队列 + `POST /api/sessions/:sessionId/steer`（复刻 `SessionView.handlePromote` 模式，不设 optimisticEcho，因 `/steer` 不触发 `echo_user`）。

**技术栈：** React + TypeScript、bun:test + @testing-library/react、Zustand store。

**规格：** `docs/superpowers/specs/2026-08-08-composer-ctrl-enter-steer-design.md`

---

### 任务 1：编写失败测试

**文件：**

- 修改：`packages/frontend/tests/Composer.test.tsx`（在最后一个 `it(...)` 之后、`describe` 闭合之前追加）

- [ ] **步骤 1：追加 3 个测试用例**

在 `Composer.test.tsx` 中追加以下代码（放在文件末尾 `describe("Composer", ...)` 的最后一个 `it` 块之后、`});` 之前）：

```tsx
  it("运行中 Ctrl+Enter 发送引导消息（steering）：调 /steer、入 steering 队列、不进 followUp、清空输入框", async () => {
    useComposerPrefsStore.setState({
      bySession: { s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] } },
    });
    composerDbDefaults.model = "openai/gpt-4o";
    composerDbSessions.s1 = { model: "openai/gpt-4o", thinking: "disabled", attachments: [] };

    render(<Composer sessionId="s1" agentName="dev" isRunning />);
    await act(async () => {});
    const textbox = typeIntoComposer("引导消息");
    fireEvent.keyDown(textbox, { key: "Enter", ctrlKey: true });

    await waitFor(() => {
      const steerReq = sent.filter((s) => s.path && s.path.includes("/steer")).at(-1);
      expect(steerReq?.path).toBe("/api/sessions/s1/steer");
      expect(steerReq?.body).toMatchObject({ text: "引导消息" });
      const s = useSessionStore.getState();
      expect(s.queueBySession["s1"]?.steering).toContain("引导消息");
      expect(s.queueBySession["s1"]?.followUp ?? []).not.toContain("引导消息");
      // 发送后清空输入框（setText 异步渲染，在 waitFor 内断言）
      expect(textbox.textContent).toBe("");
    });
    // 不得走 /prompt（引导消息不能进入 followUp 排队）
    expect(sent.filter((s) => s.path && s.path.includes("/prompt"))).toHaveLength(0);
  });

  it("空闲时 Ctrl+Enter 等同普通发送：调 /prompt", async () => {
    useComposerPrefsStore.setState({
      bySession: { s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] } },
    });
    composerDbDefaults.model = "openai/gpt-4o";
    composerDbSessions.s1 = { model: "openai/gpt-4o", thinking: "disabled", attachments: [] };

    render(<Composer sessionId="s1" agentName="dev" />);
    await act(async () => {});
    const textbox = typeIntoComposer("普通消息");
    fireEvent.keyDown(textbox, { key: "Enter", ctrlKey: true });

    await waitFor(() => {
      const req = sent.filter((s) => s.path && s.path.includes("/prompt")).at(-1);
      expect(req?.path).toBe("/api/agents/p1/s1/prompt");
      expect(req?.body).toMatchObject({ text: "普通消息", agentName: "dev" });
    });
  });

  it("IME 组词中 Ctrl+Enter 不触发发送", async () => {
    useComposerPrefsStore.setState({
      bySession: { s1: { model: "openai/gpt-4o", thinking: "disabled", attachments: [] } },
    });
    composerDbDefaults.model = "openai/gpt-4o";
    composerDbSessions.s1 = { model: "openai/gpt-4o", thinking: "disabled", attachments: [] };

    render(<Composer sessionId="s1" agentName="dev" isRunning />);
    await act(async () => {});
    const textbox = typeIntoComposer("测试");
    fireEvent.keyDown(textbox, { key: "Enter", ctrlKey: true, isComposing: true });

    expect(sent.length).toBe(0);
  });
```

- [ ] **步骤 2：运行测试确认新增用例失败**

运行：`cd /h/workspace/hiagent/packages/frontend && bun --env-file=.env.test test Composer.test.tsx --isolate`

预期：新增 3 个用例 **FAIL**（运行中用例断言 `/steer` 请求但实际无请求、空闲用例断言 `/prompt` 但实际无请求、IME 用例因前两者失败而相关），现有用例全部 PASS。若 IME 用例意外 PASS（`isComposing` 未透传），在实现前先调整该用例的事件构造（如用 `fireEvent.keyDown(textbox, { key: "Enter", ctrlKey: true, keyCode: 229 })`）并确认其 FAIL，保证测试先红。

### 任务 2：实现 ComposerInput 的 Ctrl/Cmd+Enter 分支

**文件：**

- 修改：`packages/frontend/src/components/ui/ComposerInput.tsx`

- [ ] **步骤 1：Props 接口新增 `onSendSteer`**

在 `ComposerInput.tsx` 的 `Props` 接口中 `onSend: () => void;` 行之后新增：

```tsx
 /** Ctrl/Cmd+Enter 引导发送回调（运行中走 steering，空闲等同普通发送）；不传则 Ctrl+Enter 无动作 */
 onSendSteer?: () => void;
```

- [ ] **步骤 2：函数解构新增 `onSendSteer`**

在函数参数解构中 `onSend,` 之后新增：

```tsx
 onSendSteer,
```

- [ ] **步骤 3：`handleKeyDown` 新增 Ctrl/Cmd+Enter 分支**

在 `ComposerInput.tsx` 的 `handleKeyDown` 中，QuickInvoke 面板导航分支之后、`// 正常 Enter 发送` 分支之前（约 680-681 行之间）插入：

```tsx
   // Ctrl/Cmd+Enter：引导发送（运行中走 steering，空闲等同普通发送）
   if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    if (canSend) onSendSteer?.();
    return;
   }
```

同时将 `handleKeyDown` 的依赖数组 `[menuOpen, menuItems, highlightedIndex, handleSelect, canSend, onSend]` 更新为追加 `onSendSteer`。

- [ ] **步骤 4：运行测试（预期仍失败）**

运行：`cd /h/workspace/hiagent/packages/frontend && bun --env-file=.env.test test Composer.test.tsx --isolate`

预期：新增 3 个用例仍 FAIL（Composer 尚未传 `onSendSteer`，`onSendSteer?.()` 为空调用）。

### 任务 3：实现 Composer 的 handleSendSteer

**文件：**

- 修改：`packages/frontend/src/components/Composer.tsx`

- [ ] **步骤 1：新增 `handleSendSteer` 回调**

在 `Composer.tsx` 的 `handleSend` 定义之后（约 161 行后）新增：

```tsx
 const handleSendSteer = () => {
  if (disabled) return;
  const expandedText = expandTokens(text);
  if (!expandedText.trim() || !isModelAvailable(model, providers) || sendingRef.current || !projectId) return;
  if (!isRunning) {
   // 空闲：等同普通发送（走 doSend 完整清理逻辑）
   doSend(agentName, expandedText);
   return;
  }
  // 运行中：乐观加入 steering 队列 + 调 /steer（复刻 SessionView.handlePromote 模式，
  // 不设 optimisticEcho——/steer 不触发 session:echo_user，与 handlePromote 一致）
  useSessionStore.setState((s) => {
   const cur = s.queueBySession[sessionId];
   return {
    queueBySession: {
     ...s.queueBySession,
     [sessionId]: {
      steering: cur?.steering?.includes(expandedText) ? cur.steering : [...(cur?.steering ?? []), expandedText],
      followUp: cur?.followUp ?? [],
     },
    },
   };
  });
  api
   .post(`/api/sessions/${encodeURIComponent(sessionId)}/steer`, { text: expandedText })
   .catch((err) => console.error("[composer] 引导发送失败:", err));
  if (debounceRef.current) {
   clearTimeout(debounceRef.current);
   debounceRef.current = null;
  }
  setText("");
  setSessionPrefs(sessionId, { text: "" });
 };
```

- [ ] **步骤 2：传给 `ComposerInput` 的 `onSendSteer`**

在 `Composer.tsx` 渲染 `ComposerInput` 处，`onSend={handleSend}` 之后新增一行：

```tsx
      onSendSteer={handleSendSteer}
```

- [ ] **步骤 3：运行测试确认新增用例通过**

运行：`cd /h/workspace/hiagent/packages/frontend && bun --env-file=.env.test test Composer.test.tsx --isolate`

预期：新增 3 个用例全部 **PASS**，现有用例全部 PASS。

### 任务 4：回归验证

**文件：** 无改动

- [ ] **步骤 1：运行前端完整测试套件确认无回归**

运行：`cd /h/workspace/hiagent/packages/frontend && bun --env-file=.env.test test --isolate`

预期：所有测试文件全部 PASS。

- [ ] **步骤 2：TypeScript 类型检查**

运行：`cd /h/workspace/hiagent/packages/frontend && bunx tsc --noEmit`

预期：无类型错误（`onSendSteer` prop 在两个文件间类型一致）。

### 任务 5：Commit + 更新 CHANGELOG

**文件：**

- 修改：`CHANGELOG.md`（项目根目录；若文件不存在则创建，并按既有格式追加）

- [ ] **步骤 1：更新 CHANGELOG**

在 `CHANGELOG.md` 顶部（时间倒序）新增一条：

```markdown
## 2026-08-08

- **新增功能**：输入框支持 Ctrl+Enter（macOS Cmd+Enter）引导发送——agent 运行中直接作为引导（steering）消息发送，空闲时等同普通发送；Enter 行为不变（运行中仍进排队队列）。
  - 影响范围：packages/frontend/src/components/Composer.tsx、packages/frontend/src/components/ui/ComposerInput.tsx、packages/frontend/tests/Composer.test.tsx
```

- [ ] **步骤 2：Commit**

```bash
cd /h/workspace/hiagent && git add packages/frontend/src/components/Composer.tsx packages/frontend/src/components/ui/ComposerInput.tsx packages/frontend/tests/Composer.test.tsx CHANGELOG.md && git commit -m "feat: 输入框 Ctrl+Enter 引导发送"
```
