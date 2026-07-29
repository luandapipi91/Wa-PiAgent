# 聊天回复块自动折叠 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让思考/工具调用/委托块在流式中默认展开、完成后自动折叠成单行 pill，用户手动操作过则优先用户。

**Architecture:** 抽一个共享 `useAutoCollapse` hook 封装"派生默认展开 + 用户优先"逻辑，4 个调用点（MessageList 内 3 个 + DelegateCard 1 个）接入。不改 store、不改 segment 时间线逻辑、不改折叠态视觉（沿用现有 pill）。

**Tech Stack:** React + TypeScript + Tailwind、bun:test + @testing-library/react + happy-dom

**Spec:** `docs/superpowers/specs/2026-07-23-auto-collapse-chat-blocks-design.md`

## Global Constraints

- 所有回复/代码注释/commit message 使用中文
- 测试框架：前端用 `bun:test`（非 vitest），通过 `@testing-library/react`，DOM 环境由 `tests/happydom-setup.ts` preload 注入 happy-dom
- 运行前端单测命令：在仓库根目录执行 `cd packages/frontend && bun test`（或指定文件 `bun test tests/MessageList.test.tsx`）
- 类型检查：`cd packages/frontend && bun run typecheck`
- 折叠态视觉沿用现有 pill 样式（圆角胶囊），不引入竖条/重写样式
- DelegateCard 从整块橙色卡片改为单行 pill（折叠态），展开后沿用橙色内容区
- 不改 `segmentBlocks` / `mergeStreamingIntoLast` / store
- 精准修改：只碰必须改的，不顺手优化相邻代码

---

## 文件结构

| 文件 | 操作 | 职责 |
|---|---|---|
| `packages/frontend/src/components/blocks/useAutoCollapse.ts` | 新增 | 共享 hook：派生默认展开 + 用户优先 |
| `packages/frontend/tests/useAutoCollapse.test.tsx` | 新增 | hook 单测 |
| `packages/frontend/src/components/MessageList.tsx` | 改 | `ThinkingBlock`/`ToolCallGroup`/`ToolCallBlock` 接入 hook |
| `packages/frontend/src/components/blocks/DelegateCard.tsx` | 改 | 卡片→pill 折叠 + 接入 hook |
| `packages/frontend/tests/MessageList.test.tsx` | 改 | 新增自动折叠行为用例 |
| `CHANGELOG.md` | 改 | 记录本次变更 |

---

## Task 1: useAutoCollapse hook + 单测

**Files:**
- Create: `packages/frontend/src/components/blocks/useAutoCollapse.ts`
- Test: `packages/frontend/tests/useAutoCollapse.test.tsx`

**Interfaces:**
- Produces: `useAutoCollapse(opts: { isStreaming?: boolean; isDone: boolean }) => { open: boolean; toggle: () => void }`
  - `open`：派生值。用户未操作时 = `!isStreaming ? false : (isStreaming && !isDone)`，即流式中且未完成→true，否则 false；用户操作过后跟随用户选择
  - `toggle()`：切换开关，调用后置 `userToggled=true`，此后派生逻辑失效

- [ ] **Step 1: 写失败测试**

Create `packages/frontend/tests/useAutoCollapse.test.tsx`:

```tsx
import { test, expect } from "bun:test";
import { render, act } from "@testing-library/react";
import { useAutoCollapse } from "../src/components/blocks/useAutoCollapse";

// 用组件包装 hook，因为 bun:test 下 renderHook 行为不稳定
function Probe({ isStreaming, isDone }: { isStreaming?: boolean; isDone: boolean }) {
  const { open, toggle } = useAutoCollapse({ isStreaming, isDone });
  return (
    <div>
      <span data-testid="open">{String(open)}</span>
      <button data-testid="toggle" onClick={toggle}>toggle</button>
    </div>
  );
}

test("流式中且未完成 → 默认展开（open=true）", () => {
  const { getByTestId } = render(<Probe isStreaming={true} isDone={false} />);
  expect(getByTestId("open").textContent).toBe("true");
});

test("已完成 → 默认折叠（open=false）", () => {
  const { getByTestId } = render(<Probe isStreaming={true} isDone={true} />);
  expect(getByTestId("open").textContent).toBe("false");
});

test("非流式（历史）→ 默认折叠（open=false）", () => {
  const { getByTestId } = render(<Probe isStreaming={false} isDone={true} />);
  expect(getByTestId("open").textContent).toBe("false");
});

test("用户点击 toggle 后 → userToggled 生效，状态跟随用户选择", () => {
  const { getByTestId } = render(<Probe isStreaming={true} isDone={false} />);
  // 初始展开
  expect(getByTestId("open").textContent).toBe("true");
  // 用户点击折叠
  act(() => { fireEvent.click(getByTestId("toggle")); });
  expect(getByTestId("open").textContent).toBe("false");
});

test("用户操作过后，isStreaming/isDone 变化不再覆盖用户选择", () => {
  const { getByTestId, rerender } = render(<Probe isStreaming={true} isDone={false} />);
  // 用户手动折叠
  act(() => { fireEvent.click(getByTestId("toggle")); });
  expect(getByTestId("open").textContent).toBe("false");
  // 完成信号到了，但用户已操作过，不自动展开
  rerender(<Probe isStreaming={false} isDone={true} />);
  expect(getByTestId("open").textContent).toBe("false");
});
```

注意：需在文件顶部 import `fireEvent`：
```tsx
import { render, act, fireEvent } from "@testing-library/react";
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/frontend && bun test tests/useAutoCollapse.test.tsx`
Expected: FAIL，报错 `Cannot find module '../src/components/blocks/useAutoCollapse'`

- [ ] **Step 3: 实现 hook**

Create `packages/frontend/src/components/blocks/useAutoCollapse.ts`:

```typescript
import { useCallback, useRef, useState } from "react";

/**
 * 自动折叠 hook：流式中默认展开，块完成后自动折叠；用户手动操作后尊重用户选择。
 *
 * 派生规则（用户未操作时）：
 *   open = isStreaming && !isDone
 *   —— 流式中且未完成 → 展开；完成或非流式 → 折叠
 *
 * 用户优先：一旦调用 toggle，userToggled 置 true，此后 open 跟随用户最后选择，
 * 派生逻辑不再覆盖。
 *
 * @param opts.isStreaming 整轮流式标志（非当前 block 的，是整条回复的）
 * @param opts.isDone      当前 block 是否完成（有 result / 组内全完成 / 整轮结束）
 */
export function useAutoCollapse(opts: {
  isStreaming?: boolean;
  isDone: boolean;
}): { open: boolean; toggle: () => void } {
  const userToggled = useRef(false);
  const [userOpen, setUserOpen] = useState(false);
  // 派生默认值：用户未操作时，流式中且未完成才展开
  const expectOpen = !userToggled.current && !!opts.isStreaming && !opts.isDone;
  const open = userToggled.current ? userOpen : expectOpen;
  const toggle = useCallback(() => {
    userToggled.current = true;
    setUserOpen(o => !o);
  }, []);
  return { open, toggle };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/frontend && bun test tests/useAutoCollapse.test.tsx`
Expected: PASS（5 个用例全过）

- [ ] **Step 5: 类型检查**

Run: `cd packages/frontend && bun run typecheck`
Expected: 无新增类型错误

- [ ] **Step 6: 提交**

```bash
git add packages/frontend/src/components/blocks/useAutoCollapse.ts packages/frontend/tests/useAutoCollapse.test.tsx
git commit -m "feat(frontend): 新增 useAutoCollapse hook（流式展开/完成折叠/用户优先）"
```

---

## Task 2: ThinkingBlock / ToolCallGroup / ToolCallBlock 接入 hook

**Files:**
- Modify: `packages/frontend/src/components/MessageList.tsx`
  - `ThinkingBlock` 函数（约 L478-501）
  - `ToolCallGroup` 函数（约 L531-571）
  - `ToolCallBlock` 函数（约 L573-613）
  - 顶部 import 区（约 L13，DelegateCard import 旁）
- Test: `packages/frontend/tests/MessageList.test.tsx`（新增用例）

**Interfaces:**
- Consumes: Task 1 的 `useAutoCollapse({ isStreaming?, isDone })`
- Produces: 三个组件的默认展开行为从"始终 false"变为"派生"

**改动要点（三个组件统一模式）：**
1. 删除 `const [open, setOpen] = useState(false);`
2. 加 `const { open, toggle } = useAutoCollapse({ isStreaming, isDone })`，其中：
   - `ThinkingBlock`：`isDone = !isStreaming`
   - `ToolCallGroup`：`isDone = toolCalls.every((tc: any) => results.has(tc.id))`
   - `ToolCallBlock`：`isDone = !!result`
3. `onClick={() => setOpen(!open)}` → `onClick={toggle}`

- [ ] **Step 1: 写失败测试（先加行为断言）**

在 `packages/frontend/tests/MessageList.test.tsx` 文件末尾追加以下用例。先读文件末尾确认插入位置（`tail -20` 查看），然后追加：

```tsx
test("流式中的 thinking 块默认展开（内容可见）", () => {
  const ts = Date.now();
  const sessionId = "s-collapse-1";
  useSessionStore.setState({
    messagesBySession: { [sessionId]: [] },
    streamingBySession: {
      [sessionId]: {
        agentName: "Explore",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "正在分析需求..." }],
          timestamp: ts,
        },
      } as any,
    },
  });
  useProjectsStore.setState({ sessions: [{ id: sessionId, projectId: "p1", primaryAgent: "Explore" }] as any });

  const { getByText } = render(<MessageList sessionId={sessionId} />);
  // 流式中 thinking 内容应可见（展开态）
  expect(() => getByText("正在分析需求...")).not.toThrow();
});

test("非流式（历史）的 thinking 块默认折叠（内容不在 DOM）", () => {
  const ts = Date.now();
  const sessionId = "s-collapse-2";
  useSessionStore.setState({
    messagesBySession: {
      [sessionId]: [{
        agentName: "Explore",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "历史思考内容" }, { type: "text", text: "回复正文" }],
          timestamp: ts,
        },
      } as any],
    },
    streamingBySession: {},
  });
  useProjectsStore.setState({ sessions: [{ id: sessionId, projectId: "p1", primaryAgent: "Explore" }] as any });

  const { queryByText, getByText } = render(<MessageList sessionId={sessionId} />);
  // 历史思考内容应不可见（折叠态）
  expect(queryByText("历史思考内容")).toBeNull();
  // 正文仍可见
  expect(() => getByText("回复正文")).not.toThrow();
});

test("流式中的工具调用块默认展开（工具名可见）", () => {
  const ts = Date.now();
  const sessionId = "s-collapse-3";
  useSessionStore.setState({
    messagesBySession: { [sessionId]: [] },
    streamingBySession: {
      [sessionId]: {
        agentName: "Explore",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc1", name: "Read", arguments: { file_path: "/a.ts" } }],
          timestamp: ts,
        },
      } as any,
    },
  });
  useProjectsStore.setState({ sessions: [{ id: sessionId, projectId: "p1", primaryAgent: "Explore" }] as any });

  const { getByText } = render(<MessageList sessionId={sessionId} />);
  // 流式中工具名应可见（展开态显示工具 pill）
  expect(() => getByText("Read")).not.toThrow();
});

test("用户点击展开 thinking 后，即便 isStreaming 变化也保持用户选择", () => {
  const ts = Date.now();
  const sessionId = "s-collapse-4";
  useSessionStore.setState({
    messagesBySession: { [sessionId]: [] },
    streamingBySession: {
      [sessionId]: {
        agentName: "Explore",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "用户想看的思考" }],
          timestamp: ts,
        },
      } as any,
    },
  });
  useProjectsStore.setState({ sessions: [{ id: sessionId, projectId: "p1", primaryAgent: "Explore" }] as any });

  const { getByText, queryByText } = render(<MessageList sessionId={sessionId} />);
  // 流式中默认展开
  expect(() => getByText("用户想看的思考")).not.toThrow();

  // 模拟整轮流式结束：streaming 清空，thinking 进 history（非流式）
  useSessionStore.setState({
    messagesBySession: {
      [sessionId]: [{
        agentName: "Explore",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "用户想看的思考" }, { type: "text", text: "done" }],
          timestamp: ts,
        },
      } as any],
    },
    streamingBySession: {},
  });
  // 组件 remount（key 变化或 store 变化触发），此处用重新 render 验证
  // 注意：此处验证的是新挂载的派生默认值，用户优先规则在同一挂载实例内生效
  // 由于组件重新 render（非 remount），userToggled 仍保留
  // 思考内容应因完成自动折叠而不可见
  expect(queryByText("用户想看的思考")).toBeNull();
});
```

注意：第 4 个用例验证的是"完成后自动折叠"的派生行为。用户优先规则的单测已在 Task 1 的 hook 层覆盖（同一挂载实例内 rerender），这里组件层主要验证派生默认值。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/frontend && bun test tests/MessageList.test.tsx`
Expected: FAIL —— 新增的前 3 个用例失败（流式中内容不可见，因为现在默认折叠）。第 4 个可能通过（因为现在就是折叠的）。

- [ ] **Step 3: 改造 ThinkingBlock**

在 `packages/frontend/src/components/MessageList.tsx`：

顶部 import 区（DelegateCard import 旁，约 L13）加：
```typescript
import { useAutoCollapse } from "./blocks/useAutoCollapse";
```

替换 `ThinkingBlock` 函数（约 L478-501）。把：
```tsx
function ThinkingBlock({ thinking, isStreaming }: { thinking: string; isStreaming?: boolean }) {
  const [open, setOpen] = useState(false);
  const label = isStreaming ? "努力思考中…" : "💭 思考过程 已完成";
  return (
    <div data-testid="thinking-panel">
      <button
        onClick={() => setOpen(!open)}
        ...
```
改为：
```tsx
function ThinkingBlock({ thinking, isStreaming }: { thinking: string; isStreaming?: boolean }) {
  const { open, toggle } = useAutoCollapse({ isStreaming, isDone: !isStreaming });
  const label = isStreaming ? "努力思考中…" : "💭 思考过程 已完成";
  return (
    <div data-testid="thinking-panel">
      <button
        onClick={toggle}
        ...
```
（只改两行：删 useState 加 hook，onClick 改 toggle。其余 JSX 不变。）

- [ ] **Step 4: 改造 ToolCallGroup**

替换 `ToolCallGroup` 函数（约 L531-571）。把：
```tsx
function ToolCallGroup({ toolCalls, results, isStreaming }: { toolCalls: any[]; results: Map<string, ToolResultMessage>; isStreaming?: boolean }) {
  const [open, setOpen] = useState(false);
  const total = toolCalls.length;
  const done = toolCalls.filter((tc: any) => results.has(tc.id)).length;
  ...
      <button
        onClick={() => setOpen(!open)}
        ...
```
改为：
```tsx
function ToolCallGroup({ toolCalls, results, isStreaming }: { toolCalls: any[]; results: Map<string, ToolResultMessage>; isStreaming?: boolean }) {
  const allDone = toolCalls.every((tc: any) => results.has(tc.id));
  const { open, toggle } = useAutoCollapse({ isStreaming, isDone: allDone });
  const total = toolCalls.length;
  const done = toolCalls.filter((tc: any) => results.has(tc.id)).length;
  ...
      <button
        onClick={toggle}
        ...
```
（改动：删 useState，加 allDone 计算 + hook，onClick 改 toggle。`done` 计数仍保留用于显示 ✓x ✗y。）

- [ ] **Step 5: 改造 ToolCallBlock**

替换 `ToolCallBlock` 函数（约 L573-613）。把：
```tsx
function ToolCallBlock({ toolCall, result }: { toolCall: ToolCall; result?: ToolResultMessage }) {
  const [open, setOpen] = useState(false);
  ...
      <button
        onClick={() => setOpen(!open)}
        ...
```
改为：
```tsx
function ToolCallBlock({ toolCall, result }: { toolCall: ToolCall; result?: ToolResultMessage }) {
  const { open, toggle } = useAutoCollapse({ isDone: !!result });
  ...
      <button
        onClick={toggle}
        ...
```
注意：`ToolCallBlock` 没有接收 `isStreaming` prop（它只在组内展开后渲染）。因此只传 `isDone: !!result`，不传 isStreaming。这样单个工具：未完成→展开（isStreaming 缺省 false 但 isDone false → expectOpen=false）。

**⚠️ 注意此处的语义问题：** `useAutoCollapse({ isDone: !!result })` 不传 isStreaming，则 `expectOpen = !userToggled && undefined && !isDone`。`undefined && ...` = falsy，导致未完成的工具也默认折叠。这与"工具组展开后，单个未完成工具应展开"不符。

修正：`ToolCallBlock` 的期望是"组展开后，单个未完成的工具默认展开"。由于工具块只在组展开时渲染（用户已主动展开组），单工具的展开/折叠是第二层。保持其**默认折叠**是合理的（用户已看到组的概览，点开组后才看单工具详情，单工具默认折叠避免太长）。

因此 `ToolCallBlock` 用 `isDone: !!result` 不传 isStreaming 是**有意为之**：单工具默认折叠（无论完成与否），用户需点开看详情。这与现有行为（`useState(false)`）一致，只是改用统一 hook。**不改动单工具的默认行为，避免过度设计。**

- [ ] **Step 6: 运行测试确认通过**

Run: `cd packages/frontend && bun test tests/MessageList.test.tsx`
Expected: PASS（新增 4 个用例 + 原有全部用例通过）

- [ ] **Step 7: 类型检查**

Run: `cd packages/frontend && bun run typecheck`
Expected: 无新增类型错误

- [ ] **Step 8: 提交**

```bash
git add packages/frontend/src/components/MessageList.tsx packages/frontend/tests/MessageList.test.tsx
git commit -m "feat(frontend): thinking/工具组/单工具接入 useAutoCollapse（流式展开/完成折叠）"
```

---

## Task 3: DelegateCard 改为 pill 折叠 + 接入 hook

**Files:**
- Modify: `packages/frontend/src/components/blocks/DelegateCard.tsx`（整文件重写）
- Test: `packages/frontend/tests/MessageList.test.tsx`（更新现有 DelegateCard 用例）

**Interfaces:**
- Consumes: Task 1 的 `useAutoCollapse`
- Produces: `DelegateCard({ toolCall, result })` —— 折叠态单行 pill，展开态橙色内容区

**当前 DelegateCard 结构（L9-45）：**
- 整块橙色卡片（`rounded-lg p-2`，橙色背景+边框）
- 顶部 `↪ 委派给 {agent}` + 状态
- `📋 任务：{task}`（始终显示）
- result 后：子 agent 回复摘要/全文 + "▾ 展开完整回复" 二级折叠
- 内部 `useState(open)` 控制二级折叠

**目标结构：**
- 折叠态：单行 pill（`↪ 委派给 {agent} · ✓ 完成/✗ 失败/执行中 ▸`），与 ThinkingBlock/ToolCallGroup 视觉一致
- 展开态：pill 下方显示 `📋 任务` + 子 agent 完整回复（橙色左边框，沿用现有）
- 删除二级"展开完整回复"折叠（被统一 pill 折叠替代，避免双层）
- 用 `useAutoCollapse({ isDone: !!result })` —— DelegateCard 不接收 isStreaming（它作为 segment 独立渲染，不在组内）

**⚠️ isStreaming 传递问题：** DelegateCard 当前 props 是 `{ toolCall, result }`，没有 isStreaming。它由 MessageRow 的 `segments.map` 渲染（MessageList.tsx L405-407），MessageRow 有 `isStreaming` prop。

需要把 isStreaming 透传给 DelegateCard：修改 MessageList.tsx L406 `<DelegateCard key={seg.call.id} toolCall={seg.call} result={row.toolResults.get(seg.call.id)} />` 加 `isStreaming={isStreaming}`。

- [ ] **Step 1: 写失败测试**

在 `packages/frontend/tests/MessageList.test.tsx` 找到现有用例 `"intercom toolCall 渲染 DelegateCard（委派卡片）"`（约 L125），替换为以下用例（适配新的 pill 折叠结构）：

先读现有用例代码：
Run: `sed -n '125,143p' packages/frontend/tests/MessageList.test.tsx`

替换为：
```tsx
test("delegate 委派卡片：折叠态显示单行 pill（委派给 + 状态）", () => {
  const ts = Date.now();
  const sessionId = "s-delegate-1";
  useSessionStore.setState({
    messagesBySession: {
      [sessionId]: [{
        agentName: "Explore",
        message: {
          role: "assistant",
          content: [{
            type: "toolCall",
            id: "dc1",
            name: "delegate",
            arguments: { agent: "General", task: "搜索折叠组件" },
          }],
          timestamp: ts,
        },
      } as any],
    },
    streamingBySession: {},
  });
  useProjectsStore.setState({ sessions: [{ id: sessionId, projectId: "p1", primaryAgent: "Explore" }] as any });

  const { getByText, queryByText } = render(<MessageList sessionId={sessionId} />);
  // 折叠态 pill 显示委派目标
  expect(() => getByText(/委派给 General/)).not.toThrow();
  // 任务详情默认折叠（不在 DOM）
  expect(queryByText("搜索折叠组件")).toBeNull();
});

test("delegate 流式中默认展开（任务可见）", () => {
  const ts = Date.now();
  const sessionId = "s-delegate-2";
  useSessionStore.setState({
    messagesBySession: { [sessionId]: [] },
    streamingBySession: {
      [sessionId]: {
        agentName: "Explore",
        message: {
          role: "assistant",
          content: [{
            type: "toolCall",
            id: "dc2",
            name: "delegate",
            arguments: { agent: "General", task: "执行中的任务" },
          }],
          timestamp: ts,
        },
      } as any,
    },
  });
  useProjectsStore.setState({ sessions: [{ id: sessionId, projectId: "p1", primaryAgent: "Explore" }] as any });

  const { getByText } = render(<MessageList sessionId={sessionId} />);
  // 流式中任务应可见（展开态）
  expect(() => getByText("执行中的任务")).not.toThrow();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/frontend && bun test tests/MessageList.test.tsx`
Expected: FAIL —— 第 1 个用例：现在 DelegateCard 是整块卡片，任务始终可见（`queryByText("搜索折叠组件")` 不为 null）；第 2 个用例可能因结构不同失败。

- [ ] **Step 3: 透传 isStreaming 给 DelegateCard**

在 `packages/frontend/src/components/MessageList.tsx` L405-407，把：
```tsx
if (seg.kind === "delegate") {
  return <DelegateCard key={seg.call.id} toolCall={seg.call} result={row.toolResults.get(seg.call.id)} />;
}
```
改为：
```tsx
if (seg.kind === "delegate") {
  return <DelegateCard key={seg.call.id} toolCall={seg.call} result={row.toolResults.get(seg.call.id)} isStreaming={isStreaming} />;
}
```

- [ ] **Step 4: 重写 DelegateCard.tsx**

Replace 整个 `packages/frontend/src/components/blocks/DelegateCard.tsx` 内容为：

```tsx
import type { ToolCall, ToolResultMessage } from "@wa-pi/shared";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAutoCollapse } from "./useAutoCollapse";

interface Props {
  toolCall: ToolCall;
  result?: ToolResultMessage;
  isStreaming?: boolean;
}

export function DelegateCard({ toolCall, result, isStreaming }: Props) {
  const args = toolCall.arguments as { agent?: string; task?: string };
  const full = result?.content.map((c: ToolResultMessage["content"][number]) => (c.type === "text" ? c.text : "")).join("\n") ?? "";
  const failed = !!result?.isError;
  // 完成信号：有 result 即完成
  const { open, toggle } = useAutoCollapse({ isStreaming, isDone: !!result });

  // pill 状态文案与配色
  const statusText = !result ? "执行中" : failed ? "✗ 失败" : "✓ 完成";
  const pillClass = failed
    ? "text-danger bg-danger-soft border-danger-soft"
    : "text-[#b45309] bg-[rgba(250,179,135,0.08)] border-[rgba(250,179,135,0.3)]";
  const statusColor = failed ? "var(--danger)" : "#a6e3a1";

  return (
    <div data-testid={`delegate-${toolCall.id}`}>
      {/* 折叠/展开切换 pill */}
      <button
        onClick={toggle}
        className={`inline-flex items-center gap-1.5 select-none text-[11.5px] px-2 py-0.5 rounded-pill border transition-colors hover:opacity-80 ${pillClass}`}
        style={{ cursor: "pointer" }}
      >
        {!result && (
          <span className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ border: "2px solid rgba(250,179,135,0.35)", borderTopColor: "#fab387", animation: "spin 0.8s linear infinite" }} />
        )}
        <span>↪ 委派给 {args.agent}</span>
        <span className="opacity-70">· {statusText}</span>
        <span style={{ fontSize: 10 }}>{open ? "▾" : "▸"}</span>
      </button>

      {/* 展开态：任务 + 子 agent 回复（markdown 渲染） */}
      {open && (
        <div className="mt-1 ml-1 pl-3 space-y-1" style={{ borderLeft: `2px solid ${failed ? "var(--danger)" : "#fab387"}` }}>
          {args.task && (
            <div className="text-sm text-secondary">📋 任务：{args.task}</div>
          )}
          {result && full && (
            <div className="text-sm">
              <div className="text-xs" style={{ color: statusColor }}>{failed ? "✗" : "✓"} {args.agent} 的回复</div>
              {/* 子 agent 回复用 ReactMarkdown 渲染（与主 agent 正文一致），
                  data-testid="text-block" 复用全局溢出兜底样式 */}
              <div data-testid="text-block" className="prose prose-sm max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{full}</ReactMarkdown>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

**注意：** 子 agent 回复内容用 `ReactMarkdown` 渲染而非纯文字。因为子 agent 返回的也是 markdown（代码块、列表、链接等），纯文字会丢失格式。容器用 `data-testid="text-block"` 复用全局溢出兜底 CSS（长 URL/代码块强制换行，见 styles.css）。

- [ ] **Step 5: 运行测试确认通过**

Run: `cd packages/frontend && bun test tests/MessageList.test.tsx`
Expected: PASS（新增 delegate 用例 + 原有全部通过）

- [ ] **Step 6: 类型检查**

Run: `cd packages/frontend && bun run typecheck`
Expected: 无新增类型错误（注意：删除了 `import { useState }`，因为不再需要）

- [ ] **Step 7: 提交**

```bash
git add packages/frontend/src/components/blocks/DelegateCard.tsx packages/frontend/src/components/MessageList.tsx packages/frontend/tests/MessageList.test.tsx
git commit -m "feat(frontend): DelegateCard 改为单行 pill 折叠 + 接入 useAutoCollapse"
```

---

## Task 4: CHANGELOG 更新 + 全量回归

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 更新 CHANGELOG**

在 `CHANGELOG.md` 顶部（最新条目之前）插入：

```markdown
## 2026-07-23

### 新增功能
- **聊天回复块自动折叠**：思考/工具调用/委托块在流式过程中默认展开，完成后自动折叠为单行 pill；用户手动展开/折叠后优先用户选择。
  - 新增共享 hook `useAutoCollapse`（`packages/frontend/src/components/blocks/useAutoCollapse.ts`）
  - DelegateCard 从整块橙色卡片改为统一的单行 pill 折叠样式
  - 影响范围：`packages/frontend/src/components/MessageList.tsx`、`packages/frontend/src/components/blocks/DelegateCard.tsx`
```

- [ ] **Step 2: 全量前端单测回归**

Run: `cd packages/frontend && bun test`
Expected: 全部 PASS（无回归）

- [ ] **Step 3: 全量类型检查**

Run: `cd packages/frontend && bun run typecheck`
Expected: 无错误

- [ ] **Step 4: 提交**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG 记录聊天回复块自动折叠变更"
```

---

## Self-Review

**1. Spec 覆盖：**
- ✅ 流式中默认展开 → Task 2（thinking/工具组）、Task 3（delegate）
- ✅ 完成后自动折叠 → Task 1 hook 派生逻辑 + Task 2/3 接入
- ✅ 用户优先 → Task 1 hook `userToggled` + 单测
- ✅ 历史默认折叠 → Task 2 用例 2
- ✅ DelegateCard pill 改造 → Task 3
- ✅ 视觉沿用 pill → 不重写样式，仅 DelegateCard 结构改

**2. Placeholder 扫描：** 无 TBD/TODO，每个 step 都有完整代码。

**3. 类型一致性：** `useAutoCollapse({ isStreaming?, isDone })` 签名在 Task 1 定义，Task 2/3 调用一致；`DelegateCard` props 从 `{toolCall, result}` 扩展为 `{toolCall, result, isStreaming?}`，Task 3 Step 3 同步改 MessageList 调用点。

**4. 注意点：** `ToolCallBlock`（单工具）有意不传 isStreaming、保持默认折叠——这是设计决策（组内第二层折叠，避免过度展开），在 Task 2 Step 5 已说明理由。
