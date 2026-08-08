# 内置命令「压缩上下文」+ 压缩后刷新 token — 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在内置 `/` 命令菜单新增「压缩上下文」（cmd:compact），选中后插入可编辑 `/[compact]` chip（支持自定义压缩指令），发送时展开为 `/compact 指令` 由 pi 原生执行；并在压缩回合结束（agent_end）后自动重拉会话历史，刷新右上角 token 胶囊。

**架构：** 纯前端实现，零改动 kernel/pi/App.tsx。① `ComposerInput.tsx`：builtinCommands 新增菜单项 + handleSelect 的 cmd: 分支特判插入 chip；② `store/session.ts`：新增 `refreshTokenTotals` store 方法（复用 `GET /api/sessions/:sid/messages` + `seedTokenTotal` 重算），`agent_end` case 检测最后一条 user 消息以 `/compact` 开头则触发刷新。发送链路复用现有 `expandTokens`（COMMAND_TOKEN_RE 已支持 `/[name]` → `/name` 展开）。

**技术栈：** React 18 / zustand / bun:test / Playwright（E2E）

**设计文档：** `docs/superpowers/specs/2026-08-03-compact-command-design.md`

---

### 任务 1：tokens 展开回归测试（`/[compact]` → `/compact`）

**文件：**

- 测试：`packages/frontend/tests/tokens.test.ts`

`expandTokens` 的 `COMMAND_TOKEN_RE` 已支持 `/[名称]` 展开（插件命令 /goal 在用），本测试为回归保护，行为已存在，预期直接通过。

- [ ] **步骤 1：追加测试用例**

在 `packages/frontend/tests/tokens.test.ts` 的 expandTokens 相关测试块后追加：

```ts
test("expandTokens 展开命令 token（/[/compact] -> /compact 空格）", () => {
  expect(expandTokens("/[compact] 只保留关键决策")).toBe("/compact  只保留关键决策");
  expect(expandTokens("/[compact]")).toBe("/compact ");
});
```

- [ ] **步骤 2：运行测试确认通过（回归保护，行为已存在）**

运行：`cd packages/frontend && bun test --isolate tests/tokens.test.ts`
预期：PASS（tokens 展开为既有机制，此测试直接通过）

- [ ] **步骤 3：Commit**

```bash
git add packages/frontend/tests/tokens.test.ts
git commit -m "test(frontend): 命令 token /[compact] 展开回归测试"
```

---

### 任务 2：store 新增 refreshTokenTotals + agent_end 检测（TDD）

**文件：**

- 修改：`packages/frontend/src/store/session.ts`（接口 89 行附近、实现 215 行附近 setMessages 之后、agent_end case 667 行附近）
- 测试：`packages/frontend/tests/store-session.test.ts`

**TDD 流程：先写失败测试 → 实现 → 通过。**

- [ ] **步骤 1：编写失败的测试**

在 `packages/frontend/tests/store-session.test.ts` 顶部加 mock api-client（参考 `tests/commands.test.ts` 模式，置于 `import` 之后、`beforeEach` 之前）：

```ts
// refreshTokenTotals 会调用 api.get 拉取会话历史；mock 掉 api-client，
// 返回可注入的 messages，断言聚焦于「/compact 回合结束触发刷新」逻辑。
const mockMessages: { messages: any[] } = { messages: [] };
let getCalls = 0;

mock.module("../src/api-client", () => ({
  api: {
    get: () => {
      getCalls++;
      return Promise.resolve(mockMessages);
    },
    post: () => Promise.resolve({}),
    put: () => Promise.resolve({}),
    del: () => Promise.resolve({}),
  },
}));
```

在文件末尾追加两个测试：

```ts
// ── 压缩回合结束（agent_end）→ 重拉历史刷新 token 累计 ──

test("agent_end：最后一条 user 以 /compact 开头 → 触发 refreshTokenTotals 重算 token", async () => {
  getCalls = 0;
  // 预置：一条 /compact 用户消息 + 旧累计值
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        { message: { role: "user", content: "/compact 只保留关键决策", timestamp: 1 }, agentName: undefined },
        { message: { role: "assistant", content: [], model: "pending", stopReason: "pending", timestamp: 2 }, agentName: "dev" },
      ],
    },
    tokenTotals: { s1: { input: 1000, output: 500 } },
  });
  // mock 返回压缩后的历史（token 已缩小）
  mockMessages.messages = [
    { message: { role: "user", content: "/compact 只保留关键决策", timestamp: 1 }, agentName: undefined },
    { message: { role: "assistant", content: "（压缩摘要）", timestamp: 2, usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } }, agentName: "dev" },
  ];

  useSessionStore.getState().handleSDKEvent("s1", envelope({ type: "agent_end", messages: [], willRetry: false }));

  // 等 refreshTokenTotals 的异步链完成
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  expect(getCalls).toBe(1);
  const totals = useSessionStore.getState().tokenTotals["s1"];
  expect(totals?.input).toBe(100);
  expect(totals?.output).toBe(50);
  expect(useSessionStore.getState().lastUsageBySession["s1"]?.input).toBe(100);
});

test("agent_end：最后一条 user 不是 /compact → 不触发 refresh", async () => {
  getCalls = 0;
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        { message: { role: "user", content: "普通问题", timestamp: 1 }, agentName: undefined },
      ],
    },
    tokenTotals: { s1: { input: 1000, output: 500 } },
  });

  useSessionStore.getState().handleSDKEvent("s1", envelope({ type: "agent_end", messages: [], willRetry: false }));
  await Promise.resolve();
  await Promise.resolve();

  expect(getCalls).toBe(0);
  expect(useSessionStore.getState().tokenTotals["s1"]?.input).toBe(1000);
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd packages/frontend && bun test --isolate tests/store-session.test.ts`
预期：FAIL——`refreshTokenTotals is not a function`（方法尚未实现）

- [ ] **步骤 3：实现 store 变更**

3a. 顶部加 import（第 2 行附近，`import { create } from "zustand"` 之后）：

```ts
import { api } from "../api-client";
```

3b. 接口 `SessionState`（第 89 行 `handleSDKEvent` 声明附近）新增方法声明：

```ts
 // 压缩回合结束（agent_end 且本轮 user 为 /compact）后重拉历史，重算 token 累计
 refreshTokenTotals: (sessionId: string) => Promise<void>;
```

3c. 实现方法（`setMessages` 实现 215 行之后追加，`useSessionStore` 创建体的某个方法槽位内）：

```ts
  refreshTokenTotals: async (sessionId) => {
   try {
    const res = (await api.get(
     `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
    )) as { messages: any[] };
    if (!res?.messages) return;
    useSessionStore.setState((s) => ({
     messagesBySession: {
      ...s.messagesBySession,
      [sessionId]: res.messages,
     },
    }));
    useSessionStore.getState().seedTokenTotal(sessionId, res.messages);
   } catch {
    // 刷新失败不影响主流程，静默忽略
   }
  },
```

3d. `agent_end` case（第 667 行起，`set(...)` 与 `break;` 之间，即现有 set 回调结束后）：

```ts
     // 压缩回合结束：重拉历史，刷新右上角 token 累计
     const list = useSessionStore.getState().messagesBySession[sessionId] ?? [];
     const lastUser = [...list]
      .reverse()
      .find((m: any) => (m.message as any)?.role === "user");
     const lastUserText =
      typeof lastUser?.message?.content === "string"
       ? (lastUser.message as any).content
       : "";
     if (lastUserText.trim().startsWith("/compact")) {
      void useSessionStore.getState().refreshTokenTotals(sessionId);
     }
```

> 注：agent_end case 内 `set` 结束后读取 `useSessionStore.getState()` 拿到的是已更新列表（含 turnElapsedMs 写回），last user 消息不受影响。

- [ ] **步骤 4：运行测试确认通过**

运行：`cd packages/frontend && bun test --isolate tests/store-session.test.ts`
预期：PASS，两个新用例 + 既有用例全部通过

- [ ] **步骤 5：Commit**

```bash
git add packages/frontend/src/store/session.ts packages/frontend/tests/store-session.test.ts
git commit -m "feat(frontend): 压缩回合结束后重拉历史刷新 token 累计"
```

---

### 任务 3：ComposerInput 新增「压缩上下文」菜单项 + 选中插入 chip（TDD）

**文件：**

- 修改：`packages/frontend/src/components/ui/ComposerInput.tsx`（builtinCommands 数组 226-255 行、handleSelect cmd: 分支 531-551 行）
- 测试：`packages/frontend/tests/ComposerInput.test.tsx`

**TDD 流程：先写失败测试 → 实现 → 通过。**

- [ ] **步骤 1：编写失败的组件测试**

在 `packages/frontend/tests/ComposerInput.test.tsx` 的 `/ 命令菜单` describe（约 899 行）内，`选中前端 handler 命令 reload` 用例之后追加：

```tsx
 it("输入 / 显示内置命令「压缩上下文」", () => {
  renderComposer({ text: "/" });
  expect(screen.getByText("压缩上下文")).toBeDefined();
 });

 it("选中「压缩上下文」插入 /[compact] chip 且不 dispatch wa-pi:pi-command", () => {
  const setText = mock();
  const piHandler = mock();
  window.addEventListener("wa-pi:pi-command", piHandler);
  try {
   // 用 / 不带查询，显示完整菜单
   renderComposer({ text: "/", setText, isRunning: false, isNewSession: false });
   fireEvent.click(screen.getByText("压缩上下文"));
   // 不 dispatch pi-command（内置命令走前端 handler）
   expect(piHandler).not.toHaveBeenCalled();
   // 输入框被设置为 /[compact] 前缀（用户可继续输入自定义指令）
   expect(setText).toHaveBeenCalled();
   const lastCall = setText.mock.calls.at(-1)?.[0] as string;
   expect(lastCall).toContain("/[compact]");
  } finally {
   window.removeEventListener("wa-pi:pi-command", piHandler);
  }
 });

 it("空会话时「压缩上下文」禁用（选中无效）", () => {
  const setText = mock();
  renderComposer({ text: "/", setText, isRunning: false, isNewSession: true });
  // 禁用项由 QuickInvokeMenu 渲染为无 onClick 的项：点击后 setText 不应被调用
  const item = screen.getByText("压缩上下文");
  fireEvent.click(item);
  expect(setText).not.toHaveBeenCalledWith(expect.stringContaining("/[compact]"));
 });
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd packages/frontend && bun test --isolate tests/ComposerInput.test.tsx`
预期：FAIL——`压缩上下文` 未在菜单中渲染（getByText 找不到）

- [ ] **步骤 3：实现 ComposerInput 变更**

3a. `builtinCommands` 数组（`cmd:reload` 项之后）新增：

```ts
   {
    id: "cmd:compact",
    name: "压缩上下文",
    description: "压缩会话历史释放 token（可附带自定义压缩指令）",
    source: { type: "builtin", name: "命令" },
    disabled: isRunning || isNewSession,
   },
```

3b. `handleSelect` 的 `cmd:` 分支重构——把 `const cmd = item.id.slice(4)` 上移到「清除 / 触发文本」之前，并在其后插入 compact 特判（其余 settings/agents/skills/reload 分支原样保留）：

```ts
   // / 命令触发选中内置命令（如系统设置）时执行动作而非插入 token
   if (triggerType === "command" && item.id.startsWith("cmd:")) {
    setDismissed(true);
    const cmd = item.id.slice(4); // 去掉 "cmd:" 前缀
    // 压缩上下文：插入 /[compact] chip（可追加自定义指令），发送时展开为 /compact
    if (cmd === "compact") {
     const token = "/[compact] ";
     if (trigger) {
      const triggerRe = new RegExp(
       `/${trigger.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      );
      setText(text.replace(triggerRe, token));
     } else {
      setText(token);
     }
     return;
    }
    // 清除输入框中的 / 命令文本
    if (trigger) {
     const triggerRe = new RegExp(
      `/${trigger.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
     );
     setText(text.replace(triggerRe, ""));
    }
    if (cmd === "settings") {
     window.dispatchEvent(new CustomEvent("wa-pi:open-settings"));
    } else if (cmd === "agents") {
     window.dispatchEvent(new CustomEvent("wa-pi:open-gallery"));
    } else if (cmd === "skills") {
     window.dispatchEvent(new CustomEvent("wa-pi:open-settings-skills"));
    } else if (cmd === "reload") {
     window.dispatchEvent(new CustomEvent("wa-pi:reload-config"));
    }
    return;
   }
```

> 注意：原代码是「先清空 / 触发文本、再判 cmd」；compact 分支必须在清空之前处理，否则 `setText(text.replace(triggerRe, ""))` 的旧 text 闭包会与 compact 的 setText 冲突。重构后 compact 先 return，不影响其余命令。

- [ ] **步骤 4：运行测试确认通过**

运行：`cd packages/frontend && bun test --isolate tests/ComposerInput.test.tsx`
预期：PASS，三个新用例 + 既有用例全部通过

- [ ] **步骤 5：运行全量前端测试确认无回归**

运行：`cd packages/frontend && bun test --isolate`
预期：PASS（全部前端测试通过）

- [ ] **步骤 6：Commit**

```bash
git add packages/frontend/src/components/ui/ComposerInput.tsx packages/frontend/tests/ComposerInput.test.tsx
git commit -m "feat(frontend): 内置命令新增「压缩上下文」，选中插入 /[compact] chip"
```

---

### 任务 4：E2E 用例

**文件：**

- 修改：`packages/frontend/e2e/quick-invoke.spec.ts`

- [ ] **步骤 1：追加 E2E 用例**

在 `quick-invoke.spec.ts` 的 describe 内、既有「输入 $ 选技能」用例之后追加：

```ts
  test("输入 / 选压缩上下文 → chip 显示 → 发送时展开为 /compact", async ({ page }) => {
    await enterSession(page, "发起压缩会话");

    const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');

    // 1. 输入 / 触发命令菜单
    await textbox.click();
    await page.keyboard.type("/", { delay: 5 });

    // 2. 等待菜单出现，断言含「压缩上下文」
    await expect(page.getByTestId("quick-invoke-menu")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("quick-invoke-menu")).toContainText("压缩上下文", { timeout: 5000 });

    // 3. 点击「压缩上下文」（菜单项按文本定位点击，避免 Enter 命中第一项）
    await page.getByTestId("quick-invoke-menu").getByText("压缩上下文").click();

    // 4. 验证 chip 出现在输入框（chip-command，data-token 含 /[compact]）
    await expect(page.locator('[data-testid="composer-input"] [data-token="/[compact]"]').first()).toBeVisible({ timeout: 3000 });

    // 5. 输入附加自定义指令
    await page.keyboard.type(" 只保留关键决策", { delay: 5 });

    // 6. 发送
    await page.getByTestId("composer-send").click();

    // 7. 发送后输入框清空
    await expect(textbox).toBeEmpty({ timeout: 3000 });

    // 8. 验证发送的消息中 chip 展开为 /compact 纯文本（无方括号）
    await expect(page.getByText("/compact 只保留关键决策").first()).toBeVisible({ timeout: 8000 });
  });
```

> 若执行环境无真实 pi 进程（/compact 无法完成压缩），用例断言 8 可能超时。可先本地验证 pi 可用性；若不可用，将断言 8 改为 `await expect(page.getByText("/compact 只保留关键决策").first()).toBeVisible({ timeout: 15000 })` 并注明环境依赖。

- [ ] **步骤 2：运行 E2E**

运行：`cd packages/frontend && WA_PI_E2E_WS_PORT=9777 bun run e2e quick-invoke`（如首次挂起，按项目记忆：杀掉残留 kernel 重跑）
预期：PASS（含既有 quick-invoke 用例）

- [ ] **步骤 3：Commit**

```bash
git add packages/frontend/e2e/quick-invoke.spec.ts
git commit -m "test(e2e): 压缩上下文命令选中插入 chip 并展开发送"
```

---

### 任务 5：变更日志 + 全量验证

**文件：**

- 修改：`CHANGELOG.md`（根目录）

- [ ] **步骤 1：追加 CHANGELOG 条目**

在 `CHANGELOG.md` 顶部（时间倒序）新增：

```markdown
## [Unreleased]

### 新增功能
- 内置 `/` 命令新增「压缩上下文」（cmd:compact）：选中插入可编辑 `/[compact]` chip，支持自定义压缩指令，发送时展开为 `/compact 指令` 由 pi 原生执行（前端 `ComposerInput.tsx`、`store/session.ts`）
- 压缩回合结束（agent_end）后自动重拉会话历史，刷新右上角 token 胶囊（累计/本轮）
```

（若项目 CHANGELOG 已有 [Unreleased] 章节，合并到对应小节，保持简洁一条记录。）

- [ ] **步骤 2：全量验证**

运行：`cd /path/to/HiAgent && bun run test`
预期：kernel / shared / desktop / frontend 全部 PASS

- [ ] **步骤 3：Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG 记录压缩上下文命令与 token 刷新"
```
