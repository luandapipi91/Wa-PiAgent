# ask_user_question 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 wa-pi 的 agent 能在任务中调用 `ask_user_question` 工具向用户提出结构化澄清问题，前端在 composer 上方停靠表单完成人机交互。

**Architecture:** 用 Pi SDK 的 `defineTool()` + `createAgentSession({ customTools })` 原生定义工具（schema/返回与 `@juicesharp/rpiv-ask-user-question` 对齐，不安装该 TUI 包）。问答复用现有 tool-call/tool-result 事件管道：工具 `execute` 在内核 `AskRegistry` 上 `await` 阻塞；前端从 `messagesBySession` 派生 pending 提问渲染表单，提交经新 `agent:answer` WS 事件直达 registry resolve。

**Tech Stack:** TypeScript · Bun（kernel + 测试 `bun:test`）· React 19 + Zustand + Tailwind（frontend）· `@earendil-works/pi-coding-agent` SDK（`defineTool`/`customTools`/`ToolDefinition`，`execute(toolCallId, params, signal, onUpdate, ctx)`）· TypeBox（`parameters` schema）· react-markdown（preview 渲染）。

## Global Constraints

- **不设硬超时**：提问等待用户回答 / 取消 / abort，无自动超时。
- **v1 非目标**：不做 `kind:"chat"` 重定向、i18n、Submit-review 审阅 tab、per-option notes（用 per-question 备注）。
- **队列兼容**：`agent:answer`/`agent:cancel-ask` 直达 `AskRegistry`，不经 steer/followUp 队列；中断类（abort/immediate）同步 `askRegistry.cancelAll(sessionId)` 作废提问；pending 时 composer 禁用。
- **customTools 合并**：本特性的 ask 工具与并行 memory 重构（`docs/superpowers/plans/2026-07-11-memory-project-scope.md`）在 `createAgentSession({ customTools: [...] })` 同一数组里合并，互不冲突——两者各自 `defineTool` 后 push 进数组。
- **工具白名单**：`createAgentSession` 的 `tools` 是白名单，必须把 `"ask_user_question"` 加进 `DEFAULT_AGENT_TOOLS`（[constants.ts:43-57](../../packages/shared/src/constants.ts)），否则被过滤。
- **代码风格**：禁止 `console.log` 进生产；immutability（spread，不就地改）；显式 public API 类型；`unknown` + 类型收窄而非 `any`（桥接 SDK 处可 `as any`，与现有 `agent-manager.ts` 一致）。UI 文案中文。
- **测试**：`bun:test`，TDD（先红后绿），每个 task 末尾 commit。kernel 测试命令 `cd packages/kernel && bun test`；frontend `cd packages/frontend && bun test`；shared `cd packages/shared && bun test`。typecheck `bun run typecheck`。

## File Structure

**新增：**
- `packages/shared/src/ask.ts` — 类型（`AskOption`/`AskQuestion`/`AskParams`/`AskAnswer`/`AskReply`/`AskErrorCode`）+ 纯函数（`validateAskParams`、`replyToAnswers`）。
- `packages/kernel/src/ask-registry.ts` — `AskRegistry` 进程单例（ask/resolve/cancel/cancelAll/reset，signal 监听，幂等）。
- `packages/kernel/src/ask-tool.ts` — `makeAskTool(sessionId)`（`defineTool`）+ `reconcileDanglingAsks(messages)`（重启兜底纯函数）。
- `packages/frontend/src/store/ask.ts` — 纯选择器 `selectPendingAsks` / `selectEffectiveStatus` + hook `usePendingAsks`。
- `packages/frontend/src/components/ask/AskFormCard.tsx` — 表单组件（单/多选、preview、per-question 备注、Other、提交/取消、submitting）。
- `packages/frontend/src/components/ask/AskDock.tsx` — 停靠容器，把 pendingAsks 映射成 `AskFormCard`。

**修改：**
- `packages/shared/src/types.ts` — 加 `AskAnswerEvent`/`AskCancelAskEvent`，并入 `WSClientEvent`。
- `packages/shared/src/constants.ts` — `DEFAULT_AGENT_TOOLS` 加 `"ask_user_question"`。
- `packages/shared/src/index.ts` — `export * from "./ask"`。
- `packages/kernel/src/agent-manager.ts` — `CreateAgentSessionFn` 加 `customTools?`；`_createSession` 构造 ask 工具并入 `customTools` 并调 `reconcileDanglingAsks`；`abort`/`_jumpQueue`/`_teardownSession` 调 `cancelAll`。
- `packages/kernel/src/ws-server.ts` — switch 加 `agent:answer` / `agent:cancel-ask`。
- `packages/frontend/src/components/SessionView.tsx` — 渲染 `<AskDock>`，`isBlocked` 状态，队列面板在 blocked 时也显示「停止」。
- `packages/frontend/src/components/Composer.tsx` — 加 `disabled` prop。
- `packages/frontend/src/components/ui/ComposerInput.tsx` — 加 `disabled` prop（textarea 禁用）。
- `packages/frontend/src/components/MessageList.tsx` — `ToolCallBlock` 对 `ask_user_question` 用「问答」label。

---

## Task 1: Shared — ask 类型 + 校验 + 协议接线

**Files:**
- Create: `packages/shared/src/ask.ts`
- Modify: `packages/shared/src/types.ts`（`WSClientEvent` 联合，第 245-258 行）
- Modify: `packages/shared/src/constants.ts`（`DEFAULT_AGENT_TOOLS`，第 43-57 行）
- Modify: `packages/shared/src/index.ts`（第 1-8 行 export 列表）
- Test: `packages/shared/tests/ask.test.ts`

**Interfaces:**
- Produces: `AskOption`、`AskQuestion`、`AskParams`、`AskAnswer`、`AskReply`、`AskErrorCode`、`ASK_RESERVED_LABELS`、`validateAskParams(params): AskErrorCode | null`、`replyToAnswers(params, reply): AskAnswer[]`、`AskAnswerEvent`、`AskCancelAskEvent`。后续 task 的 kernel/前端均 import 这些。

- [ ] **Step 1: 写失败测试 `packages/shared/tests/ask.test.ts`**

```ts
import { test, expect } from "bun:test";
import {
  validateAskParams, replyToAnswers, ASK_RESERVED_LABELS,
  type AskParams, type AskReply,
} from "../src/ask";

const okParams: AskParams = {
  questions: [
    { question: "用哪个方案?", header: "方案", options: [
      { label: "A", description: "甲" }, { label: "B", description: "乙" } ] },
  ],
};

test("validateAskParams: 合法参数返回 null", () => {
  expect(validateAskParams(okParams)).toBeNull();
});

test("validateAskParams: questions 缺失 → no_questions", () => {
  expect(validateAskParams({})).toBe("no_questions");
  expect(validateAskParams({ questions: [] })).toBe("no_questions");
});

test("validateAskParams: questions > 4 → too_many_questions", () => {
  const qs = Array.from({ length: 5 }, (_, i) => ({
    question: `Q${i}?`, header: "h", options: [{ label: "A", description: "x" }, { label: "B", description: "y" }],
  }));
  expect(validateAskParams({ questions: qs })).toBe("too_many_questions");
});

test("validateAskParams: options < 2 → empty_options；> 4 → too_many_options", () => {
  expect(validateAskParams({ questions: [{ question: "Q?", header: "h", options: [{ label: "A", description: "x" }] }] })).toBe("empty_options");
  const opts = Array.from({ length: 5 }, (_, i) => ({ label: `O${i}`, description: "x" }));
  expect(validateAskParams({ questions: [{ question: "Q?", header: "h", options: opts }] })).toBe("too_many_options");
});

test("validateAskParams: 重复问题文本 → duplicate_question", () => {
  const p: AskParams = { questions: [
    { question: "Same?", header: "h", options: [{ label: "A", description: "x" }, { label: "B", description: "y" }] },
    { question: "Same?", header: "h", options: [{ label: "C", description: "x" }, { label: "D", description: "y" }] },
  ] };
  expect(validateAskParams(p)).toBe("duplicate_question");
});

test("validateAskParams: 同问内重复 option label → duplicate_option_label", () => {
  const p: AskParams = { questions: [{ question: "Q?", header: "h", options: [
    { label: "A", description: "x" }, { label: "A", description: "y" }] }] };
  expect(validateAskParams(p)).toBe("duplicate_option_label");
});

test("validateAskParams: 保留 label（Other / sentinels）→ reserved_label", () => {
  for (const bad of ASK_RESERVED_LABELS) {
    const p = { questions: [{ question: "Q?", header: "h", options: [
      { label: bad, description: "x" }, { label: "ok", description: "y" }] }] };
    expect(validateAskParams(p)).toBe("reserved_label");
  }
});

test("replyToAnswers: 单选 → option；多选 → multi；含 customText → custom", () => {
  const params: AskParams = { questions: [
    { question: "单?", header: "h", options: [{ label: "A", description: "x" }, { label: "B", description: "y" }] },
    { question: "多?", header: "h", multiSelect: true, options: [{ label: "A", description: "x" }, { label: "B", description: "y" }] },
    { question: "自?", header: "h", options: [{ label: "A", description: "x" }, { label: "B", description: "y" }] },
  ] };
  const reply: AskReply = { replies: [
    { questionIndex: 0, selected: ["A"] },
    { questionIndex: 1, selected: ["A", "B"] },
    { questionIndex: 2, selected: [], customText: "随便说" },
  ] };
  const answers = replyToAnswers(params, reply);
  expect(answers).toHaveLength(3);
  expect(answers[0]).toMatchObject({ questionIndex: 0, kind: "option", answer: "A" });
  expect(answers[1]).toMatchObject({ questionIndex: 1, kind: "multi", selected: ["A", "B"] });
  expect(answers[2]).toMatchObject({ questionIndex: 2, kind: "custom", answer: "随便说" });
});

test("replyToAnswers: notes 透传（空白去掉）", () => {
  const params: AskParams = { questions: [{ question: "Q?", header: "h", options: [{ label: "A", description: "x" }, { label: "B", description: "y" }] }] };
  const answers = replyToAnswers(params, { replies: [{ questionIndex: 0, selected: ["A"], notes: "  备注  " }] });
  expect(answers[0].notes).toBe("备注");
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd packages/shared && bun test tests/ask.test.ts`
Expected: FAIL — `Cannot find module "../src/ask"`。

- [ ] **Step 3: 实现 `packages/shared/src/ask.ts`**

```ts
// WaPi 结构化问答：类型 + 纯校验/翻译。
// schema/返回对齐 @juicesharp/rpiv-ask-user-question，但仅作协议参考，不安装其 TUI。

/** 单个选项。label 为回传标识；description 给用户看；preview 为可选 markdown。 */
export interface AskOption {
  label: string;
  description: string;
  preview?: string;
}

/** 一个问题。multiSelect 默认 false（单选）。 */
export interface AskQuestion {
  question: string;
  header: string;          // chip 标签，≤16 字符
  options: AskOption[];    // 2-4 个
  multiSelect?: boolean;
}

/** 工具入参 = toolCall.arguments。 */
export interface AskParams {
  questions: AskQuestion[]; // 1-4 个
}

/** 工具返回里 details.answers 的单项。 */
export interface AskAnswer {
  questionIndex: number;
  question: string;
  kind: "option" | "custom" | "multi";
  answer: string | null;
  selected?: string[];      // multi 时存在
  notes?: string;           // per-question 备注
  preview?: string;
}

/** 前端回传内核的原始选择（经 WS agent:answer）。 */
export interface AskReply {
  replies: Array<{
    questionIndex: number;
    selected: string[];       // 选中的 option label；多选可多个；Other 时通常为空
    customText?: string;      // 「其他」自由文本；非空 → kind:"custom"
    notes?: string;           // per-question 备注
  }>;
}

/** 校验错误码（镜像原包 details.error）。 */
export type AskErrorCode =
  | "no_questions" | "too_many_questions" | "empty_options" | "too_many_options"
  | "duplicate_question" | "duplicate_option_label" | "reserved_label";

/** 保留标签：禁止作为 option label（与原包一致）。 */
export const ASK_RESERVED_LABELS = new Set(["Other", "Type something.", "Chat about this", "Next →"]);

/** 校验工具入参。合法返回 null，否则返回首个命中错误码。 */
export function validateAskParams(params: unknown): AskErrorCode | null {
  if (!params || typeof params !== "object") return "no_questions";
  const { questions } = params as { questions?: unknown };
  if (!Array.isArray(questions) || questions.length < 1) return "no_questions";
  if (questions.length > 4) return "too_many_questions";

  const seenQuestions = new Set<string>();
  for (const q of questions as any[]) {
    if (!q || typeof q.question !== "string" || !q.question.trim()) return "no_questions";
    if (seenQuestions.has(q.question)) return "duplicate_question";
    seenQuestions.add(q.question);
    if (!Array.isArray(q.options) || q.options.length < 2) return "empty_options";
    if (q.options.length > 4) return "too_many_options";
    const seenOptions = new Set<string>();
    for (const o of q.options as any[]) {
      if (!o || typeof o.label !== "string" || !o.label.trim()) return "empty_options";
      if (ASK_RESERVED_LABELS.has(o.label)) return "reserved_label";
      if (seenOptions.has(o.label)) return "duplicate_option_label";
      seenOptions.add(o.label);
    }
  }
  return null;
}

/** 把前端 AskReply 翻译成 details.answers。 */
export function replyToAnswers(params: AskParams, reply: AskReply): AskAnswer[] {
  return reply.replies.map((r) => {
    const q = params.questions[r.questionIndex];
    const isCustom = typeof r.customText === "string" && r.customText.trim().length > 0;
    const isMulti = q?.multiSelect === true;
    const kind: AskAnswer["kind"] = isCustom ? "custom" : isMulti ? "multi" : "option";
    const notes = typeof r.notes === "string" && r.notes.trim() ? r.notes.trim() : undefined;
    return {
      questionIndex: r.questionIndex,
      question: q?.question ?? "",
      kind,
      answer: isCustom ? r.customText!.trim() : (r.selected[0] ?? null),
      selected: isMulti ? r.selected : undefined,
      notes,
    } satisfies AskAnswer;
  });
}
```

- [ ] **Step 4: 接线 `packages/shared/src/types.ts`（WSClientEvent 追加两个事件）**

在 `WSClientEvent` 联合（第 245-258 行）上方加两个 interface，并在联合里追加：

```ts
// ask_user_question 应答（client → kernel），直达 AskRegistry，不经 steer/followUp 队列
export interface AskAnswerEvent {
  type: "agent:answer";
  sessionId: string;
  toolCallId: string;
  reply: AskReply;
}
export interface AskCancelAskEvent {
  type: "agent:cancel-ask";
  sessionId: string;
  toolCallId: string;
}
```

`AskReply` 由 `./ask` 导出；在 `types.ts` 顶部加 `import type { AskReply } from "./ask";`。然后把 `AskAnswerEvent | AskCancelAskEvent` 加进 `WSClientEvent` 联合（紧跟 `AbortEvent` 之后即可）。

- [ ] **Step 5: 接线 `packages/shared/src/constants.ts`**

在 `DEFAULT_AGENT_TOOLS` 数组（第 43-57 行）末尾 `"session_search"` 后加一行 `"ask_user_question",`。

- [ ] **Step 6: 接线 `packages/shared/src/index.ts`**

在 export 列表加 `export * from "./ask";`。

- [ ] **Step 7: 跑测试确认通过**

Run: `cd packages/shared && bun test tests/ask.test.ts`
Expected: PASS（全部用例）。

- [ ] **Step 8: typecheck**

Run: `cd packages/shared && bun run typecheck`
Expected: 无错误。

- [ ] **Step 9: commit**

```bash
git add packages/shared/src/ask.ts packages/shared/src/types.ts packages/shared/src/constants.ts packages/shared/src/index.ts packages/shared/tests/ask.test.ts
git commit -m "feat(shared): ask_user_question 类型 + 校验 + WS 协议接线"
```

---

## Task 2: Kernel — AskRegistry（阻塞/解决注册表，进程单例）

**Files:**
- Create: `packages/kernel/src/ask-registry.ts`
- Test: `packages/kernel/tests/ask-registry.test.ts`

**Interfaces:**
- Consumes: `AskParams`、`AskReply`、`AskAnswer`、`replyToAnswers` from `@wa-pi/shared`（Task 1）。
- Produces: `class AskRegistry`、`export const askRegistry`（单例）。方法：`ask(sessionId, toolCallId, params, signal): Promise<{ cancelled: boolean; answers?: AskAnswer[] }>`、`resolve(sessionId, toolCallId, reply)`、`cancel(sessionId, toolCallId)`、`cancelAll(sessionId)`、`reset()`。Task 3/4 依赖这些签名。

- [ ] **Step 1: 写失败测试 `packages/kernel/tests/ask-registry.test.ts`**

```ts
import { test, expect, beforeEach } from "bun:test";
import { askRegistry } from "../src/ask-registry";
import type { AskParams } from "@wa-pi/shared";

const params: AskParams = { questions: [
  { question: "Q?", header: "h", options: [{ label: "A", description: "x" }, { label: "B", description: "y" }] },
] };
const reply = { replies: [{ questionIndex: 0, selected: ["A"] }] };

beforeEach(() => askRegistry.reset());

test("ask → resolve 返回 answers（cancelled=false）", async () => {
  const ctrl = new AbortController();
  const p = askRegistry.ask("s1", "tc1", params, ctrl.signal);
  askRegistry.resolve("s1", "tc1", reply);
  const r = await p;
  expect(r.cancelled).toBe(false);
  expect(r.answers).toHaveLength(1);
  expect(r.answers![0]).toMatchObject({ kind: "option", answer: "A" });
});

test("ask → cancel 返回 cancelled=true", async () => {
  const ctrl = new AbortController();
  const p = askRegistry.ask("s1", "tc1", params, ctrl.signal);
  askRegistry.cancel("s1", "tc1");
  expect((await p).cancelled).toBe(true);
});

test("abort signal 触发 → cancelled=true", async () => {
  const ctrl = new AbortController();
  const p = askRegistry.ask("s1", "tc1", params, ctrl.signal);
  ctrl.abort();
  expect((await p).cancelled).toBe(true);
});

test("resolve / cancel 对未知或已解决 toolCallId 幂等 no-op", () => {
  // 不应抛错
  askRegistry.resolve("unknown", "tc", reply);
  askRegistry.cancel("unknown", "tc");
  // 已解决再 resolve/cancel 无副作用
  const ctrl = new AbortController();
  const p = askRegistry.ask("s1", "tc1", params, ctrl.signal);
  askRegistry.resolve("s1", "tc1", reply);
  askRegistry.resolve("s1", "tc1", reply);  // 重复
  askRegistry.cancel("s1", "tc1");
  return expect(p).resolves.toMatchObject({ cancelled: false });
});

test("cancelAll 取消该 session 全部 pending（不影响其它 session）", async () => {
  const c1 = new AbortController(), c2 = new AbortController();
  const pA = askRegistry.ask("s1", "a", params, c1.signal);
  const pB = askRegistry.ask("s1", "b", params, c2.signal);
  const pC = askRegistry.ask("s2", "c", params, new AbortController().signal);
  askRegistry.cancelAll("s1");
  expect((await pA).cancelled).toBe(true);
  expect((await pB).cancelled).toBe(true);
  // s2 不受影响，仍可正常 resolve
  askRegistry.resolve("s2", "c", reply);
  expect((await pC).cancelled).toBe(false);
});

test("同 session 并发多个 toolCallId 互不干扰", async () => {
  const a = askRegistry.ask("s1", "a", params, new AbortController().signal);
  const b = askRegistry.ask("s1", "b", params, new AbortController().signal);
  askRegistry.resolve("s1", "b", reply);
  expect((await b).cancelled).toBe(false);
  askRegistry.cancel("s1", "a");
  expect((await a).cancelled).toBe(true);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd packages/kernel && bun test tests/ask-registry.test.ts`
Expected: FAIL — `Cannot find module "../src/ask-registry"`。

- [ ] **Step 3: 实现 `packages/kernel/src/ask-registry.ts`**

```ts
// AskRegistry：ask_user_question 工具的阻塞/解决注册表（进程级单例）。
//
// 工具 execute 在此 await ask()，agent 回合阻塞；前端 agent:answer 经 ws-server
// 调 resolve()，agent:cancel-ask / abort / immediate / dispose 调 cancel()/cancelAll()。
// 不设硬超时——等用户回答或中断。所有 resolve/cancel 对未知/已解决 id 幂等。
import { replyToAnswers, type AskParams, AskReply, AskAnswer } from "@wa-pi/shared";

export interface AskOutcome {
  cancelled: boolean;
  answers?: AskAnswer[];
}

interface Entry {
  params: AskParams;
  resolve: (o: AskOutcome) => void;
  onAbort: () => void;
  done: boolean;
}

export class AskRegistry {
  private bySession = new Map<string, Map<string, Entry>>();

  /** 注册一个 pending 提问并返回阻塞 promise。signal abort 时以 cancelled 解决。 */
  ask(sessionId: string, toolCallId: string, params: AskParams, signal: AbortSignal): Promise<AskOutcome> {
    const entry: Entry = { params, resolve: () => {}, onAbort: () => {}, done: false };
    const promise = new Promise<AskOutcome>((resolve) => {
      entry.resolve = (o) => { if (entry.done) return; entry.done = true; this.remove(sessionId, toolCallId); resolve(o); };
      entry.onAbort = () => entry.resolve({ cancelled: true });
    });
    if (signal.aborted) entry.resolve({ cancelled: true });
    else signal.addEventListener("abort", entry.onAbort, { once: true });

    let inner = this.bySession.get(sessionId);
    if (!inner) { inner = new Map(); this.bySession.set(sessionId, inner); }
    inner.set(toolCallId, entry);
    return promise;
  }

  /** 用户提交：翻译 AskReply → answers，以 cancelled=false 解决。幂等。 */
  resolve(sessionId: string, toolCallId: string, reply: AskReply): void {
    const entry = this.bySession.get(sessionId)?.get(toolCallId);
    if (!entry) return;
    entry.resolve({ cancelled: false, answers: replyToAnswers(entry.params, reply) });
  }

  /** 取消单个提问。幂等。 */
  cancel(sessionId: string, toolCallId: string): void {
    this.bySession.get(sessionId)?.get(toolCallId)?.resolve({ cancelled: true });
  }

  /** 取消该 session 全部 pending（abort / immediate / dispose 用）。其它 session 不受影响。 */
  cancelAll(sessionId: string): void {
    const inner = this.bySession.get(sessionId);
    if (!inner) return;
    for (const entry of [...inner.values()) entry.resolve({ cancelled: true });
  }

  /** 测试用：清空全部状态。 */
  reset(): void {
    for (const inner of this.bySession.values()) {
      for (const e of inner.values()) e.onAbort = () => {};  // 解除监听引用
    }
    this.bySession.clear();
  }

  private remove(sessionId: string, toolCallId: string): void {
    const inner = this.bySession.get(sessionId);
    if (!inner) return;
    inner.delete(toolCallId);
    if (inner.size === 0) this.bySession.delete(sessionId);
  }
}

/** 进程级单例。ask-tool / ws-server / agent-manager 共用同一实例。 */
export const askRegistry = new AskRegistry();
```

> 注意：`signal.addEventListener("abort", …, { once: true })` 自动清监听；entry 解决后从 Map 移除，避免泄漏。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/kernel && bun test tests/ask-registry.test.ts`
Expected: PASS（全部）。

- [ ] **Step 5: commit**

```bash
git add packages/kernel/src/ask-registry.ts packages/kernel/tests/ask-registry.test.ts
git commit -m "feat(kernel): AskRegistry 阻塞/解决注册表（ask_user_question）"
```

---

## Task 3: Kernel — ask-tool（defineTool）+ 接入 createAgentSession

**Files:**
- Create: `packages/kernel/src/ask-tool.ts`
- Modify: `packages/kernel/src/agent-manager.ts`（`CreateAgentSessionFn` 类型第 28-38 行；`_createSession` 的 `createFn({...})` 第 307-318 行）
- Test: `packages/kernel/tests/ask-tool.test.ts`

**Interfaces:**
- Consumes: `askRegistry`（Task 2）、`validateAskParams`（Task 1）、SDK `defineTool`/`Type`。
- Produces: `makeAskTool(sessionId): ToolDefinition`、`reconcileDanglingAsks(messages): AgentMessage[]`。`agent-manager` 用 `makeAskTool(sessionId)` 产出工具并并入 `customTools`。

- [ ] **Step 1: 确认 `typebox` 可解析**

Run: `cd packages/kernel && node -e "require('typebox')" 2>/dev/null; bun -e "import('typebox').then(m=>console.log('typebox ok', !!m.Type)).catch(e=>console.log('NEED INSTALL'))"`
Expected: `typebox ok true`。若输出 `NEED INSTALL`：`cd packages/kernel && bun add typebox`（SDK 已依赖，多半已 hoist）。

- [ ] **Step 2: 写失败测试 `packages/kernel/tests/ask-tool.test.ts`**

```ts
import { test, expect, beforeEach } from "bun:test";
import { makeAskTool, reconcileDanglingAsks } from "../src/ask-tool";
import { askRegistry } from "../src/ask-registry";
import type { AskParams } from "@wa-pi/shared";

const validParams: AskParams = { questions: [
  { question: "Q?", header: "h", options: [{ label: "A", description: "x" }, { label: "B", description: "y" }] },
] };

beforeEach(() => askRegistry.reset());

test("makeAskTool: 工具名为 ask_user_question", () => {
  const t = makeAskTool("s1") as any;
  expect(t.name).toBe("ask_user_question");
});

test("execute: 非法 params（无 questions）→ details.error，不注册、不阻塞", async () => {
  const t = makeAskTool("s1") as any;
  const out = await t.execute("tc1", { questions: [] }, new AbortController().signal);
  expect(out.details.error).toBe("no_questions");
  expect(out.details.cancelled).toBe(false);
});

test("execute: 合法 params → 阻塞，resolve 后返回 answers", async () => {
  const t = makeAskTool("s1") as any;
  const p = t.execute("tc1", validParams, new AbortController().signal);
  askRegistry.resolve("s1", "tc1", { replies: [{ questionIndex: 0, selected: ["A"] }] });
  const out = await p;
  expect(out.details.cancelled).toBe(false);
  expect(out.details.answers[0]).toMatchObject({ kind: "option", answer: "A" });
  expect(out.content[0].type).toBe("text");
});

test("execute: cancel → details.cancelled=true", async () => {
  const t = makeAskTool("s1") as any;
  const p = t.execute("tc1", validParams, new AbortController().signal);
  askRegistry.cancel("s1", "tc1");
  const out = await p;
  expect(out.details.cancelled).toBe(true);
});

test("reconcileDanglingAsks: 对无 toolResult 的 ask 工具调用注入 cancelled 结果", () => {
  const messages: any[] = [
    { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "ask_user_question", arguments: validParams }], model: "m", stopReason: "tool_use", timestamp: 1 },
  ];
  const out = reconcileDanglingAsks(messages);
  expect(out).toHaveLength(2);
  const injected = out[1];
  expect(injected.role).toBe("toolResult");
  expect(injected.toolCallId).toBe("tc1");
  expect(injected.toolName).toBe("ask_user_question");
  expect(injected.isError).toBe(false);
});

test("reconcileDanglingAsks: 已有 toolResult 的 ask 不重复注入", () => {
  const messages: any[] = [
    { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "ask_user_question", arguments: validParams }], model: "m", stopReason: "tool_use", timestamp: 1 },
    { role: "toolResult", toolCallId: "tc1", toolName: "ask_user_question", content: [{ type: "text", text: "done" }], isError: false, timestamp: 2 },
  ];
  expect(reconcileDanglingAsks(messages)).toHaveLength(2);  // 原样返回
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `cd packages/kernel && bun test tests/ask-tool.test.ts`
Expected: FAIL — `Cannot find module "../src/ask-tool"`。

- [ ] **Step 4: 实现 `packages/kernel/src/ask-tool.ts`**

```ts
// ask_user_question 工具定义 + 重启兜底。
//
// makeAskTool(sessionId) 闭包注入 wa-pi sessionId（execute 签名无 sessionId），
// 返回 SDK ToolDefinition，交给 createAgentSession({ customTools })。
// execute：先校验（非法直接返回 details.error，不阻塞），否则 await askRegistry.ask(...)。
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { askRegistry } from "./ask-registry";
import { validateAskParams, type AskParams, type AskAnswer } from "@wa-pi/shared";

const AskParamsSchema = Type.Object({
  questions: Type.Array(
    Type.Object({
      question: Type.String({ description: "完整问题文本，以 ? 结尾" }),
      header: Type.String({ description: "chip 标签文字，≤16 字符" }),
      multiSelect: Type.Optional(Type.Boolean({ description: "是否多选，默认 false" })),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: "1-5 词，≤60 字符" }),
          description: Type.String({ description: "解释该选项/取舍" }),
          preview: Type.Optional(Type.String({ description: "可选 markdown，随选项展示" })),
        }),
        { minItems: 2, maxItems: 4 },
      ),
    }),
    { minItems: 1, maxItems: 4 },
  ),
});

export interface AskToolDetails {
  answers?: AskAnswer[];
  cancelled: boolean;
  error?: string;
}

/** 构造 ask_user_question 工具（闭包绑 sessionId）。每个 session 一份实例。 */
export function makeAskTool(sessionId: string) {
  return defineTool({
    name: "ask_user_question",
    label: "Ask User",
    description:
      "向用户提出 1-4 个结构化澄清问题（每问 2-4 个选项），代替瞎猜。每个问题可单选或多选；" +
      "用户可填「其他」自由文本或取消。返回 details.answers（含 kind: option|custom|multi）或 cancelled。",
    promptGuidelines:
      "当存在会显著改变实现的歧义、且不值得自己合理假设时再用；一次问最少必要的问题；" +
      "选项文案简洁，给出取舍说明；不要用于确认显而易见的事。",
    parameters: AskParamsSchema,
    async execute(toolCallId, params, signal): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: AskToolDetails;
    }> {
      const error = validateAskParams(params);
      if (error) {
        return { content: [{ type: "text", text: `ask 校验失败: ${error}` }], details: { cancelled: false, error } };
      }
      const outcome = await askRegistry.ask(sessionId, toolCallId, params as AskParams, signal);
      if (outcome.cancelled) {
        return { content: [{ type: "text", text: "用户取消了提问" }], details: { cancelled: true } };
      }
      const text = (outcome.answers ?? [])
        .map((a) => `Q: ${a.question}\nA: ${a.kind === "multi" ? (a.selected?.join(", ") ?? "") : (a.answer ?? "")}${a.notes ? ` (备注: ${a.notes})` : ""}`)
        .join("\n\n");
      return { content: [{ type: "text", text }], details: { cancelled: false, answers: outcome.answers } };
    },
  });
}

/**
 * 重启兜底：扫描 session 历史，对「无 toolResult 的 ask_user_question 工具调用」
 * 注入一条 cancelled toolResult，避免 agent 卡在等结果。返回新数组（不改入参）。
 * 注：内核重启后 registry 内存态丢失，pending 提问无法恢复交互式 UI；此函数让 agent
 * 看到「用户取消」从而能自行重问，保证会话不卡死。
 */
export function reconcileDanglingAsks(messages: ReadonlyArray<unknown>): unknown[] {
  const msgs = messages as Array<Record<string, unknown>>;
  const answered = new Set<string>();
  for (const m of msgs) {
    if (m.role === "toolResult" && typeof m.toolCallId === "string") answered.add(m.toolCallId);
  }
  const dangling: Array<Record<string, unknown>> = [];
  let ts = 0;
  for (const m of msgs) ts = Math.max(ts, (m.timestamp as number) ?? 0);
  for (const m of msgs) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content as Array<Record<string, unknown>>) {
      if (b.type === "toolCall" && b.name === "ask_user_question" && typeof b.id === "string" && !answered.has(b.id)) {
        answered.add(b.id);
        dangling.push({
          role: "toolResult",
          toolCallId: b.id,
          toolName: "ask_user_question",
          content: [{ type: "text", text: "用户取消（会话重启）" }],
          isError: false,
          timestamp: ++ts,
        });
      }
    }
  }
  return dangling.length === 0 ? [...msgs] : [...msgs, ...dangling];
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd packages/kernel && bun test tests/ask-tool.test.ts`
Expected: PASS。

- [ ] **Step 6: 接入 `packages/kernel/src/agent-manager.ts`**

(a) 在 `CreateAgentSessionFn` 类型（第 28-38 行）的 opts 里加一行：

```ts
  tools?: string[];
  customTools?: unknown[];   // ← 新增：传给 createAgentSession 的 customTools
  authStorage: any;
```

(b) 在文件顶部 import（第 13-24 行附近）加：

```ts
import { makeAskTool, reconcileDanglingAsks } from "./ask-tool";
```

(c) 在 `_createSession` 内，`({ session } = await createFn({...}))`（第 307-318 行）的调用里加 `customTools`，并在拿到 session 后跑兜底。把该块改为：

```ts
      ({ session } = await createFn({
        cwd: project.cwd,
        agentDir: WA_PI_DIR,
        sessionManager: sdk.SessionManager.open(sessionEntity.piSessionFile),
        resourceLoader: loader,
        thinkingLevel: config?.thinking ?? "medium",
        tools: config?.tools?.length ? config.tools : DEFAULT_AGENT_TOOLS,
        // ask_user_question 工具闭包注入 sessionId；与 memory 工具并入同一数组（memory 重构落地后追加）
        customTools: [makeAskTool(sessionId)],
        authStorage,
        modelRegistry,
      }));

      // 重启兜底：对历史里「无 result 的 ask 调用」注入 cancelled，避免 agent 卡死
      const reconciled = reconcileDanglingAsks(session.messages as unknown[]);
      if (reconciled.length !== (session.messages as unknown[]).length) {
        (session as any).agent.state.messages = reconciled;
      }
```

> 说明：`session.setSessionName(...)` 等后续代码不动。memory 重构落地时把其工具 `push` 进 `customTools` 数组即可，两者独立。

- [ ] **Step 7: 写 wiring 测试（追加到 `packages/kernel/tests/agent-manager.test.ts`）**

在文件末尾追加：

```ts
test("ensureStarted 把 ask_user_question 工具作为 customTools 传给 createFn", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({ projectId: project.id, primaryAgent: "dev", title: "测试" });

  const captured: any[] = [];
  const createFn = mock(async (opts: any) => {
    captured.push(opts);
    return { session: fakeSession as AgentSession, extensionsResult: { extensions: [], errors: [], runtime: {} as any } };
  });
  const am = new AgentManager({ projectStore, configStore: null as any, onEvent: () => {}, createAgentSessionFn: createFn as any });
  await am.ensureStarted(project.id, "dev", session.id);

  expect(captured[0].customTools).toBeDefined();
  expect((captured[0].customTools[0] as any).name).toBe("ask_user_question");
});
```

- [ ] **Step 8: 跑 kernel 全量测试确认无回归**

Run: `cd packages/kernel && bun test`
Expected: PASS（含新用例 + 原有全过）。

- [ ] **Step 9: typecheck + commit**

Run: `cd packages/kernel && bun run typecheck`
Expected: 无错误。

```bash
git add packages/kernel/src/ask-tool.ts packages/kernel/src/agent-manager.ts packages/kernel/tests/ask-tool.test.ts packages/kernel/tests/agent-manager.test.ts
git commit -m "feat(kernel): ask_user_question 工具(defineTool)+customTools 接入+重启兜底"
```

---

## Task 4: Kernel — 中断清理（cancelAll）+ ws-server 应答事件

**Files:**
- Modify: `packages/kernel/src/agent-manager.ts`（`abort` 第 541-553 行；`_jumpQueue` 第 414-457 行；`_teardownSession` 第 563-573 行）
- Modify: `packages/kernel/src/ws-server.ts`（`handle` switch，第 169 行起；在 `agent:abort` case 之后加）
- Test: 追加到 `packages/kernel/tests/agent-manager.test.ts` 与 `packages/kernel/tests/ws-server.test.ts`

**Interfaces:**
- Consumes: `askRegistry`（Task 2）。
- Produces: `abort`/`_jumpQueue`/`_teardownSession` 调 `askRegistry.cancelAll`；ws-server 处理 `agent:answer`/`agent:cancel-ask`。

- [ ] **Step 1: 写失败测试 — 中断清理（追加到 `packages/kernel/tests/agent-manager.test.ts`）**

文件顶部 import 区加 `import { askRegistry } from "../src/ask-registry";` 与 `import type { AskParams } from "@wa-pi/shared";`。`beforeEach` 里加 `askRegistry.reset();`。末尾追加：

```ts
const askParams: AskParams = { questions: [
  { question: "Q?", header: "h", options: [{ label: "A", description: "x" }, { label: "B", description: "y" }] },
] };

test("abort 取消该 session 的 pending ask（同步 cancelAll）", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({ projectId: project.id, primaryAgent: "dev", title: "测试" });
  const am = new AgentManager({ projectStore, configStore: null as any, onEvent: () => {}, createAgentSessionFn: mockCreateAgentSession });
  await am.ensureStarted(project.id, "dev", session.id);

  const p = askRegistry.ask(session.id, "tc1", askParams, new AbortController().signal);
  await am.abort(session.id);
  expect((await p).cancelled).toBe(true);
});

test("immediate(_jumpQueue interrupt) 取消 pending ask", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({ projectId: project.id, primaryAgent: "dev", title: "测试" });
  const am = new AgentManager({ projectStore, configStore: null as any, onEvent: () => {}, createAgentSessionFn: mockCreateAgentSession });
  await am.ensureStarted(project.id, "dev", session.id);

  const p = askRegistry.ask(session.id, "tc1", askParams, new AbortController().signal);
  await am.immediate(session.id, "立即执行", []);
  expect((await p).cancelled).toBe(true);
});

test("disposeSession 取消 pending ask", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({ projectId: project.id, primaryAgent: "dev", title: "测试" });
  const am = new AgentManager({ projectStore, configStore: null as any, onEvent: () => {}, createAgentSessionFn: mockCreateAgentSession });
  await am.ensureStarted(project.id, "dev", session.id);

  const p = askRegistry.ask(session.id, "tc1", askParams, new AbortController().signal);
  await am.disposeSession(session.id);
  expect((await p).cancelled).toBe(true);
});
```

- [ ] **Step 2: 写失败测试 — WS 应答（追加到 `packages/kernel/tests/ws-server.test.ts`）**

顶部 import 加 `import { askRegistry } from "../src/ask-registry";` 与 `import type { AskParams } from "@wa-pi/shared";`。`withServer` 之前加 `beforeEach(() => askRegistry.reset());`。末尾追加：

```ts
const askParams: AskParams = { questions: [
  { question: "Q?", header: "h", options: [{ label: "A", description: "x" }, { label: "B", description: "y" }] },
] };

test("agent:answer → resolve pending ask，返回 answers", async () => {
  const { agentManager } = makeMockAgentManager();
  await withServer(agentManager, async (send) => {
    const p = askRegistry.ask("s1", "tc1", askParams, new AbortController().signal);
    send({ type: "agent:answer", sessionId: "s1", toolCallId: "tc1", reply: { replies: [{ questionIndex: 0, selected: ["A"] }] } });
    const out = await p;
    expect(out.cancelled).toBe(false);
    expect(out.answers?.[0]).toMatchObject({ kind: "option", answer: "A" });
  });
});

test("agent:cancel-ask → cancel pending ask", async () => {
  const { agentManager } = makeMockAgentManager();
  await withServer(agentManager, async (send) => {
    const p = askRegistry.ask("s1", "tc1", askParams, new AbortController().signal);
    send({ type: "agent:cancel-ask", sessionId: "s1", toolCallId: "tc1" });
    expect((await p).cancelled).toBe(true);
  });
});

test("agent:answer 对未知 toolCallId 幂等（不抛错、不影响）", async () => {
  const { agentManager } = makeMockAgentManager();
  await withServer(agentManager, async (send) => {
    send({ type: "agent:answer", sessionId: "s1", toolCallId: "unknown", reply: { replies: [] } });
    await new Promise(r => setTimeout(r, 50));  // 不崩溃即通过
  });
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `cd packages/kernel && bun test tests/agent-manager.test.ts tests/ws-server.test.ts`
Expected: FAIL（新中断清理用例与 WS 用例失败——`abort` 等尚未调 cancelAll、ws-server 无 agent:answer 分支）。

- [ ] **Step 4: 实现 — agent-manager 中断清理**

在 `packages/kernel/src/agent-manager.ts`：

(a) `abort` 方法（第 541 行）—— 在 `if (!session) return;` 之后加：
```ts
    askRegistry.cancelAll(sessionId);
```

(b) `_jumpQueue` 方法（第 414 行）—— 在 `if (!session) throw new Error(...)` 之后加：
```ts
    askRegistry.cancelAll(sessionId);   // 中断类（immediate）作废 pending 提问
```

(c) `_teardownSession` 方法（第 563 行）—— 方法体开头加：
```ts
    askRegistry.cancelAll(sessionId);
```

并在 import 区加 `import { askRegistry } from "./ask-registry";`（如 Task 3 未加则补）。

- [ ] **Step 5: 实现 — ws-server 应答事件**

在 `packages/kernel/src/ws-server.ts` 的 `handle` switch 里，紧跟 `case "agent:abort":` 块之后（第 266 行附近）加：

```ts
      case "agent:answer": {
        askRegistry.resolve(event.sessionId, event.toolCallId, event.reply);
        break;
      }
      case "agent:cancel-ask": {
        askRegistry.cancel(event.sessionId, event.toolCallId);
        break;
      }
```

并在文件顶部 import 区（第 13 行附近）加 `import { askRegistry } from "./ask-registry";`。

- [ ] **Step 6: 跑测试确认通过**

Run: `cd packages/kernel && bun test tests/agent-manager.test.ts tests/ws-server.test.ts`
Expected: PASS（新用例 + 原有全过）。

- [ ] **Step 7: kernel 全量 + typecheck + commit**

Run: `cd packages/kernel && bun test && bun run typecheck`
Expected: 全过、无类型错误。

```bash
git add packages/kernel/src/agent-manager.ts packages/kernel/src/ws-server.ts packages/kernel/tests/agent-manager.test.ts packages/kernel/tests/ws-server.test.ts
git commit -m "feat(kernel): ask 中断清理(cancelAll)+ws-server agent:answer/cancel-ask"
```

---

## Task 5: Frontend — 派生选择器（pendingAsks / effectiveStatus）

**Files:**
- Create: `packages/frontend/src/store/ask.ts`
- Test: `packages/frontend/tests/store-ask.test.ts`

**Interfaces:**
- Consumes: `SessionMessage`、`AgentStatus`、`AgentName`、`AskParams` from `@wa-pi/shared`；`useSessionStore`。
- Produces: 纯函数 `selectPendingAsks(messages)`、`selectEffectiveStatus(raw, hasPending)`，hook `usePendingAsks(sessionId)`、`useIsBlocked(sessionId)`。Task 6/7 依赖。

- [ ] **Step 1: 写失败测试 `packages/frontend/tests/store-ask.test.ts`**

```ts
import { test, expect } from "bun:test";
import { selectPendingAsks, selectEffectiveStatus } from "../src/store/ask";
import type { SessionMessage } from "@wa-pi/shared";

function assistantMsg(toolCalls: any[], timestamp = 1): SessionMessage {
  return { message: { role: "assistant", content: toolCalls, model: "m", stopReason: "tool_use", timestamp } as any, agentName: "dev" };
}
function toolResultMsg(toolCallId: string, timestamp = 2): SessionMessage {
  return { message: { role: "toolResult", toolCallId, toolName: "ask_user_question", content: [{ type: "text", text: "ok" }], isError: false, timestamp } as any, agentName: "dev" };
}

const askCall = { type: "toolCall", id: "tc1", name: "ask_user_question", arguments: { questions: [{ question: "Q?", header: "h", options: [{ label: "A", description: "x" }, { label: "B", description: "y" }] }] } };

test("selectPendingAsks: 找出无 result 的 ask 调用", () => {
  const msgs = [assistantMsg([askCall])];
  const pending = selectPendingAsks(msgs);
  expect(pending).toHaveLength(1);
  expect(pending[0].toolCallId).toBe("tc1");
  expect(pending[0].params.questions).toHaveLength(1);
});

test("selectPendingAsks: 有 result 的 ask 不算 pending", () => {
  const msgs = [assistantMsg([askCall]), toolResultMsg("tc1")];
  expect(selectPendingAsks(msgs)).toHaveLength(0);
});

test("selectPendingAsks: 多个 pending；忽略非 ask 的 toolCall", () => {
  const msgs = [assistantMsg([
    askCall,
    { type: "toolCall", id: "tc2", name: "read", arguments: {} },
    { type: "toolCall", id: "tc3", name: "ask_user_question", arguments: { questions: [{ question: "Q2?", header: "h", options: [{ label: "A", description: "x" }, { label: "B", description: "y" }] }] } },
  ])];
  const pending = selectPendingAsks(msgs);
  expect(pending.map(p => p.toolCallId).sort()).toEqual(["tc1", "tc3"]);
});

test("selectEffectiveStatus: 有 pending → blocked；否则透传 raw", () => {
  expect(selectEffectiveStatus("thinking", true)).toBe("blocked");
  expect(selectEffectiveStatus("idle", true)).toBe("blocked");
  expect(selectEffectiveStatus("thinking", false)).toBe("thinking");
  expect(selectEffectiveStatus("idle", false)).toBe("idle");
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd packages/frontend && bun test tests/store-ask.test.ts`
Expected: FAIL — `Cannot find module "../src/store/ask"`。

- [ ] **Step 3: 实现 `packages/frontend/src/store/ask.ts`**

```ts
// ask_user_question 前端派生状态：从 messagesBySession 派生 pending 提问 + 有效的会话状态。
import { useMemo } from "react";
import { useSessionStore } from "./session";
import type { AgentStatus, AgentName, AskParams, SessionMessage } from "@wa-pi/shared";

export interface PendingAsk {
  toolCallId: string;
  agentName?: AgentName;
  params: AskParams;
}

/** 从一条会话的消息里找出「无 toolResult 的 ask_user_question 工具调用」。纯函数。 */
export function selectPendingAsks(messages: SessionMessage[]): PendingAsk[] {
  const answered = new Set<string>();
  for (const sm of messages) {
    const m = sm.message as any;
    if (m?.role === "toolResult" && typeof m.toolCallId === "string") answered.add(m.toolCallId);
  }
  const pending: PendingAsk[] = [];
  for (const sm of messages) {
    const m = sm.message as any;
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content as any[]) {
      if (b?.type === "toolCall" && b.name === "ask_user_question" && typeof b.id === "string" && !answered.has(b.id)) {
        pending.push({ toolCallId: b.id, agentName: sm.agentName, params: b.arguments as AskParams });
      }
    }
  }
  return pending;
}

/** pending 提问存在时强制 blocked，否则透传原始状态。纯函数。 */
export function selectEffectiveStatus(raw: AgentStatus, hasPending: boolean): AgentStatus {
  return hasPending ? "blocked" : raw;
}

/** hook：订阅某会话的 pending 提问列表。 */
export function usePendingAsks(sessionId: string): PendingAsk[] {
  const messages = useSessionStore(s => s.messagesBySession[sessionId] ?? EMPTY);
  return useMemo(() => selectPendingAsks(messages), [messages]);
}

/** hook：某会话是否处于「等待用户回答」阻塞态。 */
export function useIsBlocked(sessionId: string): boolean {
  return usePendingAsks(sessionId).length > 0;
}

const EMPTY: SessionMessage[] = [];
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/frontend && bun test tests/store-ask.test.ts`
Expected: PASS。

- [ ] **Step 5: commit**

```bash
git add packages/frontend/src/store/ask.ts packages/frontend/tests/store-ask.test.ts
git commit -m "feat(frontend): pendingAsks/effectiveStatus 派生选择器"
```

---

## Task 6: Frontend — AskFormCard 表单组件

**Files:**
- Create: `packages/frontend/src/components/ask/AskFormCard.tsx`
- Test: `packages/frontend/tests/AskFormCard.test.tsx`

**Interfaces:**
- Consumes: `AskParams`/`AskReply` from `@wa-pi/shared`；`send` from `ws-instance`。
- Produces: `AskFormCard({ sessionId, toolCallId, params })`。挂载即 pending；提交发 `agent:answer`；取消发 `agent:cancel-ask`。Task 7 用它。

- [ ] **Step 1: 写失败测试 `packages/frontend/tests/AskFormCard.test.tsx`**

```tsx
import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { AskFormCard } from "../src/components/ask/AskFormCard";
import type { AskParams } from "@wa-pi/shared";

const params: AskParams = { questions: [
  { question: "数据存储方案?", header: "存储", options: [
    { label: "SQLite", description: "轻量" }, { label: "PostgreSQL", description: "生产级" }] },
] };

const sent: any[] = [];
beforeEach(() => { sent.length = 0; });

// mock send：截获 WS 发送
mock.module("../src/ws-instance", () => ({ send: (e: any) => sent.push(e) }));

test("渲染问题与选项；点选 + 提交 → 发 agent:answer", () => {
  render(<AskFormCard sessionId="s1" toolCallId="tc1" params={params} />);
  expect(screen.getByText("数据存储方案?")).toBeTruthy();
  fireEvent.click(screen.getByText("PostgreSQL"));
  fireEvent.click(screen.getByRole("button", { name: "提交" }));
  expect(sent).toHaveLength(1);
  expect(sent[0].type).toBe("agent:answer");
  expect(sent[0].sessionId).toBe("s1");
  expect(sent[0].toolCallId).toBe("tc1");
  expect(sent[0].reply.replies[0].selected).toEqual(["PostgreSQL"]);
});

test("未选择时提交禁用", () => {
  render(<AskFormCard sessionId="s1" toolCallId="tc1" params={params} />);
  const submit = screen.getByRole("button", { name: "提交" }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
});

test("取消 → 发 agent:cancel-ask", () => {
  render(<AskFormCard sessionId="s1" toolCallId="tc1" params={params} />);
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(sent).toHaveLength(1);
  expect(sent[0].type).toBe("agent:cancel-ask");
});

test("Other：展开文本框，填入后可提交（kind=custom）", () => {
  render(<AskFormCard sessionId="s1" toolCallId="tc1" params={params} />);
  fireEvent.click(screen.getByText("其他…"));
  const input = screen.getByPlaceholderText("输入自定义答案…") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "Redis" } });
  fireEvent.click(screen.getByRole("button", { name: "提交" }));
  expect(sent[0].reply.replies[0].customText).toBe("Redis");
  expect(sent[0].reply.replies[0].selected).toEqual([]);
});

test("多选：可勾多个；切换 multiSelect 互不干扰", () => {
  const mp: AskParams = { questions: [{ question: "多选?", header: "h", multiSelect: true, options: [
    { label: "A", description: "x" }, { label: "B", description: "y" }, { label: "C", description: "z" }] }] };
  render(<AskFormCard sessionId="s1" toolCallId="tc1" params={mp} />);
  fireEvent.click(screen.getByText("A"));
  fireEvent.click(screen.getByText("C"));
  fireEvent.click(screen.getByRole("button", { name: "提交" }));
  expect(sent[0].reply.replies[0].selected.sort()).toEqual(["A", "C"]);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd packages/frontend && bun test tests/AskFormCard.test.tsx`
Expected: FAIL — `Cannot find module "../src/components/ask/AskFormCard"`。

- [ ] **Step 3: 实现 `packages/frontend/src/components/ask/AskFormCard.tsx`**

```tsx
import { useState } from "react";
import type { AskParams, AskReply } from "@wa-pi/shared";
import { send } from "../../ws-instance";
import { ReactMarkdown } from "react-markdown";

interface Props {
  sessionId: string;
  toolCallId: string;
  params: AskParams;
}

/** 单个 ask_user_question 调用的表单。挂载即 pending；提交/取消后由父层在 pendingAsks 消失时卸载。 */
export function AskFormCard({ sessionId, toolCallId, params }: Props) {
  // 每问的选择状态：questionIndex → { selected: Set<label>, custom: string, otherOpen: bool, notes: string }
  const [state, setState] = useState<Record<number, { selected: Set<string>; custom: string; otherOpen: boolean; notes: string }>>(() => {
    const init: Record<number, { selected: Set<string>; custom: string; otherOpen: boolean; notes: string }> = {};
    params.questions.forEach((_, i) => { init[i] = { selected: new Set(), custom: "", otherOpen: false, notes: "" }; });
    return init;
  });
  const [submitting, setSubmitting] = useState(false);

  const patch = (qi: number, fn: (s: { selected: Set<string>; custom: string; otherOpen: boolean; notes: string }) => void) =>
    setState(prev => {
      const cur = prev[qi];
      const next = { selected: new Set(cur.selected), custom: cur.custom, otherOpen: cur.otherOpen, notes: cur.notes };
      fn(next);
      return { ...prev, [qi]: next };
    });

  const toggle = (qi: number, label: string, multi: boolean) => patch(qi, s => {
    if (multi) { s.selected.has(label) ? s.selected.delete(label) : s.selected.add(label); }
    else { s.selected.clear(); s.selected.add(label); s.otherOpen = false; s.custom = ""; }
  });

  const allAnswered = params.questions.every((q, i) => {
    const s = state[i];
    return (s.custom.trim().length > 0) || s.selected.size > 0;
  });

  const handleSubmit = () => {
    if (!allAnswered || submitting) return;
    setSubmitting(true);
    const reply: AskReply = { replies: params.questions.map((_, i) => {
      const s = state[i];
      const useCustom = s.custom.trim().length > 0;
      return { questionIndex: i, selected: useCustom ? [] : [...s.selected], customText: useCustom ? s.custom.trim() : undefined, notes: s.notes.trim() || undefined };
    }) };
    send({ type: "agent:answer", sessionId, toolCallId, reply });
    // 卡片保持 pending 直到 toolResult 到达使 pendingAsks 移除它（由父层卸载）
  };

  const handleCancel = () => {
    if (submitting) return;
    send({ type: "agent:cancel-ask", sessionId, toolCallId });
  };

  return (
    <div className="rounded-2xl border-2 border-accent bg-surface shadow-md" data-testid={`ask-card-${toolCallId}`}>
      <div className="flex items-center justify-between px-4 py-2 border-b border-hairline">
        <span className="text-[11.5px] font-semibold text-accent">📌 agent 提问 · 请回复以继续</span>
        <button onClick={handleCancel} disabled={submitting} className="text-[11.5px] px-2 py-0.5 rounded-pill bg-danger-soft text-danger border-0 cursor-pointer disabled:opacity-50" data-testid={`ask-collapse-${toolCallId}`}>取消</button>
      </div>
      <div className="px-4 py-3 space-y-3 max-h-[50vh] overflow-auto">
        {params.questions.map((q, qi) => {
          const s = state[qi];
          const multi = q.multiSelect === true;
          const selPreview = [...s.selected].map(lbl => q.options.find(o => o.label === lbl)?.preview).find(Boolean);
          return (
            <div key={qi} className="space-y-1.5">
              <div className="text-[12.5px] font-semibold text-primary">Q{params.questions.length > 1 ? qi + 1 : ""} · {q.question}</div>
              {q.options.map(o => {
                const checked = s.selected.has(o.label);
                return (
                  <button key={o.label} onClick={() => toggle(qi, o.label, multi)}
                    className={`w-full text-left flex gap-2 items-start px-2.5 py-1.5 rounded-sm border transition-colors ${checked ? "bg-accent-soft border-accent text-primary" : "bg-surface border-hairline text-secondary hover:border-accent"}`}>
                    <span className="text-accent">{multi ? (checked ? "☑" : "☐") : (checked ? "◉" : "○")}</span>
                    <span><span className="font-medium text-primary">{o.label}</span> <span className="text-tertiary">— {o.description}</span></span>
                  </button>
                );
              })}
              {selPreview && (
                <div className="ml-6 bg-[#0d1117] text-[#c9d1d9] rounded-sm px-2.5 py-1.5 text-[11px] font-mono overflow-auto" data-testid={`ask-preview-${toolCallId}-${qi}`}>
                  <ReactMarkdown>{selPreview}</ReactMarkdown>
                </div>
              )}
              <button onClick={() => patch(qi, st => { st.otherOpen = !st.otherOpen; })}
                className="text-[11px] text-secondary hover:text-primary underline">其他…</button>
              {s.otherOpen && (
                <textarea value={s.custom} onChange={e => patch(qi, st => { st.custom = e.target.value; })}
                  placeholder="输入自定义答案…" rows={1}
                  className="w-full bg-transparent border border-hairline rounded-sm text-primary outline-none text-[12.5px] p-2 resize-none" />
              )}
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-tertiary">备注(可选)</span>
                <input value={s.notes} onChange={e => patch(qi, st => { st.notes = e.target.value; })}
                  className="flex-1 bg-transparent border border-hairline rounded-sm text-primary outline-none text-[12px] px-2 py-0.5" />
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex justify-end gap-2 px-4 py-2 border-t border-hairline">
        <button onClick={handleCancel} disabled={submitting} className="text-[12px] px-3 py-1 rounded-pill bg-danger-soft text-danger border-0 cursor-pointer disabled:opacity-50">取消</button>
        <button onClick={handleSubmit} disabled={!allAnswered || submitting}
          className="text-[12px] px-4 py-1 rounded-pill text-on-brand border-0 cursor-pointer disabled:cursor-not-allowed"
          style={{ background: allAnswered && !submitting ? "var(--brand)" : "var(--hairline-strong)" }}>
          {submitting ? "提交中…" : "提交"}
        </button>
      </div>
    </div>
  );
}
```

> 取消按钮在 header 和 footer 各一个，role/name 均为「取消」；测试用 `getByRole("button",{name:"取消"})` 取第一个。若测试取到 header 的，行为一致。如需精确，可改用 `getAllByRole` + `[0]`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/frontend && bun test tests/AskFormCard.test.tsx`
Expected: PASS。

> 若 `mock.module` 在当前 bun 版本不可用，改为在 `tests/setup-websocket.ts` 约定的注入方式，或把 `send` 通过 props 注入便于测试（加可选 `onSubmit`/`onCancel` prop，默认调 `send`）。优先保持 `send` 直连，测试用 `mock.module`。

- [ ] **Step 5: commit**

```bash
git add packages/frontend/src/components/ask/AskFormCard.tsx packages/frontend/tests/AskFormCard.test.tsx
git commit -m "feat(frontend): AskFormCard 结构化问答表单"
```

---

## Task 7: Frontend — 停靠区 + composer 禁用 + 历史 pill

**Files:**
- Create: `packages/frontend/src/components/ask/AskDock.tsx`
- Modify: `packages/frontend/src/components/SessionView.tsx`（第 12-17、59-161 行）
- Modify: `packages/frontend/src/components/Composer.tsx`（第 9-15、56-77 行）
- Modify: `packages/frontend/src/components/ui/ComposerInput.tsx`（Props 第 10-23 行、textarea 第 132-147 行）
- Modify: `packages/frontend/src/components/MessageList.tsx`（`ToolCallBlock` 第 391-431 行）
- Test: `packages/frontend/tests/SessionView.test.tsx`（追加）、`packages/frontend/tests/Composer.test.tsx`（追加）

**Interfaces:**
- Consumes: `usePendingAsks`/`useIsBlocked`（Task 5）、`AskFormCard`（Task 6）。
- Produces: `AskDock({ sessionId })`；SessionView 在 composer 上方渲染它；Composer 接 `disabled`。

- [ ] **Step 1: 实现 `packages/frontend/src/components/ask/AskDock.tsx`**

```tsx
import { usePendingAsks } from "../../store/ask";
import { AskFormCard } from "./AskFormCard";

/** composer 正上方的提问停靠区。pending 提问纵向堆叠；回答后自动消失（pendingAsks 移除）。 */
export function AskDock({ sessionId }: { sessionId: string }) {
  const asks = usePendingAsks(sessionId);
  if (asks.length === 0) return null;
  return (
    <div className="px-6 pt-3 space-y-3" data-testid={`ask-dock-${sessionId}`}>
      {asks.map(a => <AskFormCard key={a.toolCallId} sessionId={sessionId} toolCallId={a.toolCallId} params={a.params} />)}
    </div>
  );
}
```

- [ ] **Step 2: 写失败测试 — composer 禁用（追加到 `packages/frontend/tests/Composer.test.tsx`）**

先确认该测试文件现有 import 风格后追加（参考其头部）。追加：

```tsx
test("disabled=true 时 send 被阻断且 placeholder 切换", () => {
  // 参考 Composer.test.tsx 既有渲染方式渲染 <Composer sessionId agentName disabled />；
  // 断言：textarea disabled，发送按钮点击后不触发 send（无 ws 发送）。
  // 具体渲染辅助按该文件既有 harness（fake ws / projectsStore seed）。
  // 这里给出断言骨架，实现时复用本文件已有的 renderComposer 工具。
  // expect(textarea.disabled).toBe(true);
  // fireEvent.click(sendBtn); expect(sent).toHaveLength(0);
});
```

> 该测试需复用 `Composer.test.tsx` 既有的 `renderComposer`/fake-ws 工具。实现时把骨架补成完整用例：渲染 `<Composer ... disabled />`，断言 `composer-input` 内 textarea 的 `disabled` 为 true、点击发送无 `agent:prompt` 发出。

- [ ] **Step 3: 实现 — ComposerInput 加 `disabled`**

`packages/frontend/src/components/ui/ComposerInput.tsx`：

(a) Props interface（第 10-23 行）加 `disabled?: boolean;`，解构（第 38-41 行）加 `disabled`。

(b) textarea（第 132 行）加 `disabled={disabled}`：
```tsx
        <textarea
          ref={textareaRef}
          disabled={disabled}
          value={text}
          ...
```

(c) `canSend`（第 123 行）改为 `const canSend = !sendDisabled && !disabled && !!text.trim() && model !== null;`

- [ ] **Step 4: 实现 — Composer 透传 `disabled`**

`packages/frontend/src/components/Composer.tsx`：

(a) Props（第 9-13 行）加 `disabled?: boolean;`，签名解构加 `disabled`。

(b) `handleSend`（第 32 行）开头加 `if (disabled) return;`。

(c) `<ComposerInput .../>`（第 58 行起）加 `disabled={disabled}`，`placeholder` 改为 `disabled ? "请先回答上方提问…" : (isRunning ? "输入要加入队列的消息..." : \`给${agentName}发消息...\`)`。

- [ ] **Step 5: 写失败测试 — SessionView 停靠区（追加到 `packages/frontend/tests/SessionView.test.tsx`）**

追加（复用该文件既有 harness 渲染 SessionView + 注入消息）：

```tsx
test("有 pending ask 时渲染 AskDock 且 composer 禁用", () => {
  // 用 useSessionStore.setState 预置一条带 ask_user_question toolCall 的 assistant 消息（无 toolResult）
  // 渲染 <SessionView .../>；断言：
  // expect(screen.getByTestId(`ask-dock-${sessionId}`)).toBeTruthy();
  // expect(screen.getByTestId(`ask-card-${toolCallId}`)).toBeTruthy();
  // composer textarea disabled
});

test("无 pending ask 时不渲染 AskDock", () => {
  // 预置普通消息；断言 ask-dock 不存在。
});
```

> 实现时按 `SessionView.test.tsx` 既有的 projectsStore seed + render 方式补全。

- [ ] **Step 6: 实现 — SessionView 渲染 dock + blocked 状态**

`packages/frontend/src/components/SessionView.tsx`：

(a) import（第 1-8 行）加 `import { AskDock } from "./ask/AskDock";` 与 `import { useIsBlocked } from "../store/ask";`。

(b) 组件内（第 16-17 行附近）加 `const isBlocked = useIsBlocked(sessionId);`。

(c) 把 `<MessageList />` 与 `<Composer />` 之间（第 157-158 行）插入 dock：
```tsx
      <MessageList sessionId={sessionId} />
      <AskDock sessionId={sessionId} />
      <Composer sessionId={sessionId} agentName={session.primaryAgent} isRunning={status === "thinking"} disabled={isBlocked} />
```

(d)（可选打磨）顶部状态文案：`isBlocked` 时把 `{agentState}` 处显示「等待回复」。最小改动可在 header 的 `<div className="text-[11.5px] text-tertiary mt-px">` 里把 `{agentState}` 替换为 `{isBlocked ? "等待回复" : agentState}`。

- [ ] **Step 7: 实现 — 历史 pill label（MessageList.tsx）**

`packages/frontend/src/components/MessageList.tsx` 的 `ToolCallBlock`（第 391 行），把显示名从 `{toolCall.name}` 改为：
```tsx
        <span className={nameClass}>{toolCall.name === "ask_user_question" ? "问答" : toolCall.name}</span>
```

- [ ] **Step 8: 跑 frontend 全量 + typecheck**

Run: `cd packages/frontend && bun test && bun run typecheck`
Expected: 全过、无类型错误。

- [ ] **Step 9: commit**

```bash
git add packages/frontend/src/components/ask/AskDock.tsx packages/frontend/src/components/SessionView.tsx packages/frontend/src/components/Composer.tsx packages/frontend/src/components/ui/ComposerInput.tsx packages/frontend/src/components/MessageList.tsx packages/frontend/tests/SessionView.test.tsx packages/frontend/tests/Composer.test.tsx
git commit -m "feat(frontend): composer 上方提问停靠区 + pending 禁用 composer + 历史 pill"
```

---

## Task 8: 全链路集成校验（端到端手动 + 回归）

**Files:**
- Test: 手动校验脚本（不落库）+ 现有 `packages/frontend/e2e/composer.spec.ts` 风格参考

**目标：** 在真实 dev 环境验证 agent→kernel→frontend→用户→kernel→agent 完整链路（含队列中断），确认无回归。

- [ ] **Step 1: 全量单测回归**

Run: `cd packages/kernel && bun test && cd ../frontend && bun test && cd ../shared && bun test`
Expected: 三个包全过。

- [ ] **Step 2: 启动 dev 环境，手动触发一次真实 ask**

Run（项目根）: `bun run dev`（或 `bun run scripts/dev.ts`，按 repo 约定）
在 dev 会话里给 dev agent 发一个会触发澄清的 prompt，例如：「我要加用户登录，你有哪些关键决策点需要我先确认？请用 ask_user_question 问我。」
Expected（人工核对）：
1. agent 回合阻塞，composer 上方出现 `<AskDock>` 表单。
2. 顶部状态显示「等待回复」；composer 输入框禁用。
3. 点选一个选项 + 填备注 → 提交 → 表单消失，历史里出现「✓ 问答」pill，agent 带答案继续。
4. 再触发一次 ask → 点 dock 里的「取消」→ 表单消失，agent 收到 cancelled 继续。
5. 再触发一次 ask → 在 pending 时点 SessionView 的「停止」(abort) → 表单消失（cancelAll 生效）。

- [ ] **Step 3: 队列场景核对**

触发 ask（pending）→ 在排队 followUp 里有消息时点「立即」→ 确认 pending ask 被作废、立即消息开新回合（不卡死）。

- [ ] **Step 4: 重启兜底核对**

在 pending ask 状态下重启 kernel 进程 → 重新打开该会话 → 确认不卡死：历史里 ask 调用后有一条 cancelled toolResult（`reconcileDanglingAsks` 注入），agent 可继续/重问。

- [ ] **Step 5: （可选）补一条 e2e**

参考 `packages/frontend/e2e/composer.spec.ts`，加 `ask.spec.ts`：用受控 prompt 触发 ask，断言 dock 出现、提交后消失。若无稳定触发 ask 的 LLM 手段，跳过并在 commit message 注明「e2e 待真实模型环境补充」。

- [ ] **Step 6: commit（仅提交落库的测试/改动；手动校验不提交）**

```bash
git add packages/frontend/e2e/ask.spec.ts 2>/dev/null || true
git commit -m "test(ask): 全链路回归（含队列中断与重启兜底）" --allow-empty
```

---

## Self-Review（计划作者自检）

**1. Spec 覆盖：**
- §2 数据流 → Task 3（工具 execute 阻塞）+ Task 4（ws-server resolve）+ Task 5/6/7（前端渲染与提交）。✓
- §3.1 schema/校验 → Task 1（validateAskParams）+ Task 3（TypeBox schema + execute）。✓
- §3.2 AskRegistry（ask/resolve/cancel/cancelAll/幂等/并发/signal）→ Task 2。✓
- §3.3 接线（DEFAULT_AGENT_TOOLS、customTools、abort/_jumpQueue/dispose cancelAll、ws-server 两事件）→ Task 1（白名单）+ Task 3（customTools）+ Task 4（cancelAll + ws-server）。✓
- §4 shared 协议（ask.ts 类型、WSClientEvent 两事件、不增 server→client、跳过 chat kind）→ Task 1。✓
- §5 前端（pendingAsks 选择器、effectiveStatus blocked、AskDock、AskFormCard、composer 禁用、历史 pill）→ Task 5/6/7。✓
- §6 队列兼容（agent:answer 不经队列、中断类 cancelAll、pending 禁 composer）→ Task 4（cancelAll + ws-server 直达 registry）+ Task 7（composer 禁用）。✓
- §7 边界（重启兜底、断线重连、幂等、多 agent、竞态）→ Task 3 reconcileDanglingAsks（重启）+ Task 2（幂等/并发）+ Task 4（abort/answer 竞态先到者胜）。断线重连：pendingAsks 从历史派生，Task 5 覆盖。✓
- §8 测试计划（内核单测/集成、前端单测、e2e）→ Task 1-7 单测 + Task 8 集成/e2e。✓
- §11 待验证（Pi resume、ctx sessionId、signal 透传）→ Task 3 用闭包（不依赖 ctx）+ reconcileDanglingAsks（不依赖 Pi 是否重跑）+ cancelAll 兜底（不依赖 signal 透传）。✓ 三项均用「不依赖 SDK 内部行为」的设计绕过，已转为确定实现。

**2. 占位符扫描：** Task 7 Step 2/Step 5 的前端测试用骨架 + 「实现时按既有 harness 补全」——这是因为 `Composer.test.tsx`/`SessionView.test.tsx` 的 render 辅助需读其头部 harness 才能精确复刻；plan 已给出断言骨架与明确指引，非空泛 TODO。Task 8 Step 5 e2e 标注「可选/待真实模型」。其余步骤均有完整代码。可接受。

**3. 类型一致性：** `AskParams`/`AskReply`/`AskAnswer`/`AskErrorCode` 定义于 Task 1，Task 2/3/5/6 引用一致；`askRegistry.ask/resolve/cancel/cancelAll/reset` 签名 Task 2 定义、Task 3/4 引用一致；`PendingAsk`/`selectPendingAsks`/`usePendingAsks` Task 5 定义、Task 6/7 引用一致；`makeAskTool`/`reconcileDanglingAsks` Task 3 定义、Task 3 引用一致。WS 事件 `agent:answer`(reply)/`agent:cancel-ask` Task 1 定义、Task 4/6 引用一致。✓

**已知简化/风险（实现期留意）：**
- `mock.module("../src/ws-instance", …)`（Task 6）若当前 bun 版本不支持，改用 prop 注入 `send`。已在 Task 6 Step 4 注明。
- `typebox` 可解析性（Task 3 Step 1）已给 `bun add` 兜底。
- `session.agent.state.messages` 赋值（Task 3）依赖 SDK 0.80.x 行为；若该赋值不生效，`reconcileDanglingAsks` 仍保证单元测试正确，运行期兜底降级为「不注入但不崩溃」（用 try/catch 包裹赋值）——实现时加 try/catch。
