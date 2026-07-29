# CoCode 显示模式对齐（§3/§5/§6）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 WaPi 聊天消息流的过程块（思考/工具调用/委托）换成 cocode 式 Card 基座 + 流式展开/完成折叠/回合结束弱化的行为，并给代码块加卡片体系（头部条+复制+高亮+折叠）、文件路径加 FilePill 胶囊与只读预览。

**Architecture:** 行为层复用 2026-07-23 spec 的 `useAutoCollapse` hook（派生默认值 + 用户优先）；视觉层新增 `ProcessCard` 基座（图标方块 + tone 语义色 + 标题 + 右侧 meta + chevron），`ThinkingCard`/`ToolCallCard`/`ToolGroupCard`/`DelegateCard` 全部落在其上；Markdown 层通过 ReactMarkdown `components` 映射把 `pre` 换成 `CodeBlockCard`（prism-react-renderer 高亮）、把形似路径的内联 code 换成 `FilePill`（点击弹只读预览，复用 `fs-client.readFile`）。`segmentBlocks` 分段管线不动。

**Tech Stack:** React 19 + Tailwind 3（CSS 变量 token）+ zustand 5 + react-markdown 10 + remark-gfm 4 + prism-react-renderer（新增）; 测试 bun:test + @testing-library/react + happy-dom; E2E Playwright。

## Global Constraints

- 只改 `packages/frontend`；kernel 协议与行为零改动；`cocode-master` 只读参考，不修改。
- 唯一新增依赖：`prism-react-renderer`（`cd packages/frontend && bun add prism-react-renderer`）。
- 行为规则遵循 `docs/superpowers/specs/2026-07-23-auto-collapse-chat-blocks-design.md`：流式中默认展开、完成即折叠、用户手动操作后不被自动逻辑覆盖、历史消息默认折叠；本计划把视觉从 pill 升级为 cocode Card 基座（覆盖该 spec 的 pill 视觉部分）。
- 回合结束弱化 = 过程卡片 `muted`（`opacity-55` + 紧凑），正文气泡不弱化。
- 保留既有 `data-testid`（`thinking-panel`、`toolcall-group`、`toolcall-<id>`、`delegate-<id>`、`text-block`、`text-bubble`），既有测试尽量不断。
- 中文注释、提交信息遵循仓库惯例；完成后更新 `CHANGELOG.md`。
- thinking 的「完成」信号 = 整轮流式结束（无更细信号，沿用 spec 判定）。
- 每完成一个 Task 跑 `cd packages/frontend && bun test` 保持全绿，并按步骤提交。

---

### Task 1: useAutoCollapse hook（行为基座）

**Files:**
- Create: `packages/frontend/src/components/blocks/useAutoCollapse.ts`
- Test: `packages/frontend/tests/useAutoCollapse.test.tsx`

**Interfaces:**
- Produces: `useAutoCollapse(opts: { isStreaming?: boolean; isDone: boolean }): { open: boolean; toggle: () => void }` —— Task 3 的全部过程卡片依赖。

- [ ] **Step 1: 写失败测试**

`packages/frontend/tests/useAutoCollapse.test.tsx`：

```tsx
import { test, expect } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { useAutoCollapse } from "../src/components/blocks/useAutoCollapse";

test("流式中未完成 → 默认展开", () => {
  const { result } = renderHook((p) => useAutoCollapse(p), { initialProps: { isStreaming: true, isDone: false } });
  expect(result.current.open).toBe(true);
});

test("完成后 → 自动折叠", () => {
  const { result, rerender } = renderHook((p) => useAutoCollapse(p), { initialProps: { isStreaming: true, isDone: false } });
  rerender({ isStreaming: true, isDone: true });
  expect(result.current.open).toBe(false);
});

test("历史（非流式）→ 默认折叠", () => {
  const { result } = renderHook((p) => useAutoCollapse(p), { initialProps: { isStreaming: false, isDone: true } });
  expect(result.current.open).toBe(false);
});

test("流式展开中 toggle 一次即折叠（回归：不得要点两次）", () => {
  const { result } = renderHook((p) => useAutoCollapse(p), { initialProps: { isStreaming: true, isDone: false } });
  expect(result.current.open).toBe(true);
  act(() => result.current.toggle());
  expect(result.current.open).toBe(false);
});

test("用户 toggle 后，自动逻辑不再覆盖", () => {
  const { result, rerender } = renderHook((p) => useAutoCollapse(p), { initialProps: { isStreaming: false, isDone: true } });
  act(() => result.current.toggle()); // 用户手动展开
  expect(result.current.open).toBe(true);
  rerender({ isStreaming: true, isDone: false }); // 自动逻辑想让它展开/折叠都不再生效
  rerender({ isStreaming: false, isDone: true });
  expect(result.current.open).toBe(true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/frontend && bun test tests/useAutoCollapse.test.tsx`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 hook**

`packages/frontend/src/components/blocks/useAutoCollapse.ts`：

```typescript
import { useCallback, useRef, useState } from "react";

/**
 * 自动折叠 hook：流式中默认展开，块完成后自动折叠；用户手动操作后尊重用户选择。
 * - isStreaming: 整轮流式标志
 * - isDone: 该 block 是否完成
 */
export function useAutoCollapse(opts: {
  isStreaming?: boolean;
  isDone: boolean;
}): { open: boolean; toggle: () => void } {
  const userToggled = useRef(false);
  const [userOpen, setUserOpen] = useState(false);
  const expectOpen = !userToggled.current && !!opts.isStreaming && !opts.isDone;
  const open = userToggled.current ? userOpen : expectOpen;
  // 必须基于当前显示的 open 取反：userOpen 初始为 false，
  // 若用 setUserOpen(o => !o)，流式展开时第一次点击会把 userOpen 置 true（仍展开），要点两次才折叠
  const toggle = useCallback(() => {
    userToggled.current = true;
    setUserOpen(!open);
  }, [open]);
  return { open, toggle };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/frontend && bun test tests/useAutoCollapse.test.tsx`
Expected: 5 pass

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/components/blocks/useAutoCollapse.ts packages/frontend/tests/useAutoCollapse.test.tsx
git commit -m "feat(frontend): useAutoCollapse hook——流式展开/完成折叠/用户优先"
```

---

### Task 2: ProcessCard 基座组件（视觉基座）

**Files:**
- Create: `packages/frontend/src/components/blocks/ProcessCard.tsx`
- Test: `packages/frontend/tests/ProcessCard.test.tsx`

**Interfaces:**
- Produces:
  - `ProcessCard(props: { tone: "accent" | "success" | "warning" | "danger"; icon: ReactNode; title: ReactNode; meta?: ReactNode; open: boolean; onToggle: () => void; muted?: boolean; testId?: string; children?: ReactNode }): JSX.Element`
  - `Spinner(): JSX.Element`（12px 转圈，meta 区用）
- 说明：根节点带 `data-testid={testId}` 与 `data-muted`；头部按钮 testid 为 `${testId}-header`，展开体为 `${testId}-body`。

- [ ] **Step 1: 写失败测试**

`packages/frontend/tests/ProcessCard.test.tsx`：

```tsx
import { test, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProcessCard } from "../src/components/blocks/ProcessCard";

test("折叠时只渲染头部，body 不在 DOM", () => {
  render(<ProcessCard tone="accent" icon="💭" title="思考过程" meta="已完成" open={false} onToggle={() => {}} testId="pc">内容</ProcessCard>);
  expect(screen.getByTestId("pc-header").textContent).toContain("思考过程");
  expect(screen.getByTestId("pc-header").textContent).toContain("已完成");
  expect(screen.queryByTestId("pc-body")).toBeNull();
});

test("open=true 时渲染 body", () => {
  render(<ProcessCard tone="success" icon="✓" title="Read" open={true} onToggle={() => {}} testId="pc">参数详情</ProcessCard>);
  expect(screen.getByTestId("pc-body").textContent).toContain("参数详情");
});

test("点击头部触发 onToggle", () => {
  let called = 0;
  render(<ProcessCard tone="accent" icon="💭" title="t" open={false} onToggle={() => called++} testId="pc">b</ProcessCard>);
  fireEvent.click(screen.getByTestId("pc-header"));
  expect(called).toBe(1);
});

test("muted 时根节点带 data-muted 且透明度弱化", () => {
  render(<ProcessCard tone="accent" icon="💭" title="t" open={false} onToggle={() => {}} muted testId="pc">b</ProcessCard>);
  const root = screen.getByTestId("pc");
  expect(root.getAttribute("data-muted")).toBe("true");
  expect(root.className).toContain("opacity-55");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/frontend && bun test tests/ProcessCard.test.tsx`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 ProcessCard**

`packages/frontend/src/components/blocks/ProcessCard.tsx`：

```tsx
import type { ReactNode } from "react";

export type ProcessTone = "accent" | "success" | "warning" | "danger";

const TONE_STYLE: Record<ProcessTone, { iconBg: string; iconColor: string }> = {
  accent: { iconBg: "var(--accent-soft)", iconColor: "var(--accent)" },
  success: { iconBg: "var(--success-soft)", iconColor: "var(--success)" },
  warning: { iconBg: "var(--warning-soft)", iconColor: "var(--warning)" },
  danger: { iconBg: "var(--danger-soft)", iconColor: "var(--danger)" },
};

/** 12px 加载转圈，用于卡片 meta 区 */
export function Spinner() {
  return (
    <span
      className="inline-block w-3 h-3 rounded-full flex-shrink-0"
      style={{ border: "2px solid var(--accent-soft)", borderTopColor: "var(--accent)", animation: "spin 0.8s linear infinite" }}
    />
  );
}

/**
 * cocode 式过程卡片基座：图标方块（tone 着色）+ 标题 + 右侧 meta（状态/耗时）+ chevron。
 * 展开时 body 以顶部细线与头部隔开；muted（回合结束/历史）时整体弱化。
 */
export function ProcessCard(props: {
  tone: ProcessTone;
  icon: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  open: boolean;
  onToggle: () => void;
  muted?: boolean;
  testId?: string;
  children?: ReactNode;
}) {
  const { tone, icon, title, meta, open, onToggle, muted, testId, children } = props;
  const t = TONE_STYLE[tone];
  return (
    <div
      data-testid={testId}
      data-muted={muted || undefined}
      className={`rounded-lg border border-hairline bg-surface transition-opacity mb-1.5 ${muted ? "opacity-55" : ""}`}
    >
      <button
        type="button"
        onClick={onToggle}
        data-testid={testId ? `${testId}-header` : undefined}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left select-none"
        style={{ cursor: "pointer" }}
      >
        <span
          className="w-5 h-5 rounded flex items-center justify-center text-[11px] flex-shrink-0"
          style={{ background: t.iconBg, color: t.iconColor }}
        >
          {icon}
        </span>
        <span className="text-[12px] text-primary min-w-0 truncate">{title}</span>
        <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-tertiary flex-shrink-0">{meta}</span>
        <span className="text-tertiary" style={{ fontSize: 10 }}>{open ? "▾" : "▸"}</span>
      </button>
      {open && children != null && (
        <div
          className="px-3 py-2 border-t border-hairline text-[12px] text-secondary"
          data-testid={testId ? `${testId}-body` : undefined}
        >
          {children}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/frontend && bun test tests/ProcessCard.test.tsx`
Expected: 4 pass

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/components/blocks/ProcessCard.tsx packages/frontend/tests/ProcessCard.test.tsx
git commit -m "feat(frontend): ProcessCard 基座——cocode 式过程卡片（tone 图标/meta/弱化）"
```

---

### Task 3: 过程块迁移到 ProcessCard（思考/工具/委托 + MessageList 接入）

**Files:**
- Create: `packages/frontend/src/components/blocks/ThinkingCard.tsx`
- Create: `packages/frontend/src/components/blocks/ToolCallCard.tsx`
- Modify: `packages/frontend/src/components/blocks/DelegateCard.tsx`（整体重写）
- Modify: `packages/frontend/src/components/MessageList.tsx`（替换 3 个渲染器、删除旧本地组件、delegate 补传 `isStreaming`）
- Test: `packages/frontend/tests/MessageList.test.tsx`（新增自动折叠/弱化用例，更新失效断言）
- Test: `packages/frontend/tests/DelegateCard.test.tsx`（按新卡片重写）

**Interfaces:**
- Consumes: `useAutoCollapse`（Task 1）、`ProcessCard`/`Spinner`（Task 2）
- Produces:
  - `ThinkingCard({ thinking: string; isStreaming?: boolean })`，根 testid `thinking-panel`
  - `ToolCallCard({ toolCall: ToolCall; result?: ToolResultMessage; isStreaming?: boolean })`，根 testid `toolcall-<id>`
  - `ToolGroupCard({ toolCalls: any[]; results: Map<string, ToolResultMessage>; isStreaming?: boolean })`，组 testid `toolcall-group`；单工具时直接渲染 `ToolCallCard`
  - `formatArgs(args: Record<string, any>): string`（从 MessageList 迁入 `ToolCallCard.tsx` 并导出）
  - `DelegateCard({ toolCall: ToolCall; result?: ToolResultMessage; isStreaming?: boolean })`，根 testid `delegate-<id>`

- [ ] **Step 1: 先加失败测试（MessageList 自动折叠/弱化）**

`packages/frontend/tests/MessageList.test.tsx` 追加（工厂 `assistantMsg` 已存在，直接复用）：

```tsx
test("流式中 thinking 块默认展开", () => {
  useSessionStore.setState({
    messagesBySession: { s1: [] },
    streamingBySession: {
      s1: assistantMsg(10, [{ type: "thinking", thinking: "让我想想" }]),
    },
  });
  render(<MessageList sessionId="s1" />);
  expect(screen.getByTestId("thinking-panel-body").textContent).toContain("让我想想");
});

test("流式中工具调用块默认展开，完成后（历史）折叠且弱化", () => {
  const tc = { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } };
  const tr = { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 11 };
  // 历史：非流式 → 折叠 + muted
  useSessionStore.setState({
    messagesBySession: { s1: [assistantMsg(10, [tc]), { agentName: "product", message: tr }] },
  });
  const { unmount } = render(<MessageList sessionId="s1" />);
  expect(screen.queryByTestId("toolcall-tc1-body")).toBeNull();
  expect(screen.getByTestId("toolcall-tc1").getAttribute("data-muted")).toBe("true");
  unmount();
  // 流式中同一块 → 展开
  useSessionStore.setState({
    messagesBySession: { s1: [] },
    streamingBySession: { s1: assistantMsg(10, [tc]) },
  });
  render(<MessageList sessionId="s1" />);
  expect(screen.getByTestId("toolcall-tc1-body")).toBeTruthy();
});

test("用户点击折叠的卡片后内容展开（尊重手动选择）", () => {
  useSessionStore.setState({
    messagesBySession: { s1: [assistantMsg(10, [{ type: "thinking", thinking: "历史思考" }])] },
  });
  render(<MessageList sessionId="s1" />);
  expect(screen.queryByTestId("thinking-panel-body")).toBeNull();
  fireEvent.click(screen.getByTestId("thinking-panel-header"));
  expect(screen.getByTestId("thinking-panel-body").textContent).toContain("历史思考");
});
```

注：`streamingBySession` 的值与 `messagesBySession` 元素同型（`SessionMessage`），`useSessionStore.setState` 需合并保留 `messagesBySession` 字段；`fireEvent` 已在该文件 import。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/frontend && bun test tests/MessageList.test.tsx`
Expected: 新用例 FAIL（`thinking-panel-body` 等不存在）

- [ ] **Step 3: 实现 ThinkingCard / ToolCallCard（含 ToolGroupCard）**

`packages/frontend/src/components/blocks/ThinkingCard.tsx`：

```tsx
import { ProcessCard, Spinner } from "./ProcessCard";
import { useAutoCollapse } from "./useAutoCollapse";

/** 思考过程卡片：流式中展开实时可见，整轮结束自动折叠并弱化 */
export function ThinkingCard({ thinking, isStreaming }: { thinking: string; isStreaming?: boolean }) {
  const { open, toggle } = useAutoCollapse({ isStreaming, isDone: !isStreaming });
  return (
    <ProcessCard
      tone="accent"
      icon="💭"
      title="思考过程"
      meta={isStreaming ? (<><Spinner /><span>思考中…</span></>) : "已完成"}
      open={open}
      onToggle={toggle}
      muted={!isStreaming}
      testId="thinking-panel"
    >
      <div className="italic text-tertiary whitespace-pre-wrap">{thinking}</div>
    </ProcessCard>
  );
}
```

`packages/frontend/src/components/blocks/ToolCallCard.tsx`：

```tsx
import type { ToolCall, ToolResultMessage } from "@wa-pi/shared";
import { ProcessCard, Spinner } from "./ProcessCard";
import { useAutoCollapse } from "./useAutoCollapse";

/** 格式化工具调用参数 — 截断长值避免撑爆 UI（自 MessageList 迁入） */
export function formatArgs(args: Record<string, any>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return "";
  const parts = keys.map(k => {
    const v = args[k];
    if (typeof v === "string") {
      return v.length > 60 ? `${k}: "${v.slice(0, 50)}..."` : `${k}: "${v}"`;
    }
    const s = JSON.stringify(v);
    return s.length > 80 ? `${k}: ${s.slice(0, 77)}...` : `${k}: ${s}`;
  });
  return parts.join(", ");
}

/** 单个工具调用卡片：完成即折叠；成功绿 / 失败红 / 执行中 accent */
export function ToolCallCard({ toolCall, result, isStreaming }: { toolCall: ToolCall; result?: ToolResultMessage; isStreaming?: boolean }) {
  const { open, toggle } = useAutoCollapse({ isStreaming, isDone: !!result });
  const failed = !!result?.isError;
  const tone = !result ? "accent" : failed ? "danger" : "success";
  const name = toolCall.name === "ask_user_question" ? "问答" : toolCall.name;
  return (
    <ProcessCard
      tone={tone}
      icon={!result ? "🔧" : failed ? "✗" : "✓"}
      title={<span className="font-mono">{name} <span className="text-tertiary">({formatArgs(toolCall.arguments)})</span></span>}
      meta={!result ? <Spinner /> : failed ? "失败" : "完成"}
      open={open}
      onToggle={toggle}
      muted={!isStreaming}
      testId={`toolcall-${toolCall.id}`}
    >
      <div className="font-mono whitespace-pre-wrap">{JSON.stringify(toolCall.arguments, null, 2)}</div>
      {result && (
        <div className={`mt-1 pt-1 border-t border-hairline ${failed ? "text-danger" : "text-success"}`}>
          {result.content.map((c: any, i: number) => c.type === "text" && <div key={i}>{c.text}</div>)}
        </div>
      )}
    </ProcessCard>
  );
}

/** 工具调用分组：>1 个连续调用归成一张组卡；单工具直接渲染单卡 */
export function ToolGroupCard({ toolCalls, results, isStreaming }: { toolCalls: any[]; results: Map<string, ToolResultMessage>; isStreaming?: boolean }) {
  if (toolCalls.length === 1) {
    return <ToolCallCard toolCall={toolCalls[0]} result={results.get(toolCalls[0].id)} isStreaming={isStreaming} />;
  }
  return <ToolGroupCardInner toolCalls={toolCalls} results={results} isStreaming={isStreaming} />;
}

function ToolGroupCardInner({ toolCalls, results, isStreaming }: { toolCalls: any[]; results: Map<string, ToolResultMessage>; isStreaming?: boolean }) {
  const total = toolCalls.length;
  const doneCount = toolCalls.filter((tc: any) => results.has(tc.id)).length;
  const successCount = toolCalls.filter((tc: any) => { const r = results.get(tc.id); return r && !r.isError; }).length;
  const failedCount = toolCalls.filter((tc: any) => { const r = results.get(tc.id); return r && r.isError; }).length;
  const { open, toggle } = useAutoCollapse({ isStreaming, isDone: doneCount === total });

  const status: string[] = [];
  if (successCount > 0) status.push(`✓${successCount}`);
  if (failedCount > 0) status.push(`✗${failedCount}`);
  if (doneCount < total) status.push(`⏳${total - doneCount}`);

  return (
    <ProcessCard
      tone="accent"
      icon="🔧"
      title={`${total} 个工具调用`}
      meta={doneCount < total && isStreaming ? (<><Spinner /><span>{status.join(" ")}</span></>) : status.join(" ")}
      open={open}
      onToggle={toggle}
      muted={!isStreaming}
      testId="toolcall-group"
    >
      <div className="space-y-1.5">
        {toolCalls.map((tc: any) => (
          <ToolCallCard key={tc.id} toolCall={tc} result={results.get(tc.id)} isStreaming={isStreaming} />
        ))}
      </div>
    </ProcessCard>
  );
}
```

- [ ] **Step 4: 重写 DelegateCard（橙色整卡 → warning tone ProcessCard，子回复 ReactMarkdown）**

`packages/frontend/src/components/blocks/DelegateCard.tsx` 全文替换：

```tsx
import type { ToolCall, ToolResultMessage } from "@wa-pi/shared";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ProcessCard, Spinner } from "./ProcessCard";
import { useAutoCollapse } from "./useAutoCollapse";

interface Props {
  toolCall: ToolCall;
  result?: ToolResultMessage;
  isStreaming?: boolean;
}

/** 委派卡片：流式中展开（任务可见），完成即折叠；子智能体回复用 ReactMarkdown 渲染 */
export function DelegateCard({ toolCall, result, isStreaming }: Props) {
  const args = toolCall.arguments as { agent?: string; task?: string };
  const { open, toggle } = useAutoCollapse({ isStreaming, isDone: !!result });
  const failed = !!result?.isError;
  const full = result?.content.map((c: ToolResultMessage["content"][number]) => (c.type === "text" ? c.text : "")).join("\n") ?? "";
  return (
    <ProcessCard
      tone="warning"
      icon="↪"
      title={`委派给 ${args.agent ?? "子智能体"}`}
      meta={!result ? (<><Spinner /><span>执行中</span></>) : failed ? "✗ 失败" : "✓ 完成"}
      open={open}
      onToggle={toggle}
      muted={!isStreaming}
      testId={`delegate-${toolCall.id}`}
    >
      <div className="mb-1">📋 任务：{args.task}</div>
      {result && (
        <div data-testid="text-block" className={failed ? "text-danger" : ""}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{full}</ReactMarkdown>
        </div>
      )}
    </ProcessCard>
  );
}
```

`packages/frontend/tests/DelegateCard.test.tsx` 重写用例：
- 折叠态头部显示「委派给 {agent}」（`delegate-<id>-header`，body 不在 DOM）
- 流式中（`isStreaming` + 无 result）默认展开且 meta 含「执行中」
- 完成后（有 result、非流式）默认折叠且 `data-muted="true"`
- 失败态 meta 含「✗ 失败」
- 展开后子回复经 ReactMarkdown 渲染（构造含 `` `code` `` 或列表的 result 文本，断言对应标签出现）

- [ ] **Step 5: 接入 MessageList 并删除旧组件**

`packages/frontend/src/components/MessageList.tsx`：

1. 顶部 import 替换：
   - 删 `import { DelegateCard } from "./blocks/DelegateCard";` → 改为：
   ```tsx
   import { DelegateCard } from "./blocks/DelegateCard";
   import { ThinkingCard } from "./blocks/ThinkingCard";
   import { ToolGroupCard } from "./blocks/ToolCallCard";
   ```
2. `MessageRow` 的 segments 渲染（原 L390-410）改为：
   ```tsx
   if (seg.kind === "thinking") {
     return <ThinkingCard key={si} thinking={seg.texts.join("\n")} isStreaming={isStreaming} />;
   }
   if (seg.kind === "toolCalls") {
     return <ToolGroupCard key={si} toolCalls={seg.calls} results={row.toolResults} isStreaming={isStreaming} />;
   }
   if (seg.kind === "delegate") {
     return <DelegateCard key={seg.call.id} toolCall={seg.call} result={row.toolResults.get(seg.call.id)} isStreaming={isStreaming} />;
   }
   ```
3. 删除本地函数 `ThinkingBlock`（L481-504）、`ToolCallGroup`（L534-574）、`ToolCallBlock`（L576-616）、`formatArgs`（L619-632）——已分别由 ThinkingCard/ToolGroupCard/ToolCallCard 替代；`CopyButton` 保留。
4. `StreamingRow` 首字前「正在思考…」loading 气泡保留不动。

- [ ] **Step 6: 全量测试，修复失效断言**

Run: `cd packages/frontend && bun test`
预期处理：凡是断言旧 pill 文案（`💭 思考过程 已完成`、`🔧 工具调用记录`）或旧结构的用例，改为断言新卡片（`thinking-panel-header` 含「思考过程」、`toolcall-group-header` 含「N 个工具调用」、单卡 `toolcall-<id>-header` 含工具名）。**只更新失效的断言文案/选择器，不放宽行为断言。**

- [ ] **Step 7: Commit**

```bash
git add packages/frontend/src/components/blocks/ packages/frontend/src/components/MessageList.tsx packages/frontend/tests/
git commit -m "feat(frontend): 过程块迁移 ProcessCard——流式展开/完成折叠/回合结束弱化，DelegateCard 子回复 markdown 渲染"
```

---

### Task 4: 代码块卡片 + Prism 高亮

**Files:**
- Modify: `packages/frontend/package.json`（`bun add prism-react-renderer`）
- Create: `packages/frontend/src/components/blocks/CodeBlockCard.tsx`
- Create: `packages/frontend/src/components/blocks/markdown-components.tsx`
- Modify: `packages/frontend/src/components/MessageList.tsx`（ReactMarkdown 接 `components`）
- Modify: `packages/frontend/src/components/blocks/DelegateCard.tsx`（Props 增加 `sessionId: string`，ReactMarkdown 同样接 `components`；MessageList 调用点传 `sessionId={sessionId}`）
- Test: `packages/frontend/tests/CodeBlockCard.test.tsx`

**Interfaces:**
- Produces:
  - `CodeBlockCard({ language: string; code: string })`，testid：`code-block-card`、`code-copy`、`code-expand`
  - `createMarkdownComponents(sessionId: string): Components`（react-markdown 的 components 类型）——Task 5 在同一工厂内追加 `code` 映射，签名不变。

- [ ] **Step 1: 安装依赖**

Run: `cd packages/frontend && bun add prism-react-renderer`
Expected: package.json dependencies 出现 `prism-react-renderer`（v2.x）

- [ ] **Step 2: 写失败测试**

`packages/frontend/tests/CodeBlockCard.test.tsx`：

```tsx
import { test, expect, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { CodeBlockCard } from "../src/components/blocks/CodeBlockCard";
import { useToastStore } from "../src/store/toast";

beforeEach(() => {
  useToastStore.setState({ toasts: [] });
});

test("头部条显示语言名与复制按钮", () => {
  render(<CodeBlockCard language="ts" code={"const a = 1;\n"} />);
  const card = screen.getByTestId("code-block-card");
  expect(card.textContent).toContain("ts");
  expect(screen.getByTestId("code-copy")).toBeTruthy();
});

test("点击复制写剪贴板并弹 toast", async () => {
  let copied = "";
  Object.assign(navigator, { clipboard: { writeText: async (t: string) => { copied = t; } } });
  render(<CodeBlockCard language="ts" code={"const a = 1;\n"} />);
  fireEvent.click(screen.getByTestId("code-copy"));
  await new Promise(r => setTimeout(r, 0));
  expect(copied).toBe("const a = 1;\n");
});

test("≤20 行无折叠按钮，>20 行显示 +N more lines 且点击展开", () => {
  const short = Array.from({ length: 5 }, (_, i) => `l${i}`).join("\n");
  const { unmount } = render(<CodeBlockCard language="text" code={short} />);
  expect(screen.queryByTestId("code-expand")).toBeNull();
  unmount();
  const long = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n");
  render(<CodeBlockCard language="text" code={long} />);
  const btn = screen.getByTestId("code-expand");
  expect(btn.textContent).toContain("+10");
  expect(screen.getByTestId("code-block-card").textContent).not.toContain("l29");
  fireEvent.click(btn);
  expect(screen.getByTestId("code-block-card").textContent).toContain("l29");
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd packages/frontend && bun test tests/CodeBlockCard.test.tsx`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现 CodeBlockCard 与 markdown-components 工厂**

`packages/frontend/src/components/blocks/CodeBlockCard.tsx`：

```tsx
import { useState } from "react";
import { Highlight, themes } from "prism-react-renderer";
import { useToastStore } from "../../store/toast";

const COLLAPSE_LINES = 20;

/** cocode 式代码块卡片：头部条（语言名 + 复制），Prism 高亮 + 行号，超 20 行可折叠 */
export function CodeBlockCard({ language, code }: { language: string; code: string }) {
  const [expanded, setExpanded] = useState(false);
  const addToast = useToastStore(s => s.add);
  const lines = code.replace(/\n$/, "").split("\n");
  const collapsible = lines.length > COLLAPSE_LINES;
  const shown = collapsible && !expanded ? lines.slice(0, COLLAPSE_LINES).join("\n") : lines.join("\n");
  const lang = language || "text";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      addToast("已复制到剪贴板", "success");
    } catch {
      addToast("复制失败", "error");
    }
  };

  return (
    <div data-testid="code-block-card" className="rounded-lg border border-hairline overflow-hidden my-1">
      <div className="flex items-center px-2.5 py-1 bg-surface-elevated border-b border-hairline">
        <span className="text-[11px] font-mono text-tertiary">{lang}</span>
        <button
          type="button"
          data-testid="code-copy"
          onClick={copy}
          className="ml-auto text-[11px] text-tertiary hover:text-primary transition-colors"
          style={{ cursor: "pointer" }}
        >
          复制
        </button>
      </div>
      <Highlight theme={themes.github} code={shown} language={lang}>
        {({ tokens, getLineProps, getTokenProps }) => (
          <pre className="text-[12px] p-3 overflow-x-auto m-0" style={{ background: "var(--surface)" }}>
            {tokens.map((line, i) => (
              <div key={i} {...getLineProps({ line })}>
                <span className="inline-block w-8 text-right mr-3 text-tertiary select-none">{i + 1}</span>
                {line.map((token, k) => (
                  <span key={k} {...getTokenProps({ token })} />
                ))}
              </div>
            ))}
          </pre>
        )}
      </Highlight>
      {collapsible && (
        <button
          type="button"
          data-testid="code-expand"
          onClick={() => setExpanded(e => !e)}
          className="w-full text-center text-[11px] text-tertiary hover:text-primary py-1 border-t border-hairline bg-surface-elevated transition-colors"
          style={{ cursor: "pointer" }}
        >
          {expanded ? "收起" : `+${lines.length - COLLAPSE_LINES} more lines`}
        </button>
      )}
    </div>
  );
}
```

`packages/frontend/src/components/blocks/markdown-components.tsx`（Task 5 会在此追加 `code` 映射）：

```tsx
import type { Components } from "react-markdown";
import { CodeBlockCard } from "./CodeBlockCard";

/**
 * 生成助手消息的 markdown 组件映射。
 * pre → CodeBlockCard（react-markdown 中代码块结构为 pre > code.language-x）。
 * sessionId 供 Task 5 的 FilePill 解析相对路径用。
 */
export function createMarkdownComponents(sessionId: string): Components {
  return {
    pre: (props: any) => {
      const codeEl = props.children;
      const className: string = codeEl?.props?.className ?? "";
      const m = /language-([\w+-]+)/.exec(className);
      const code = String(codeEl?.props?.children ?? "");
      return <CodeBlockCard language={m?.[1] ?? ""} code={code} />;
    },
  };
}
```

- [ ] **Step 5: 接入 MessageList 与 DelegateCard**

`MessageList.tsx`：
1. import 增加：
   ```tsx
   import { useMemo } from "react"; // 合并进现有 react import
   import { createMarkdownComponents } from "./blocks/markdown-components";
   ```
2. `MessageRow` 内、`segments` 计算后加：
   ```tsx
   const mdComponents = useMemo(() => createMarkdownComponents(sessionId), [sessionId]);
   ```
   （`MessageRow` 是函数组件，hook 需在顶层、任何 early return 之前——把它放在 `const m = row.main.message as any;` 之后、custom 消息判断之前。）
3. 正文渲染改为：
   ```tsx
   <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{text}</ReactMarkdown>
   ```

`DelegateCard.tsx`：Props 增加 `sessionId: string`；内部 `const mdComponents = createMarkdownComponents(sessionId);` 后 `<ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>`。
`MessageList.tsx` delegate 段调用点改为 `<DelegateCard key={seg.call.id} sessionId={sessionId} toolCall={...} ... />`。
`tests/DelegateCard.test.tsx` 渲染处补传 `sessionId="s1"`。

- [ ] **Step 6: 跑测试确认通过 + 回归**

Run: `cd packages/frontend && bun test`
Expected: 新用例 pass；既有含代码块的 markdown 用例如断言旧裸 `pre` 结构，更新为断言 `code-block-card`（只改选择器，不放宽断言）

- [ ] **Step 7: Commit**

```bash
git add packages/frontend
git commit -m "feat(frontend): 代码块卡片——头部条/复制/Prism 高亮/超 20 行折叠"
```

---

### Task 5: FilePill 文件路径胶囊 + 只读预览

**Files:**
- Create: `packages/frontend/src/components/blocks/file-path.ts`
- Create: `packages/frontend/src/components/blocks/FilePill.tsx`
- Create: `packages/frontend/src/components/blocks/FilePreviewModal.tsx`
- Modify: `packages/frontend/src/components/blocks/markdown-components.tsx`（追加 `code` 映射）
- Test: `packages/frontend/tests/file-path.test.ts`
- Test: `packages/frontend/tests/FilePill.test.tsx`

**Interfaces:**
- Consumes: `createMarkdownComponents`（Task 4）、`fs-client.readFile` / `_setFsTransport`（既有，`src/fs-client.ts:61,25`）、`Modal`（既有，`src/components/ui/Modal.tsx`——先读其 props 再用）
- Produces:
  - `parseFilePath(text: string): { path: string; line?: number; col?: number } | null`
  - `FilePill({ rawText: string; sessionId: string })`，testid `file-pill`
  - `FilePreviewModal({ absPath: string; onClose: () => void })`，testid `file-preview-modal`
  - `resolveSessionCwd(sessionId: string): string | null`、`resolveAbsolutePath(path: string, sessionId: string): string`（FilePill.tsx 内导出）

- [ ] **Step 1: 确认两个既有 API**

- 读 `packages/frontend/src/store/projects.ts`，确认项目对象的路径字段名（`cwd` 或 `path`），`resolveSessionCwd` 用确认后的字段。
- 读 `packages/frontend/src/components/ui/Modal.tsx` 与 `packages/frontend/src/fs-client.ts` 的 `FsTransport` 类型，确认 Modal props 与 readFile transport 形状；`tests/FilePicker.test.tsx` 已有 `_setFsTransport` mock 范式可复用。

- [ ] **Step 2: 写失败测试（纯函数）**

`packages/frontend/tests/file-path.test.ts`：

```ts
import { test, expect } from "bun:test";
import { parseFilePath } from "../src/components/blocks/file-path";

test("识别相对/绝对/家目录路径", () => {
  expect(parseFilePath("packages/frontend/src/App.tsx")).toEqual({ path: "packages/frontend/src/App.tsx", line: undefined, col: undefined });
  expect(parseFilePath("/Users/pipi/x.md")?.path).toBe("/Users/pipi/x.md");
  expect(parseFilePath("~/docs/a.md")?.path).toBe("~/docs/a.md");
  expect(parseFilePath("./src/b.ts")?.path).toBe("./src/b.ts");
});

test("识别 :行 与 :行:列 后缀", () => {
  expect(parseFilePath("src/a.ts:12")).toEqual({ path: "src/a.ts", line: 12, col: undefined });
  expect(parseFilePath("src/a.ts:12:3")).toEqual({ path: "src/a.ts", line: 12, col: 3 });
});

test("拒绝非路径", () => {
  expect(parseFilePath("README.md")).toBeNull(); // 无 /，保守不识别
  expect(parseFilePath("hello world")).toBeNull();
  expect(parseFilePath("https://a.com/b.html")).toBeNull();
  expect(parseFilePath("a/b")).toBeNull(); // 末段无扩展名
});
```

- [ ] **Step 3: 实现 file-path.ts**

`packages/frontend/src/components/blocks/file-path.ts`：

```ts
export interface ParsedFilePath { path: string; line?: number; col?: number; }

const PATH_RE = /^((?:~|\.{1,2})?\/[^\s]+|[\w@+.-]+(?:\/[\w@+.-]+)+)(?::(\d+))?(?::(\d+))?$/;

/**
 * 保守识别文件路径：必须含 "/" 且末段带扩展名（1-10 字符），可选 :行:列 后缀。
 * 无斜杠的裸文件名（README.md）与 URL 不识别，避免误伤普通行内代码。
 */
export function parseFilePath(text: string): ParsedFilePath | null {
  const t = text.trim();
  if (t.length < 3 || t.length > 300 || t.includes("://")) return null;
  const m = PATH_RE.exec(t);
  if (!m) return null;
  const p = m[1];
  const last = p.split("/").pop() ?? "";
  if (!/\.[A-Za-z0-9]{1,10}$/.test(last)) return null;
  return { path: p, line: m[2] ? Number(m[2]) : undefined, col: m[3] ? Number(m[3]) : undefined };
}
```

Run: `cd packages/frontend && bun test tests/file-path.test.ts` → 全过。

- [ ] **Step 4: 写失败测试（FilePill 组件）**

`packages/frontend/tests/FilePill.test.tsx`：

```tsx
import { test, expect, beforeEach } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { FilePill } from "../src/components/blocks/FilePill";
import { _setFsTransport } from "../src/fs-client";
import { useProjectsStore } from "../src/store/projects";
import { useToastStore } from "../src/store/toast";

beforeEach(() => {
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "demo", cwd: "/work/demo" } as any],
    sessions: [{ id: "s1", projectId: "p1" } as any],
  });
  useToastStore.setState({ toasts: [] });
  _setFsTransport(null);
});

test("渲染胶囊（basename + 行号），点击弹预览并 readFile 解析到项目 cwd", async () => {
  let requested = "";
  _setFsTransport(async (method: string, params: any) => {
    if (method === "readFile") { requested = params.path; return { content: "file-content-123" }; }
    throw new Error("unexpected " + method);
  });
  render(<FilePill rawText="src/index.ts:12" sessionId="s1" />);
  const pill = screen.getByTestId("file-pill");
  expect(pill.textContent).toContain("index.ts");
  expect(pill.textContent).toContain(":12");
  fireEvent.click(pill);
  await waitFor(() => expect(screen.getByTestId("file-preview-modal").textContent).toContain("file-content-123"));
  expect(requested).toBe("/work/demo/src/index.ts");
});

test("非路径文本回退为普通 code", () => {
  render(<FilePill rawText="hello" sessionId="s1" />);
  expect(screen.queryByTestId("file-pill")).toBeNull();
});
```

注：`_setFsTransport` 的签名以 Step 1 读到的 `FsTransport` 为准调整 mock 写法（参考 `tests/FilePicker.test.tsx` 的既有 mock）；`projects` 的路径字段名同样以 Step 1 为准。

- [ ] **Step 5: 实现 FilePill / FilePreviewModal / code 映射**

`packages/frontend/src/components/blocks/FilePill.tsx`：

```tsx
import { useState } from "react";
import { useProjectsStore } from "../../store/projects";
import { parseFilePath } from "./file-path";
import { FilePreviewModal } from "./FilePreviewModal";

/** 从会话找到项目 cwd（相对路径据此拼绝对路径）。字段名以 store/projects.ts 实际为准 */
export function resolveSessionCwd(sessionId: string): string | null {
  const { sessions, projects } = useProjectsStore.getState();
  const s = sessions.find(x => x.id === sessionId);
  const p = projects.find(x => x.id === s?.projectId) as any;
  return p?.cwd ?? p?.path ?? null;
}

export function resolveAbsolutePath(path: string, sessionId: string): string {
  if (path.startsWith("/") || path.startsWith("~")) return path;
  const cwd = resolveSessionCwd(sessionId);
  return cwd ? `${cwd}/${path}` : path;
}

/** 文件路径胶囊：点击弹出只读预览 */
export function FilePill({ rawText, sessionId }: { rawText: string; sessionId: string }) {
  const [preview, setPreview] = useState(false);
  const parsed = parseFilePath(rawText);
  if (!parsed) return <code>{rawText}</code>;
  const abs = resolveAbsolutePath(parsed.path, sessionId);
  const base = parsed.path.split("/").pop();
  return (
    <>
      <button
        type="button"
        data-testid="file-pill"
        title={abs}
        onClick={() => setPreview(true)}
        className="inline-flex items-center gap-1 px-1.5 py-0 rounded-md border border-hairline bg-surface-elevated text-[12px] font-mono text-accent hover:border-accent transition-colors align-baseline"
        style={{ cursor: "pointer" }}
      >
        📄 {base}{parsed.line != null ? `:${parsed.line}` : ""}
      </button>
      {preview && <FilePreviewModal absPath={abs} onClose={() => setPreview(false)} />}
    </>
  );
}
```

`packages/frontend/src/components/blocks/FilePreviewModal.tsx`（Modal 的 props 名以 Step 1 读到的为准调整）：

```tsx
import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { readFile } from "../../fs-client";
import { useToastStore } from "../../store/toast";

/** 文件只读预览：经 kernel fs 读取内容，可复制路径 */
export function FilePreviewModal({ absPath, onClose }: { absPath: string; onClose: () => void }) {
  const [state, setState] = useState<{ loading: boolean; content?: string; error?: string }>({ loading: true });
  const addToast = useToastStore(s => s.add);

  useEffect(() => {
    let alive = true;
    readFile(absPath)
      .then(r => { if (alive) setState({ loading: false, content: r.content }); })
      .catch(() => { if (alive) setState({ loading: false, error: `无法读取文件：${absPath}` }); });
    return () => { alive = false; };
  }, [absPath]);

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(absPath);
      addToast("已复制路径", "success");
    } catch {
      addToast("复制失败", "error");
    }
  };

  return (
    <Modal title={absPath} onClose={onClose}>
      <div data-testid="file-preview-modal">
        {state.loading && <div className="text-tertiary text-[12px]">加载中…</div>}
        {state.error && <div className="text-danger text-[12px]">{state.error}</div>}
        {state.content != null && (
          <pre className="text-[12px] font-mono whitespace-pre-wrap max-h-[60vh] overflow-auto m-0">{state.content}</pre>
        )}
        <div className="flex justify-end mt-2">
          <button type="button" onClick={copyPath} className="text-[12px] text-secondary hover:text-primary border border-hairline rounded-pill px-2 py-0.5" style={{ cursor: "pointer" }}>
            复制路径
          </button>
        </div>
      </div>
    </Modal>
  );
}
```

`markdown-components.tsx` 追加 `code` 映射（完整文件变为）：

```tsx
import type { Components } from "react-markdown";
import { CodeBlockCard } from "./CodeBlockCard";
import { FilePill } from "./FilePill";
import { parseFilePath } from "./file-path";

/**
 * 生成助手消息的 markdown 组件映射。
 * pre → CodeBlockCard；形似路径的内联 code → FilePill（块级 code 已被 pre 接管，不会走到这里）。
 */
export function createMarkdownComponents(sessionId: string): Components {
  return {
    pre: (props: any) => {
      const codeEl = props.children;
      const className: string = codeEl?.props?.className ?? "";
      const m = /language-([\w+-]+)/.exec(className);
      const code = String(codeEl?.props?.children ?? "");
      return <CodeBlockCard language={m?.[1] ?? ""} code={code} />;
    },
    code: (props: any) => {
      const text = String(props.children ?? "");
      if (!props.className && parseFilePath(text)) {
        return <FilePill rawText={text} sessionId={sessionId} />;
      }
      return <code>{props.children}</code>;
    },
  };
}
```

- [ ] **Step 6: 跑测试确认通过 + 回归**

Run: `cd packages/frontend && bun test`
Expected: file-path / FilePill 新用例 pass；全量绿

- [ ] **Step 7: Commit**

```bash
git add packages/frontend
git commit -m "feat(frontend): FilePill 文件路径胶囊——点击只读预览（kernel fs）+ 复制路径"
```

---

### Task 6: E2E（Playwright 真实浏览器）

**Files:**
- Create: `packages/frontend/e2e/chat-blocks.spec.ts`

- [ ] **Step 1: 读既有 harness**

读 `packages/frontend/e2e/rpc-session.spec.ts`、`e2e/global-setup.ts`、`e2e/global-teardown.ts`，复用其隔离环境（独立 `WA_PI_DIR` + 端口、deepseek provider 注入、apiKey 从本机 pi 凭证库运行时读取）与会话创建辅助。

- [ ] **Step 2: 写 E2E 用例**

`packages/frontend/e2e/chat-blocks.spec.ts`，单个用例主流程：
1. 经 API 注入 provider → 建会话；
2. 发送 prompt（指令化，降低模型随机性）：`先用 bash 工具执行 echo ok，然后回复一段 markdown：包含一个 5 行的 ```ts 代码块，并用行内代码提及 packages/frontend/package.json 这个文件`;
3. 断言（web-first assertions，自动等待）：
   - 回合结束后：工具卡（`toolcall-group` 或 `toolcall-*`）根节点 `data-muted="true"` 且 `-body` 不可见（完成折叠弱化）；
   - `code-block-card` 可见且含「ts」与「复制」；
   - `file-pill` 可见，点击后 `file-preview-modal` 可见且含文件内容（package.json 的 `"name"`）；
   - 正文 `text-block` 可见（视觉重心是正文）。
4. `test.afterEach`/`finally`：删除测试会话与项目数据；不保留任何截图（Playwright 失败产物 `test-results/` 跑完删除）。

提示：真实模型可能偶发不按指令输出 → `test.describe.configure({ retries: 1 })`；若连续失败，先人工跑一次该 prompt 确认模型行为，再调 prompt，不得放宽断言。

- [ ] **Step 3: 跑 E2E 确认通过**

Run: `cd packages/frontend && bunx playwright test e2e/chat-blocks.spec.ts`
Expected: 1 passed（或 retry 后 passed）

- [ ] **Step 4: Commit**

```bash
git add packages/frontend/e2e/chat-blocks.spec.ts
git commit -m "test(frontend): 聊天过程卡片/代码块/FilePill E2E"
```

---

### Task 7: 全量回归 + CHANGELOG

- [ ] **Step 1: 全量测试与类型检查**

```bash
cd packages/frontend && bun test
bun run --filter @wa-pi/frontend typecheck
cd /Users/pipi/work/WaPi && bun test --path-ignore-patterns "packages/frontend/**"
```
Expected: 全绿；typecheck 无错（kernel/shared 未改，root 测试应无变化）

- [ ] **Step 2: CHANGELOG**

`CHANGELOG.md` 顶部加（格式沿用既有条目）：

```markdown
## 2026-07-24

### 新增
- **聊天消息流对齐 cocode 显示模式（§3/§5/§6）**：过程块（思考/工具调用/委托）改为 ProcessCard 卡片基座（tone 图标 + meta + chevron），流式中默认展开、单项完成即折叠、回合结束统一折叠弱化（opacity-55）、用户手动操作优先（useAutoCollapse）；连续工具自动归组「N 个工具调用」；DelegateCard 子回复改 ReactMarkdown 渲染；代码块卡片（语言头 + 复制 + prism-react-renderer 高亮 + 行号 + 超 20 行折叠）；文件路径 FilePill（点击弹只读预览，复用 kernel fs readFile，可复制路径）。新增依赖 prism-react-renderer（frontend）。
  - 影响范围：packages/frontend/src/components/{MessageList.tsx,blocks/*}、packages/frontend/tests/*、packages/frontend/e2e/chat-blocks.spec.ts、packages/frontend/package.json
```

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG 记录聊天界面 cocode 对齐"
```

---

## 自审记录（写计划时已完成）

- **spec 覆盖**：目标三点——时间线折叠行为（T1+T3）、过程卡片体系（T2+T3）、代码块+FilePill（T4+T5）、E2E（T6）、CHANGELOG/回归（T7）——均有对应任务；2026-07-23 spec 的行为规则由 T1 完整吸收，其 DelegateCard「子回复 ReactMarkdown」要求并入 T3。
- **类型一致性**：`useAutoCollapse({isStreaming?, isDone})`、`ProcessCard` props、`createMarkdownComponents(sessionId)`、`DelegateCard` 新增 `sessionId` prop 在各任务间签名一致。
- **已知取舍**：① FilePill 保守识别（裸文件名无斜杠不识别）；② 不实现 cocode 的耗时统计（现有数据无 per-call 计时，YAGNI）；③ thinking 完成信号 = 整轮结束（沿用 spec）。
