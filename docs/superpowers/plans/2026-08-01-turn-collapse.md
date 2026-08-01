# 轮级折叠摘要行 + 整轮耗时 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 一轮 agent 调用完成后，把中间过程（思考/工具调用/delegate/fleet）二次折叠为一行摘要「本轮时长 X · N 个步骤」，点击展开可见各步骤并可再逐个展开；时长从消息时间戳纯读推算，刷新后历史轮也能还原。

**架构：** 后端两渠道提供整轮耗时——`session-history.ts` 历史读出时按 user 边界切轮、把 `turnElapsedMs` 注入该轮最后一条 assistant 消息（零写入）；`agent-manager.ts` 在 `agent_end` 时把 `elapsedMs` 附加到透传事件（实时）。前端 store 在 `agent_end` 时把 `elapsedMs` 写回消息 `turnElapsedMs`，渲染层 `MessageList` 对"已定稿 + 含过程段"的行用新组件 `TurnSummary` 折叠过程段，text 段保留在外。失败回合（error 结尾）不注入/不显示时长。

**技术栈：** TypeScript、Bun（kernel 与前端测试均为 `bun:test` + happy-dom）、React（MessageList）、zustand（前端 store）、jsonl（pi 会话文件，只读）。

**规格：** `docs/superpowers/specs/2026-08-01-turn-collapse-design.md`

---

### 任务 1：shared 类型——AssistantMessage.turnElapsedMs + agent_end.elapsedMs

**文件：**

- 修改：`packages/shared/src/types.ts:167-185`（AssistantMessage）、`:776`（SDKEvent.agent_end）

- [ ] **步骤 1：给 AssistantMessage 加字段**

在 `packages/shared/src/types.ts` 的 `AssistantMessage`（约 L167）内、`usage` 字段前加入：

```ts
 // 整轮耗时（ms）：本轮最后一条 assistant.timestamp − user.timestamp。
 // 仅成功完成的轮注入（失败回合/旧数据无此字段）。历史加载由 kernel 注入，
 // 实时轮由前端在 agent_end 时写回。渲染层据此显示「本轮时长」。
 turnElapsedMs?: number;
```

- [ ] **步骤 2：给 SDKEvent.agent_end 加可选字段**

`packages/shared/src/types.ts` L776 改为：

```ts
 | { type: "agent_end"; messages: AgentMessage[]; willRetry: boolean; elapsedMs?: number }
```

- [ ] **步骤 3：typecheck 验证**

运行：`cd packages/shared && bun run typecheck`
预期：PASS（纯类型扩展，无现有调用受影响）

- [ ] **步骤 4：Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat(types): AssistantMessage.turnElapsedMs + agent_end.elapsedMs 整轮耗时字段"
```

---

### 任务 2：kernel session-history——历史读出时注入 turnElapsedMs（纯读推算）

**文件：**

- 修改：`packages/kernel/src/session-history.ts`
- 测试：`packages/kernel/tests/session-history.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `packages/kernel/tests/session-history.test.ts` 末尾追加：

```ts
test("轮级耗时：成功轮注入 turnElapsedMs（最后 assistant − user）", async () => {
  const file = join(dir, "s.jsonl");
  writeFileSync(file, [
    JSON.stringify({ type: "session", version: 3, id: "uuid-1" }),
    msg("m1", null, "user", "问题", 1000),
    msg("m2", "m1", "assistant", "回答", 5000),
  ].join("\n"));
  const history = (await readSessionHistory(file)) as any[];
  expect(history[1].turnElapsedMs).toBe(4000);
});

test("轮级耗时：失败回合（error 结尾）不注入", async () => {
  const file = join(dir, "s.jsonl");
  writeFileSync(file, [
    JSON.stringify({ type: "session", version: 3, id: "uuid-1" }),
    msg("m1", null, "user", "问题", 1000),
    JSON.stringify({ type: "message", id: "m2", parentId: "m1", timestamp: new Date(2000).toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: "报错" }], timestamp: 2000, stopReason: "error" } }),
  ].join("\n"));
  const history = (await readSessionHistory(file)) as any[];
  expect(history[1].turnElapsedMs).toBeUndefined();
});

test("轮级耗时：连续多轮各自注入", async () => {
  const file = join(dir, "s.jsonl");
  writeFileSync(file, [
    JSON.stringify({ type: "session", version: 3, id: "uuid-1" }),
    msg("m1", null, "user", "问题一", 1000),
    msg("m2", "m1", "assistant", "回答一", 3000),
    msg("m3", "m2", "user", "问题二", 4000),
    msg("m4", "m3", "assistant", "回答二", 8000),
  ].join("\n"));
  const history = (await readSessionHistory(file)) as any[];
  expect(history[1].turnElapsedMs).toBe(2000);
  expect(history[3].turnElapsedMs).toBe(4000);
});

test("轮级耗时：无 user 起点（只有 assistant）不注入", async () => {
  const file = join(dir, "s.jsonl");
  writeFileSync(file, [
    JSON.stringify({ type: "session", version: 3, id: "uuid-1" }),
    msg("m1", null, "assistant", "回答", 2000),
  ].join("\n"));
  const history = (await readSessionHistory(file)) as any[];
  expect(history[0].turnElapsedMs).toBeUndefined();
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd packages/kernel && bun test tests/session-history.test.ts`
预期：新增 4 个用例 FAIL（`turnElapsedMs` 为 undefined，`toBe(4000)` 不匹配）

- [ ] **步骤 3：实现注入函数**

在 `packages/kernel/src/session-history.ts` 的 `readSessionHistory` 函数前新增：

```ts
/**
 * 轮级耗时注入（纯读推算，零写入）：按 user 消息切轮，对"成功完成"的轮
 * （该轮最后一条 assistant 的 stopReason !== "error"）计算
 * turnElapsedMs = 最后 assistant.timestamp − user.timestamp，注入到该轮最后一条
 * assistant 消息。失败回合（error 结尾）/无 user/无 assistant 结束的轮不注入。
 * 旧 jsonl 无字段时前端自然降级为无时长。
 */
function injectTurnElapsedMs(msgs: AgentMessage[]): AgentMessage[] {
 let turnUserTs: number | undefined;
 let lastAsstIdx = -1;
 let lastAsstError = false;
 for (let i = 0; i < msgs.length; i++) {
  const m = msgs[i] as any;
  if (m?.role === "user") {
   if (turnUserTs !== undefined && lastAsstIdx >= 0 && !lastAsstError) {
    (msgs[lastAsstIdx] as any).turnElapsedMs =
     (msgs[lastAsstIdx] as any).timestamp - turnUserTs;
   }
   turnUserTs = m.timestamp;
   lastAsstIdx = -1;
   lastAsstError = false;
  } else if (m?.role === "assistant") {
   lastAsstIdx = i;
   lastAsstError = m.stopReason === "error";
  }
 }
 if (turnUserTs !== undefined && lastAsstIdx >= 0 && !lastAsstError) {
  (msgs[lastAsstIdx] as any).turnElapsedMs =
   (msgs[lastAsstIdx] as any).timestamp - turnUserTs;
 }
 return msgs;
}
```

- [ ] **步骤 4：在 readSessionHistory 返回前调用**

`packages/kernel/src/session-history.ts` 末尾返回值改为：

```ts
 return injectTurnElapsedMs(
  reconcileDanglingAsks(messages, {
   isSessionActive: opts?.isSessionActive,
  }) as AgentMessage[],
 );
```

- [ ] **步骤 5：运行测试确认通过**

运行：`cd packages/kernel && bun test tests/session-history.test.ts`
预期：全部 PASS（新增 4 个 + 既有用例）

- [ ] **步骤 6：Commit**

```bash
git add packages/kernel/src/session-history.ts packages/kernel/tests/session-history.test.ts
git commit -m "feat(kernel): session-history 按轮纯读推算并注入 turnElapsedMs"
```

---

### 任务 3：kernel agent-manager——agent_end 实时附加 elapsedMs

**文件：**

- 修改：`packages/kernel/src/agent-manager.ts`（`_onSessionEvent` switch）
- 测试：`packages/kernel/tests/agent-manager.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `packages/kernel/tests/agent-manager.test.ts` 的 `onEvent` 转发测试附近追加：

```ts
test("agent_end 附加整轮耗时（成功轮：最后 assistant − user）", async () => {
  const received: CapturedEvent[] = [];
  const { project, session, am, fakes } = await setup({ events: received });
  await am.ensureStarted(project.id, "dev", session.id);

  fakes[0].emit({ type: "agent_end", willRetry: false, messages: [
    { role: "user", content: [{ type: "text", text: "问题" }], timestamp: 1000 },
    { role: "assistant", content: [{ type: "text", text: "回答" }], timestamp: 5000, stopReason: "end_turn" },
  ] });

  const ae = received.find((x) => x.e.type === "agent_end");
  expect(ae?.e.elapsedMs).toBe(4000);
});

test("agent_end 失败回合不附加 elapsedMs", async () => {
  const received: CapturedEvent[] = [];
  const { project, session, am, fakes } = await setup({ events: received });
  await am.ensureStarted(project.id, "dev", session.id);

  fakes[0].emit({ type: "agent_end", willRetry: false, messages: [
    { role: "user", content: [{ type: "text", text: "问题" }], timestamp: 1000 },
    { role: "assistant", content: [{ type: "text", text: "报错" }], timestamp: 2000, stopReason: "error" },
  ] });

  const ae = received.find((x) => x.e.type === "agent_end");
  expect(ae?.e.elapsedMs).toBeUndefined();
});

test("agent_end messages 无 user 时不附加 elapsedMs", async () => {
  const received: CapturedEvent[] = [];
  const { project, session, am, fakes } = await setup({ events: received });
  await am.ensureStarted(project.id, "dev", session.id);

  fakes[0].emit({ type: "agent_end", willRetry: false, messages: [
    { role: "assistant", content: [{ type: "text", text: "回答" }], timestamp: 2000, stopReason: "end_turn" },
  ] });

  const ae = received.find((x) => x.e.type === "agent_end");
  expect(ae?.e.elapsedMs).toBeUndefined();
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd packages/kernel && bun test tests/agent-manager.test.ts`
预期：新增 3 个用例 FAIL（`elapsedMs` 为 undefined）

- [ ] **步骤 3：实现 agent_end 分支**

`packages/kernel/src/agent-manager.ts` `_onSessionEvent` 的 switch 中，`message_end` case 之后、`agent_settled` case 之前加入：

```ts
   case "agent_end": {
    // 整轮耗时：该轮最后 assistant.timestamp − user.timestamp（纯读推算语义，
    // 与 session-history 注入一致）。仅成功轮附加；失败回合/找不到 user 不附加。
    const msgs = (event as any).messages as any[] | undefined;
    if (Array.isArray(msgs)) {
     const lastAssistant = [...msgs].reverse().find((m: any) => m?.role === "assistant");
     const user = [...msgs].reverse().find((m: any) => m?.role === "user");
     if (lastAssistant && user && lastAssistant.stopReason !== "error") {
      (event as any).elapsedMs = lastAssistant.timestamp - user.timestamp;
     }
    }
    break;
   }
```

- [ ] **步骤 4：运行测试确认通过**

运行：`cd packages/kernel && bun test tests/agent-manager.test.ts`
预期：全部 PASS（新增 3 个 + 既有用例）

- [ ] **步骤 5：Commit**

```bash
git add packages/kernel/src/agent-manager.ts packages/kernel/tests/agent-manager.test.ts
git commit -m "feat(kernel): agent_end 实时附加整轮耗时 elapsedMs"
```

---

### 任务 4：前端 store——agent_end 写回 + setMessages 合并保留字段

**文件：**

- 修改：`packages/frontend/src/store/session.ts`（agent_end 分支、setMessages 合并）
- 测试：`packages/frontend/tests/store-session.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `packages/frontend/tests/store-session.test.ts` 末尾追加：

```ts
test("agent_end 携带 elapsedMs 时写回最后一条 assistant 消息 turnElapsedMs", () => {
  useSessionStore.getState().setMessages("s1", [
    { message: { role: "user", content: [{ type: "text", text: "问题" }], timestamp: 1 }, agentName: "dev" },
    { message: { role: "assistant", content: [{ type: "text", text: "回答" }], timestamp: 2, stopReason: "end_turn" }, agentName: "dev" },
  ]);
  useSessionStore.getState().handleSDKEvent("s1", envelope({
    type: "agent_end", messages: [], willRetry: false, elapsedMs: 4000,
  }));
  const msgs = useSessionStore.getState().messagesBySession["s1"];
  const lastAsst = [...msgs].reverse().find((m) => (m.message as any).role === "assistant");
  expect((lastAsst?.message as any).turnElapsedMs).toBe(4000);
});

test("agent_end 无 elapsedMs 时不写回", () => {
  useSessionStore.getState().setMessages("s1", [
    { message: { role: "user", content: [{ type: "text", text: "问题" }], timestamp: 1 }, agentName: "dev" },
    { message: { role: "assistant", content: [{ type: "text", text: "回答" }], timestamp: 2, stopReason: "end_turn" }, agentName: "dev" },
  ]);
  useSessionStore.getState().handleSDKEvent("s1", envelope({
    type: "agent_end", messages: [], willRetry: false,
  }));
  const msgs = useSessionStore.getState().messagesBySession["s1"];
  const lastAsst = [...msgs].reverse().find((m) => (m.message as any).role === "assistant");
  expect((lastAsst?.message as any).turnElapsedMs).toBeUndefined();
});

test("setMessages 合并连续 assistant 时保留 turnElapsedMs", () => {
  useSessionStore.getState().setMessages("s1", [
    { message: { role: "user", content: [{ type: "text", text: "问题" }], timestamp: 1 }, agentName: "dev" },
    { message: { role: "assistant", content: [{ type: "text", text: "思考" }], timestamp: 2, stopReason: "end_turn" }, agentName: "dev" },
    { message: { role: "assistant", content: [{ type: "text", text: "回答" }], timestamp: 3, stopReason: "end_turn", turnElapsedMs: 4000 }, agentName: "dev" },
  ]);
  const asst = useSessionStore.getState().messagesBySession["s1"].filter((m) => (m.message as any).role === "assistant");
  expect(asst).toHaveLength(1);
  expect((asst[0].message as any).turnElapsedMs).toBe(4000);
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd packages/frontend && bun test tests/store-session.test.ts`
预期：新增 3 个用例 FAIL（turnElapsedMs 未写回/未保留）

- [ ] **步骤 3：agent_end 分支写回**

`packages/frontend/src/store/session.ts` 的 `case "agent_end"`（约 L430），在 `set(s => {...})` 内、`return` 前加入写回逻辑。将现有 `return { ... }` 改为先构建 result 再返回：

```ts
      case "agent_end": {
        const away = sessionId !== useProjectsStore.getState().currentSessionId;
        // 终态到达：丢弃挂起的 streaming 帧，防止旧 partial 复活
        streamingBatcher.drop(sessionId);
        const elapsedMs = (envelope.event as any).elapsedMs as number | undefined;
        set(s => {
          const streaming = s.streamingBySession[sessionId];
          const isPlaceholder = (streaming?.message as any)?.stopReason === "pending";
          const result: any = {
            statusBySession: { ...s.statusBySession, [sessionId]: "idle" },
            thinkingSinceBySession: { ...s.thinkingSinceBySession, [sessionId]: null },
            unreadBySession: away ? { ...s.unreadBySession, [sessionId]: true } : s.unreadBySession,
            streamingBySession: isPlaceholder ? { ...s.streamingBySession, [sessionId]: null } : s.streamingBySession,
            optimisticEchoBySession: { ...s.optimisticEchoBySession, [sessionId]: false },
          };
          // 整轮耗时写回该轮最后一条 assistant 消息（渲染层唯一数据源：消息.turnElapsedMs）
          if (elapsedMs != null) {
            const list = s.messagesBySession[sessionId] ?? [];
            const fromEnd = [...list].reverse().findIndex((m) => (m.message as any).role === "assistant");
            if (fromEnd >= 0) {
              const i = list.length - 1 - fromEnd;
              const msg = list[i];
              const updated = { ...msg, message: { ...(msg.message as any), turnElapsedMs: elapsedMs } };
              result.messagesBySession = {
                ...s.messagesBySession,
                [sessionId]: [...list.slice(0, i), updated, ...list.slice(i + 1)],
              };
            }
          }
          return result;
        });
        break;
      }
```

- [ ] **步骤 4：setMessages 合并时保留 turnElapsedMs**

`packages/frontend/src/store/session.ts` `setMessages` 的 compacted 循环内，`if (m.stopReason)` 块后追加：

```ts
        if (m.turnElapsedMs != null) {
          (last.message as any).turnElapsedMs = m.turnElapsedMs;
        }
```

- [ ] **步骤 5：运行测试确认通过**

运行：`cd packages/frontend && bun test tests/store-session.test.ts`
预期：全部 PASS（新增 3 个 + 既有用例）

- [ ] **步骤 6：Commit**

```bash
git add packages/frontend/src/store/session.ts packages/frontend/tests/store-session.test.ts
git commit -m "feat(frontend): store 写回整轮耗时并保留 setMessages 合并字段"
```

---

### 任务 5：新增 TurnSummary 组件 + formatElapsed

**文件：**

- 创建：`packages/frontend/src/components/blocks/TurnSummary.tsx`
- 测试：`packages/frontend/tests/TurnSummary.test.tsx`（新建）

- [ ] **步骤 1：编写失败的测试**

创建 `packages/frontend/tests/TurnSummary.test.tsx`：

```tsx
import { test, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { TurnSummary, formatElapsed } from "../src/components/blocks/TurnSummary";

test("formatElapsed：秒/分钟自动切换", () => {
  expect(formatElapsed(0)).toBe("0 秒");
  expect(formatElapsed(45_000)).toBe("45 秒");
  expect(formatElapsed(135_000)).toBe("2 分 15 秒");
});

test("TurnSummary：有时长显示本轮时长 + 步骤数", () => {
  render(<TurnSummary steps={3} elapsedMs={135_000}>过程</TurnSummary>);
  expect(screen.getByText("本轮时长 2 分 15 秒 · 3 个步骤")).toBeTruthy();
});

test("TurnSummary：无时长显示本轮过程 + 步骤数", () => {
  render(<TurnSummary steps={2}>过程</TurnSummary>);
  expect(screen.getByText("本轮过程 · 2 个步骤")).toBeTruthy();
});

test("TurnSummary：默认折叠，点击展开 children，再点折叠", () => {
  render(<TurnSummary steps={1}>卡片内容</TurnSummary>);
  expect(screen.queryByText("卡片内容")).toBeNull();
  fireEvent.click(screen.getByTestId("turn-summary"));
  expect(screen.getByText("卡片内容")).toBeTruthy();
  fireEvent.click(screen.getByTestId("turn-summary"));
  expect(screen.queryByText("卡片内容")).toBeNull();
});

test("TurnSummary：aria-expanded 随状态切换", () => {
  render(<TurnSummary steps={1}>过程</TurnSummary>);
  const btn = screen.getByTestId("turn-summary");
  expect(btn.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(btn);
  expect(btn.getAttribute("aria-expanded")).toBe("true");
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd packages/frontend && bun test tests/TurnSummary.test.tsx`
预期：FAIL（模块不存在：`Cannot find module '../src/components/blocks/TurnSummary'`）

- [ ] **步骤 3：实现组件**

创建 `packages/frontend/src/components/blocks/TurnSummary.tsx`：

```tsx
import { useState } from "react";

/** 时长格式化：<60s → "45 秒"；>=60s → "2 分 15 秒" */
export function formatElapsed(ms: number): string {
 const totalSec = Math.max(0, Math.floor(ms / 1000));
 if (totalSec < 60) return `${totalSec} 秒`;
 const min = Math.floor(totalSec / 60);
 const sec = totalSec % 60;
 return `${min} 分 ${sec} 秒`;
}

/**
 * 轮级折叠摘要行：一轮完成后，中间过程（思考/工具调用/delegate/fleet）折叠为一行。
 * 折叠态显示「本轮时长 X · N 个步骤」（无时长显示「本轮过程 · N 个步骤」），
 * 点击展开显示 children（各过程卡片，可再逐个展开）。仅用于已定稿行。
 */
export function TurnSummary({ steps, elapsedMs, children }: {
 steps: number;
 elapsedMs?: number;
 children: React.ReactNode;
}) {
 const [open, setOpen] = useState(false);
 return (
  <div className="flex flex-col gap-1">
   <button
    type="button"
    aria-expanded={open}
    onClick={() => setOpen((v) => !v)}
    className="w-full flex items-center gap-2 text-[11px] text-tertiary select-none"
    data-testid="turn-summary"
   >
    <span className="flex-1 border-t border-hairline" />
    <span className="whitespace-nowrap">
     {elapsedMs != null
      ? `本轮时长 ${formatElapsed(elapsedMs)} · ${steps} 个步骤`
      : `本轮过程 · ${steps} 个步骤`}
    </span>
    <span className="flex-1 border-t border-hairline" />
   </button>
   {open && <div className="flex flex-col gap-1">{children}</div>}
  </div>
 );
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`cd packages/frontend && bun test tests/TurnSummary.test.tsx`
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add packages/frontend/src/components/blocks/TurnSummary.tsx packages/frontend/tests/TurnSummary.test.tsx
git commit -m "feat(frontend): 新增轮级折叠摘要行 TurnSummary + formatElapsed"
```

---

### 任务 6：MessageList 集成——已定稿含过程段的行折叠为摘要行

**文件：**

- 修改：`packages/frontend/src/components/MessageList.tsx`（MessageRow）
- 测试：`packages/frontend/tests/MessageList.test.tsx`

- [ ] **步骤 1：编写失败的测试**

在 `packages/frontend/tests/MessageList.test.tsx` 末尾追加（沿用该文件已有的 store 状态构造方式）：

```tsx
// ── 轮级折叠摘要行 ────────────────────────────────────────────────────────

function assistantMsgWithExtras(content: any[], ts: number, extra: any = {}) {
  return { message: { role: "assistant", content, timestamp: ts, stopReason: "end_turn", ...extra }, agentName: "dev" };
}

test("已定稿含过程段的行：折叠为摘要行，text 保留，点击展开可见过程段", async () => {
  useSessionStore.setState({
    messagesBySession: { s1: [
      { message: { role: "user", content: [{ type: "text", text: "问题" }], timestamp: 1 }, agentName: "dev" },
      assistantMsgWithExtras([
        { type: "thinking", thinking: "思考中" },
        { type: "toolCall", id: "t1", name: "read", arguments: { path: "/tmp/a" } },
        { type: "text", text: "最终回复" },
      ], 2),
    ] },
    streamingBySession: { s1: null },
  });
  render(<MessageList sessionId="s1" />);

  // 折叠态：摘要行出现、text 保留、过程段不直接可见
  expect(screen.getByTestId("turn-summary")).toBeTruthy();
  expect(screen.getByText("最终回复")).toBeTruthy();
  expect(screen.queryByText("思考中")).toBeNull();
  expect(screen.queryByText("read")).toBeNull();

  // 点击展开：过程段可见
  fireEvent.click(screen.getByTestId("turn-summary"));
  expect(screen.getByText("思考中")).toBeTruthy();
  expect(screen.getByText("read")).toBeTruthy();
});

test("有时长的轮：摘要行显示本轮时长 + 步骤数", () => {
  useSessionStore.setState({
    messagesBySession: { s1: [
      { message: { role: "user", content: [{ type: "text", text: "问题" }], timestamp: 1 }, agentName: "dev" },
      assistantMsgWithExtras([
        { type: "toolCall", id: "t1", name: "read", arguments: { path: "/tmp/a" } },
        { type: "text", text: "最终回复" },
      ], 5000, { turnElapsedMs: 4000 }),
    ] },
    streamingBySession: { s1: null },
  });
  render(<MessageList sessionId="s1" />);
  expect(screen.getByText("本轮时长 4 秒 · 1 个步骤")).toBeTruthy();
});

test("纯文本行：无摘要行", () => {
  useSessionStore.setState({
    messagesBySession: { s1: [
      { message: { role: "user", content: [{ type: "text", text: "问题" }], timestamp: 1 }, agentName: "dev" },
      assistantMsgWithExtras([{ type: "text", text: "纯文本回复" }], 2),
    ] },
    streamingBySession: { s1: null },
  });
  render(<MessageList sessionId="s1" />);
  expect(screen.queryByTestId("turn-summary")).toBeNull();
  expect(screen.getByText("纯文本回复")).toBeTruthy();
});

test("多段 text 的轮：只保留最后一段 text 在外，中间 text 折叠进摘要行", () => {
  useSessionStore.setState({
    messagesBySession: { s1: [
      { message: { role: "user", content: [{ type: "text", text: "问题" }], timestamp: 1 }, agentName: "dev" },
      assistantMsgWithExtras([
        { type: "thinking", thinking: "思考中" },
        { type: "toolCall", id: "t1", name: "read", arguments: { path: "/tmp/a" } },
        { type: "text", text: "中间的过渡文字" },
        { type: "text", text: "最终回复" },
      ], 2),
    ] },
    streamingBySession: { s1: null },
  });
  render(<MessageList sessionId="s1" />);
  // 折叠态：摘要行出现、只有最后一段 text 可见、中间 text 与过程段不可见
  expect(screen.getByTestId("turn-summary")).toBeTruthy();
  expect(screen.getByText("最终回复")).toBeTruthy();
  expect(screen.queryByText("中间的过渡文字")).toBeNull();
  expect(screen.queryByText("思考中")).toBeNull();
  // 展开后：中间 text 与过程段可见
  fireEvent.click(screen.getByTestId("turn-summary"));
  expect(screen.getByText("中间的过渡文字")).toBeTruthy();
  expect(screen.getByText("思考中")).toBeTruthy();
});

test("进行中的轮（status=thinking）最后一行不折叠，即使已定稿", () => {
  useSessionStore.setState({
    statusBySession: { s1: "thinking" },
    messagesBySession: { s1: [
      { message: { role: "user", content: [{ type: "text", text: "问题" }], timestamp: 1 }, agentName: "dev" },
      assistantMsgWithExtras([
        { type: "thinking", thinking: "思考中" },
        { type: "toolCall", id: "t1", name: "read", arguments: { path: "/tmp/a" } },
        { type: "text", text: "部分回复" },
      ], 2),
    ] },
    streamingBySession: { s1: null },
  });
  render(<MessageList sessionId="s1" />);
  // 轮未结束：不折叠，过程段直接可见（保持逐卡流式渲染），无摘要行
  expect(screen.queryByTestId("turn-summary")).toBeNull();
  expect(screen.getByText("思考中")).toBeTruthy();
  expect(screen.getByText("部分回复")).toBeTruthy();
});

test("进行中的轮：更早的已完成轮仍折叠", () => {
  useSessionStore.setState({
    statusBySession: { s1: "thinking" },
    messagesBySession: { s1: [
      { message: { role: "user", content: [{ type: "text", text: "问题一" }], timestamp: 1 }, agentName: "dev" },
      assistantMsgWithExtras([
        { type: "toolCall", id: "t1", name: "read", arguments: { path: "/tmp/a" } },
        { type: "text", text: "第一轮回复" },
      ], 2, { turnElapsedMs: 1000 }),
      { message: { role: "user", content: [{ type: "text", text: "问题二" }], timestamp: 3 }, agentName: "dev" },
      assistantMsgWithExtras([
        { type: "thinking", thinking: "第二轮思考中" },
        { type: "text", text: "第二轮部分回复" },
      ], 4),
    ] },
    streamingBySession: { s1: null },
  });
  render(<MessageList sessionId="s1" />);
  // 第一轮（已完成，非最后一行）：折叠，显示摘要行；第二轮（进行中末行）：不折叠
  expect(screen.getAllByTestId("turn-summary")).toHaveLength(1);
  expect(screen.getByText("第二轮思考中")).toBeTruthy();
  // 第一轮过程段不可见（折叠中）
  expect(screen.queryByText("read")).toBeNull();
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd packages/frontend && bun test tests/MessageList.test.tsx`
预期：新增 3 个用例 FAIL（`turn-summary` 不存在）

- [ ] **步骤 3：实现折叠逻辑**

`packages/frontend/src/components/MessageList.tsx` MessageRow：

a) 顶部 import 加：

```tsx
import { TurnSummary } from "./blocks/TurnSummary";
```

b) `hasProcessCard` 计算之后、`return (` 之前，加折叠判定与分组（**含整轮完成时机 + 只留最后一段 text 两个修正**）：

```tsx
 // 轮级折叠：整轮已完成（非流式 + 非「进行中轮的末行」）+ 含过程段 →
 // 过程段与中间 text 段折叠为摘要行，只保留最后一段 text 回复在外。
 // 进行中轮（status==="thinking"）的最后一条已定稿 assistant 行即使已定稿
 // （长工具执行间隙 streaming 为空）也不折叠——必须等 agent_end 整轮结束。
 const isActiveTurnRow =
  status === "thinking" &&
  /* 该行是当前渲染列表的最后一条已定稿 assistant 行（非 streaming） */
  isLastFinalizedAssistantRow;
 const canCollapse = hasProcessCard && !isStreaming && !isActiveTurnRow;
 // 折叠内容：除最后一段 text 外的所有段（过程段 + 中间 text）
 const processSegs = segments.filter((s, i) => i !== lastTextSegIdx);
 // 保留在外：最后一段 text（最终回复）；纯过程轮无 text 则全折叠
 const finalTextSeg = lastTextSegIdx >= 0 ? segments[lastTextSegIdx] : undefined;
```

**isLastFinalizedAssistantRow 的判定（在 MessageList 主组件层实现）：** 渲染 rows 时，对每条 assistant 行判断其是否为「当前渲染列表的最后一条已定稿 assistant 行」——即：`session status === "thinking"` 时，消息列表最后一条已定稿 assistant（不含 streaming 占位）所在的行。由 MessageList 主组件计算并作为 prop 传入 MessageRow（如 `isActiveTurnRow`），MessageRow 内不再自行推导。历史加载（status 非 thinking）时恒为 false（全部可折叠）。

渲染部分（替换原 map）——折叠分支：`processSegs` 包进 TurnSummary（steps=processSegs 中非 text 段数量，即过程段数；中间 text 不计步骤），`finalTextSeg` 保留在外：

```tsx
    {canCollapse ? (
     <>
      <TurnSummary steps={processSteps} elapsedMs={m.turnElapsedMs}>
       {processSegs.map((seg, si) => renderSeg(seg, si, false))}
      </TurnSummary>
      {finalTextSeg && renderSeg(finalTextSeg, processSegs.length, false)}
     </>
    ) : (
     segments.map((seg, si) =>
      renderSeg(
       seg,
       si,
       isStreaming &&
        (row.streamingStartIdx == null ||
         seg.firstBlockIdx >= row.streamingStartIdx),
      ),
     )
    )}
```

其中 `processSteps = segments.filter((s) => s.kind !== "text").length`（过程段数量，text 不计——中间 text 折叠进摘要但不算步骤）。

c) 在 MessageRow 内（`fullText`/`lastTextSegIdx`/`isError` 计算之后、`return (` 之前）新增组件内函数 `renderSeg`——把原 map 内的分发逻辑整体搬移（thinking/toolCalls/delegate/fleet/text 各分支原样保留，仅把 key 改为参数、CopyButton 的 `si === lastTextSegIdx` 判断改为引用比较）：

```tsx
 const renderSeg = (seg: Segment, key: number, segIsStreaming: boolean) => {
  // 思考过程 — ProcessCard：每段独立成卡（不合并），区分 finalized vs streaming
  if (seg.kind === "thinking") {
   return (
    <ThinkingCard
     key={key}
     thinking={seg.texts.join("\n")}
     isStreaming={segIsStreaming}
    />
   );
  }
  // 工具调用 — ProcessCard：>1 个连续调用归成组卡，单工具直接单卡
  if (seg.kind === "toolCalls") {
   return (
    <ToolGroupCard
     key={key}
     toolCalls={seg.calls}
     results={row.toolResults}
     isStreaming={segIsStreaming}
    />
   );
  }
  // 委派调用 — 内联卡片（不进工具分组，与普通内容穿插）
  if (seg.kind === "delegate") {
   return (
    <DelegateCard
     key={seg.call.id}
     sessionId={sessionId}
     toolCall={seg.call}
     result={row.toolResults.get(seg.call.id)}
     isStreaming={segIsStreaming}
    />
   );
  }
  // 并行派发 — 内联卡片（FleetCard 展示多个子任务）
  if (seg.kind === "fleet") {
   return (
    <FleetCard
     key={seg.call.id}
     sessionId={sessionId}
     toolCall={seg.call}
     result={row.toolResults.get(seg.call.id)}
     isStreaming={segIsStreaming}
    />
   );
  }
  // 主回复内容 — 文字 + markdown
  return (
   <div
    key={key}
    className="flex flex-col gap-1"
    data-testid="text-bubble"
   >
    <div
     className={`text-[13.5px] px-3.5 py-2.5 bg-surface border border-hairline shadow-sm ${isError ? "text-danger" : "text-primary"}`}
     style={{ lineHeight: 1.55, borderRadius: "4px 14px 14px 14px" }}
    >
     {seg.texts.map((text, i) => (
      <MarkdownBlock
       key={seg.blockIdxs[i]}
       text={text}
       sessionId={sessionId}
      />
     ))}
    </div>
    {seg === segments[lastTextSegIdx] && (
     <div className="flex justify-end">
      <CopyButton
       text={fullText}
       testId={`copy-${sessionId}-${m.timestamp}`}
      />
     </div>
    )}
   </div>
  );
 };
```

d) 把原 `{segments.map((seg, si) => { ... })}` 整体替换为（折叠分支中 `segIsStreaming` 恒 false，因 `canCollapse` 要求 `!isStreaming`）：

```tsx
    {canCollapse ? (
     <>
      <TurnSummary steps={processSegs.length} elapsedMs={m.turnElapsedMs}>
       {processSegs.map((seg, si) => renderSeg(seg, si, false))}
      </TurnSummary>
      {textSegs.map((seg, si) => renderSeg(seg, si + processSegs.length, false))}
     </>
    ) : (
     segments.map((seg, si) =>
      renderSeg(
       seg,
       si,
       isStreaming &&
        (row.streamingStartIdx == null ||
         seg.firstBlockIdx >= row.streamingStartIdx),
      ),
     )
    )}
```

注：`Segment` 类型已在 MessageList.tsx 定义（`type Segment = ...`）；`m` 为 `row.main.message as any`，`m.turnElapsedMs` 即消息字段；`MarkdownBlock`/`CopyButton` 为 MessageRow 内已有引用。`lastTextSegIdx` 仍是原 segments 中最后一个 text 段的 index，用引用比较 `seg === segments[lastTextSegIdx]` 判定 CopyButton 归属，与折叠/非折叠分支均兼容。

- [ ] **步骤 4：运行测试确认通过**

运行：`cd packages/frontend && bun test tests/MessageList.test.tsx`
预期：全部 PASS（新增 3 个 + 既有用例，无回归）

- [ ] **步骤 5：Commit**

```bash
git add packages/frontend/src/components/MessageList.tsx packages/frontend/tests/MessageList.test.tsx
git commit -m "feat(frontend): MessageList 已定稿行折叠过程段为轮级摘要行"
```

---

### 任务 7：CHANGELOG + 全量验证

**文件：**

- 修改：`CHANGELOG.md`

- [ ] **步骤 1：更新 CHANGELOG**

在 `CHANGELOG.md` 顶部（`---` 之后）新增条目：

```markdown
## 2026-08-01

### 新增功能

- **轮级折叠摘要行 + 整轮耗时**：一轮 agent 调用完成后，中间过程（思考/工具调用/delegate/fleet）二次折叠为一行摘要「本轮时长 X · N 个步骤」（无时长显示「本轮过程 · N 个步骤」），点击展开可见各步骤并可再逐个展开；最终文本回复始终保留在外。时长从消息时间戳纯读推算（最后 assistant.timestamp − user.timestamp），零写入、刷新后历史轮也能还原；仅成功完成的轮显示时长（失败回合/无 user/旧数据缺字段不显示）。流式中不折叠，保持逐卡流式渲染。
  - 影响范围：`packages/shared/src/types.ts`（`AssistantMessage.turnElapsedMs?`、`SDKEvent.agent_end.elapsedMs?`）、`packages/kernel`（`session-history.ts` 按轮切分注入、`agent-manager.ts` agent_end 附加 elapsedMs）、`packages/frontend`（store agent_end 写回、`MessageList` 行级折叠、新增 `blocks/TurnSummary.tsx`）。
  - 验证：kernel session-history/agent-manager 新增用例全绿；前端 TurnSummary/MessageList/store-session 新增用例全绿；`typecheck` 通过。
```

- [ ] **步骤 2：typecheck**

运行：`cd /h/workspace/hiagent && bun run typecheck`
预期：全部 PASS

- [ ] **步骤 3：全量测试**

运行：`cd /h/workspace/hiagent && bun run test`
预期：kernel / shared / desktop / frontend 各包全部 PASS（既有基线 + 新增用例）

- [ ] **步骤 4：Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG 记录轮级折叠摘要行 + 整轮耗时"
```
