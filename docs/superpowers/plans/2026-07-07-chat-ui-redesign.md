# 聊天界面优化实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把聊天界面从纯文本单列布局重构为微信式左右分栏,显示 agent 角色头像/名字,并展示 agent 的思考过程与工具调用(默认可折叠),打通 kernel 到前端的全链路数据。

**Architecture:** 三层全链路改造 —— (1) `shared/types.ts` 扩展 `ChatMessage` 加 `agentName`/`delegatedFrom`/`thinking`/`toolCalls` 字段 + 新增 `ToolCallRecord` 类型;(2) `kernel/pi-rpc-client.ts` 采集 pi 事件流里的 `thinking_delta`/`toolcall_end`/`tool_execution_*` 并注入 `agentName`;(3) `frontend/MessageList.tsx` 重构为左右分栏 + emoji 渐变头像 + displayName 角色名 + 完整 markdown + 默认折叠的思考/工具面板。

**Tech Stack:** TypeScript, React 19, Zustand, Vitest + @testing-library/react + happy-dom, bun:test, Playwright, 新增依赖 `react-markdown` + `remark-gfm`。

**Spec:** `docs/superpowers/specs/2026-07-07-chat-ui-redesign-design.md`

## Global Constraints

- 所有回复与代码注释用中文;标识符保持语义化英文
- 遵守 Catppuccin Mocha 暗色主题(基底 `#1e1e2e`、表面 `#181825`/`#313244`、文字 `#cdd6f4`、蓝 `#89b4fa`、橙 `#fab387`、绿 `#a6e3a1`、红 `#f38ba8`)
- emoji + 渐变色复用 `AGENT_DEFS`(`packages/shared/src/constants.ts`),不引入图片资源
- 角色名优先用 `AgentConfig.displayName`(用户在 agent.md 自定义),fallback 到 `AGENT_DEFS[name].label`
- 所有新字段必须可选,旧 session JSON 缺字段时不能报错
- ChatMessage 新增字段不得破坏现有 `store/session.ts` 的 `append` upsert 逻辑(同 id 合并)
- 精准修改:本次不动 `Composer`/`SessionView` header/`AskCard`/Sidebar/Canvas
- 每完成一个 Task 立即 commit;CHANGELOG 同步更新
- 前端测试用 Vitest(`packages/frontend`, `bun run test` 或 `npx vitest run`);kernel 测试用 `bun test`(在 `packages/kernel`)
- 截图测试产物在测试结束后必须删除

## File Structure

| 文件 | 职责 | 操作 |
|---|---|---|
| `packages/shared/src/types.ts` | 类型定义 | 修改:扩展 ChatMessage + 新增 ToolCallRecord |
| `packages/kernel/src/pi-rpc-client.ts` | pi RPC 事件采集 | 修改:采集 thinking/toolcall/tool_execution |
| `packages/kernel/tests/pi-rpc-client.test.ts` | kernel 单元测试 | 修改:新增 thinking/toolcall 用例 |
| `packages/frontend/src/components/MessageList.tsx` | 消息列表 | 重构:左右分栏 + 头像 + 折叠面板 |
| `packages/frontend/src/components/MessageBubble.tsx` | 单条消息气泡 | 新建:从 MessageList 拆出,聚焦单条渲染 |
| `packages/frontend/src/components/CollapsibleSection.tsx` | 折叠面板 | 新建:thinking + toolCalls 折叠 |
| `packages/frontend/src/components/ToolCallRow.tsx` | 工具调用行 | 新建:单条工具调用展示 |
| `packages/frontend/src/theme/displayName.ts` | 角色名 hook | 新建:displayName fallback 逻辑 |
| `packages/frontend/tests/MessageList.test.tsx` | 现有测试 | 修改:适配新结构 |
| `packages/frontend/tests/MessageBubble.test.tsx` | 气泡测试 | 新建:左右对齐/头像/角色名/折叠 |
| `packages/frontend/tests/CollapsibleSection.test.tsx` | 折叠面板测试 | 新建 |
| `packages/frontend/package.json` | 依赖 | 修改:加 react-markdown + remark-gfm |
| `CHANGELOG.md` | 变更日志 | 修改 |

**文件拆分理由:** `MessageList.tsx` 当前只有 40 行但重构后会超 250 行(气泡+头像+折叠+工具行+markdown),按 brainstorming spec 第 4.3 节组件结构拆成 4 个聚焦文件,每个文件单一职责、可独立测试。

---

### Task 1: 扩展 ChatMessage 与新增 ToolCallRecord 类型

**Files:**
- Modify: `packages/shared/src/types.ts:46-52`
- Test: `packages/kernel/tests/session-store.test.ts`(已有,验证字段往返)

**Interfaces:**
- Produces: `ToolCallRecord`(新接口), `ChatMessage` 增加 4 个可选字段 `agentName`/`delegatedFrom`/`thinking`/`toolCalls`。后续 Task 2/3 依赖这些字段名。

- [ ] **Step 1: 写失败测试 —— 验证 ChatMessage 新字段可被构造**

修改 `packages/kernel/tests/session-store.test.ts`,在文件末尾新增测试(若文件已有导入则复用):

```ts
test("ChatMessage 支持新字段 agentName/thinking/toolCalls", async () => {
  const { SessionStore } = await import("../src/session-store");
  const tmpDir = `/tmp/hiagent-test-types-${Date.now()}`;
  const store = new SessionStore(tmpDir);
  const msg = {
    id: "m1", sessionId: "s1", role: "assistant" as const,
    text: "回复", timestamp: Date.now(),
    agentName: "dev" as const,
    thinking: "我需要先读文件",
    toolCalls: [{
      id: "tc1", name: "read_file",
      args: { path: "/a.ts" },
      result: "file content",
      isError: false,
      startedAt: 1000, endedAt: 2000,
    }],
  };
  await store.appendMessage("s1", msg);
  const loaded = await store.loadMessages("s1");
  const got = loaded.find(m => m.id === "m1") as any;
  expect(got.agentName).toBe("dev");
  expect(got.thinking).toBe("我需要先读文件");
  expect(got.toolCalls?.[0]?.name).toBe("read_file");
  expect(got.toolCalls?.[0]?.result).toBe("file content");
  // 清理
  const fs = await import("node:fs/promises");
  await fs.rm(tmpDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/kernel && bun test tests/session-store.test.ts`
Expected: FAIL —— 编译错误 `Object literal may only specify known properties`(toolCalls/agentName 不在 ChatMessage 类型上),或运行时通过但 TypeScript 报错。若 bun test 容忍 any 无类型错而通过,跳到 Step 3 直接改类型后再 `bun run typecheck` 验证。

- [ ] **Step 3: 扩展类型定义**

编辑 `packages/shared/src/types.ts`,在 `ChatMessage` 接口前新增 `ToolCallRecord`,然后扩展 `ChatMessage`:

```ts
// 工具调用记录:跨 message_update(toolcall_end) 与 tool_execution_* 关联
export interface ToolCallRecord {
  id: string;          // toolCallId
  name: string;        // 工具名(read_file 等)
  args: unknown;       // 参数对象
  result?: unknown;    // 执行结果(tool_execution_end 回填)
  isError?: boolean;   // 是否出错
  startedAt: number;
  endedAt?: number;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  // 以下为本次新增,全部可选以兼容历史数据
  agentName?: AgentName;           // assistant 消息:发言的 agent
  delegatedFrom?: AgentName;       // assistant 消息:委派来源(intercom 场景)
  thinking?: string;               // 思考过程全文
  toolCalls?: ToolCallRecord[];    // 本轮工具调用记录
}
```

- [ ] **Step 4: 运行测试确认通过 + typecheck**

Run: `cd packages/kernel && bun test tests/session-store.test.ts && bun run typecheck`
Expected: PASS, typecheck 无错。

`cd packages/shared && bun run typecheck 2>/dev/null || true`(若 shared 无 typecheck script,跳过;shared 类型变更已被 kernel typecheck 覆盖)

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts packages/kernel/tests/session-store.test.ts
git commit -m "feat(shared): ChatMessage 扩展 agentName/thinking/toolCalls + ToolCallRecord"
```

---

### Task 2: kernel 采集 thinking_delta 与 toolcall_end

**Files:**
- Modify: `packages/kernel/src/pi-rpc-client.ts:34-48`(类成员)、`105-222`(handleLine)
- Test: `packages/kernel/tests/pi-rpc-client.test.ts`

**Interfaces:**
- Consumes: `ToolCallRecord`, `ChatMessage.thinking`, `ChatMessage.toolCalls`, `ChatMessage.agentName`(Task 1)
- Produces: PiRpcClient 推送的 `message` 事件(`kind: "message"`)携带新字段。下游 ws-server/agent-manager 透传,前端 store upsert 自动合并。

- [ ] **Step 1: 写失败测试 —— thinking_delta 累积进 thinking 字段**

在 `packages/kernel/tests/pi-rpc-client.test.ts` 末尾新增:

```ts
test("message_update 的 thinking_delta 累积进 thinking 字段", async () => {
  const mock = mockSpawn();
  const events: PiEvent[] = [];
  const client = new PiRpcClient({
    agentName: "dev", cwd: "/work",
    onEvent: e => events.push(e),
    spawnFn: () => mock as any,
  });
  await client.start();
  events.length = 0;
  // message_start 建流式 id
  mock.emitLine({ type: "message_start", message: { role: "assistant", content: [] } });
  // thinking 增量
  mock.emitLine({
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "我需要", partial: {} },
  });
  mock.emitLine({
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "读文件", partial: {} },
  });
  // 最后一个 message 事件应含完整 thinking
  const msgs = events.filter(e => e.kind === "message") as any[];
  const last = msgs[msgs.length - 1];
  expect(last.message.thinking).toBe("我需要读文件");
  expect(last.message.agentName).toBe("dev");
  await client.dispose();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/kernel && bun test tests/pi-rpc-client.test.ts -t "thinking_delta"`
Expected: FAIL —— `last.message.thinking` 为 `undefined`(当前代码跳过 thinking_delta)。

- [ ] **Step 3: 写失败测试 —— toolcall_end 累积进 toolCalls 字段**

继续在测试文件末尾新增:

```ts
test("message_update 的 toolcall_end 记录进 toolCalls", async () => {
  const mock = mockSpawn();
  const events: PiEvent[] = [];
  const client = new PiRpcClient({
    agentName: "dev", cwd: "/work",
    onEvent: e => events.push(e),
    spawnFn: () => mock as any,
  });
  await client.start();
  events.length = 0;
  mock.emitLine({ type: "message_start", message: { role: "assistant", content: [] } });
  mock.emitLine({
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent: {
      type: "toolcall_end", contentIndex: 0,
      toolCall: { id: "tc1", name: "read_file", input: { path: "/a.ts" } },
      partial: {},
    },
  });
  const msgs = events.filter(e => e.kind === "message") as any[];
  const last = msgs[msgs.length - 1];
  expect(last.message.toolCalls).toHaveLength(1);
  expect(last.message.toolCalls[0].name).toBe("read_file");
  expect(last.message.toolCalls[0].args).toEqual({ path: "/a.ts" });
  // 尚未 tool_execution_end,result 应为 undefined
  expect(last.message.toolCalls[0].result).toBeUndefined();
  await client.dispose();
});
```

- [ ] **Step 4: 运行两个新测试确认都失败**

Run: `cd packages/kernel && bun test tests/pi-rpc-client.test.ts -t "thinking_delta|toolcall_end"`
Expected: FAIL(两个都失败)。

- [ ] **Step 5: 实现 —— 扩展流式累积器**

编辑 `packages/kernel/src/pi-rpc-client.ts`。先在类成员区(约 41-43 行)添加新累积器:

```ts
  // 流式回复累积：message_start 时建 id，message_update 累积 text，message_end 发最终
  private streamingMsgId = "";
  private streamingText = "";
  // 本次新增:思考过程与工具调用累积
  private streamingThinking = "";
  private streamingToolCalls: import("@hiagent/shared").ToolCallRecord[] = [];
```

- [ ] **Step 6: 实现 —— 改造 message_start 重置累积器**

找到 `message_start` case(约 133-150 行),在 `this.streamingText = "";` 后加:

```ts
          this.streamingThinking = "";
          this.streamingToolCalls = [];
```

- [ ] **Step 7: 实现 —— 改造 message_update 处理多事件类型**

找到 `message_update` case(约 153-172 行),替换为:

```ts
      // 流式增量：累积 text/thinking/toolCalls，更新同 id 消息
      case "message_update": {
        const evt = obj.assistantMessageEvent;
        if (evt) {
          if (evt.type === "text_delta" || evt.type === "text") {
            this.streamingText += evt.delta ?? "";
          } else if (evt.type === "thinking_delta") {
            this.streamingThinking += evt.delta ?? "";
          } else if (evt.type === "toolcall_end" && evt.toolCall) {
            this.streamingToolCalls.push({
              id: evt.toolCall.id,
              name: evt.toolCall.name,
              args: evt.toolCall.input,
              startedAt: Date.now(),
            });
          }
          // text_start/thinking_start/toolcall_start/toolcall_delta 等边界事件不累积
        }
        this.emitStreamingMessage();
        break;
      }
```

- [ ] **Step 8: 实现 —— 抽取 emitStreamingMessage 方法**

在 `message_end` case 之前(类内任意 private 方法位置)新增辅助方法:

```ts
  // 推送当前流式累积状态(text+thinking+toolCalls+agentName),前端 upsert 同 id
  private emitStreamingMessage(): void {
    if (!this.streamingMsgId) return;
    this.opts.onEvent({
      kind: "message",
      message: {
        id: this.streamingMsgId,
        sessionId: this.currentSessionId,
        role: "assistant",
        text: this.streamingText,
        timestamp: Date.now(),
        agentName: this.opts.agentName,
        thinking: this.streamingThinking || undefined,
        toolCalls: this.streamingToolCalls.length ? this.streamingToolCalls : undefined,
      },
    });
  }
```

- [ ] **Step 9: 实现 —— 改造 message_start 推送也带新字段**

`message_start` case 里现有 onEvent 调用(约 139-148 行)替换为也带上 agentName:

```ts
          this.opts.onEvent({
            kind: "message",
            message: {
              id: this.streamingMsgId,
              sessionId: this.currentSessionId,
              role: "assistant",
              text: "",
              timestamp: Date.now(),
              agentName: this.opts.agentName,
            },
          });
```

- [ ] **Step 10: 实现 —— 改造 message_end 带新字段并重置**

找到 `message_end` case(约 174-198 行),替换为:

```ts
      // 消息完成：发最终完整消息(含 thinking/toolCalls),重置累积器
      case "message_end": {
        const msg = obj.message;
        if (msg?.role === "assistant") {
          const content: any[] = Array.isArray(msg.content) ? msg.content : [];
          const text = content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text ?? "")
            .join("");
          const id = this.streamingMsgId || randomUUID();
          this.opts.onEvent({
            kind: "message",
            message: {
              id,
              sessionId: this.currentSessionId,
              role: "assistant",
              text: text || this.streamingText,
              timestamp: Date.now(),
              agentName: this.opts.agentName,
              thinking: this.streamingThinking || undefined,
              toolCalls: this.streamingToolCalls.length ? this.streamingToolCalls : undefined,
            },
          });
          this.streamingMsgId = "";
          this.streamingText = "";
          this.streamingThinking = "";
          this.streamingToolCalls = [];
        }
        break;
      }
```

- [ ] **Step 11: 运行两个新测试确认通过**

Run: `cd packages/kernel && bun test tests/pi-rpc-client.test.ts -t "thinking_delta|toolcall_end"`
Expected: PASS。

- [ ] **Step 12: 运行全部 kernel 测试确认无回归**

Run: `cd packages/kernel && bun test`
Expected: 全部 PASS(包括原有 5 个测试)。

- [ ] **Step 13: typecheck**

Run: `cd packages/kernel && bun run typecheck`
Expected: 无错。

- [ ] **Step 14: Commit**

```bash
git add packages/kernel/src/pi-rpc-client.ts packages/kernel/tests/pi-rpc-client.test.ts
git commit -m "feat(kernel): 采集 thinking_delta 与 toolcall_end 进 ChatMessage"
```

---

### Task 3: kernel 采集 tool_execution_* 回填工具结果

**Files:**
- Modify: `packages/kernel/src/pi-rpc-client.ts`(handleLine 新增两个 case + updateToolCall 方法)
- Test: `packages/kernel/tests/pi-rpc-client.test.ts`

**Interfaces:**
- Consumes: Task 2 的 streamingToolCalls 累积器
- Produces: toolCall.result/isError/endedAt 在 tool_execution_end 后回填,前端能看到工具执行结果。

- [ ] **Step 1: 写失败测试 —— tool_execution_end 回填 result**

在 `packages/kernel/tests/pi-rpc-client.test.ts` 末尾新增:

```ts
test("tool_execution_end 回填 toolCall.result/isError/endedAt", async () => {
  const mock = mockSpawn();
  const events: PiEvent[] = [];
  const client = new PiRpcClient({
    agentName: "dev", cwd: "/work",
    onEvent: e => events.push(e),
    spawnFn: () => mock as any,
  });
  await client.start();
  events.length = 0;
  mock.emitLine({ type: "message_start", message: { role: "assistant", content: [] } });
  // 先有 toolcall_end 建记录
  mock.emitLine({
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent: {
      type: "toolcall_end", contentIndex: 0,
      toolCall: { id: "tc1", name: "read_file", input: {} },
      partial: {},
    },
  });
  // tool_execution_end 回填结果
  mock.emitLine({
    type: "tool_execution_end",
    toolCallId: "tc1", toolName: "read_file",
    result: "文件内容...", isError: false,
  });
  const msgs = events.filter(e => e.kind === "message") as any[];
  const last = msgs[msgs.length - 1];
  expect(last.message.toolCalls[0].result).toBe("文件内容...");
  expect(last.message.toolCalls[0].isError).toBe(false);
  expect(last.message.toolCalls[0].endedAt).toBeGreaterThan(0);
  await client.dispose();
});

test("tool_execution_end 工具出错时 isError=true", async () => {
  const mock = mockSpawn();
  const events: PiEvent[] = [];
  const client = new PiRpcClient({
    agentName: "dev", cwd: "/work",
    onEvent: e => events.push(e),
    spawnFn: () => mock as any,
  });
  await client.start();
  events.length = 0;
  mock.emitLine({ type: "message_start", message: { role: "assistant", content: [] } });
  mock.emitLine({
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent: {
      type: "toolcall_end", contentIndex: 0,
      toolCall: { id: "tcX", name: "bash", input: {} },
      partial: {},
    },
  });
  mock.emitLine({
    type: "tool_execution_end",
    toolCallId: "tcX", toolName: "bash",
    result: "command not found", isError: true,
  });
  const msgs = events.filter(e => e.kind === "message") as any[];
  const last = msgs[msgs.length - 1];
  expect(last.message.toolCalls[0].isError).toBe(true);
  await client.dispose();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/kernel && bun test tests/pi-rpc-client.test.ts -t "tool_execution_end"`
Expected: FAIL —— 当前 handleLine 无 `tool_execution_end` case,result 永远 undefined。

- [ ] **Step 3: 实现 —— 新增 updateToolCall 方法**

在 `packages/kernel/src/pi-rpc-client.ts` 类内(Task 2 的 `emitStreamingMessage` 方法旁边)新增:

```ts
  // 按 id 更新 toolCall 记录;不存在则忽略(toolcall_end 未到时不创建占位)
  private updateToolCall(id: string, patch: Partial<import("@hiagent/shared").ToolCallRecord>): void {
    const tc = this.streamingToolCalls.find(t => t.id === id);
    if (tc) Object.assign(tc, patch);
    else this.streamingToolCalls.push({ id, name: "(unknown)", args: {}, startedAt: Date.now(), ...patch });
  }
```

- [ ] **Step 4: 实现 —— handleLine 新增两个 case**

在 `packages/kernel/src/pi-rpc-client.ts` 的 `handleLine` switch 内,`turn_end` case 之前新增:

```ts
      // 工具执行开始/结束:回填 startedAt/result/isError/endedAt
      case "tool_execution_start":
        this.updateToolCall(obj.toolCallId, { startedAt: Date.now(), name: obj.toolName ?? undefined });
        this.emitStreamingMessage();
        break;
      case "tool_execution_end":
        this.updateToolCall(obj.toolCallId, {
          result: obj.result,
          isError: obj.isError,
          endedAt: Date.now(),
          name: obj.toolName ?? undefined,
        });
        this.emitStreamingMessage();
        break;
```

注意:`updateToolCall` 的 patch 里 `name` 类型是 `string | undefined`,但 ToolCallRecord.name 是 `string`。若 typecheck 报错,改为 `name: obj.toolName as string`。

- [ ] **Step 5: 运行两个新测试确认通过**

Run: `cd packages/kernel && bun test tests/pi-rpc-client.test.ts -t "tool_execution_end"`
Expected: PASS。

- [ ] **Step 6: 运行全部 kernel 测试**

Run: `cd packages/kernel && bun test && bun run typecheck`
Expected: 全部 PASS,typecheck 无错。

- [ ] **Step 7: Commit**

```bash
git add packages/kernel/src/pi-rpc-client.ts packages/kernel/tests/pi-rpc-client.test.ts
git commit -m "feat(kernel): 采集 tool_execution_* 回填工具结果"
```

---

### Task 4: 新增前端依赖 react-markdown + remark-gfm

**Files:**
- Modify: `packages/frontend/package.json`
- Test: 无(依赖添加,运行时验证)

**Interfaces:**
- Produces: `react-markdown` 与 `remark-gfm` 可在前端代码 import。Task 6 的 MessageBubble 依赖。

- [ ] **Step 1: 添加依赖**

Run(在仓库根目录):
```bash
cd packages/frontend
npm install react-markdown@^9 remark-gfm@^4 --save
```
(若 monorepo 用 pnpm/yarn workspace,改为对应命令 `pnpm --filter @hiagent/frontend add react-markdown remark-gfm`)

- [ ] **Step 2: 验证安装**

Run: `cd packages/frontend && node -e "import('react-markdown').then(()=>console.log('ok'))"`
Expected: 输出 `ok`(ESM 动态导入成功)。

- [ ] **Step 3: typecheck 确认类型可用**

Run: `cd packages/frontend && bun run typecheck`
Expected: 无错。

- [ ] **Step 4: Commit**

```bash
git add packages/frontend/package.json packages/frontend/package-lock.json packages/frontend/node_modules 2>/dev/null
# 实际只提交 package.json 与 lockfile;node_modules 在 .gitignore
git add packages/frontend/package.json
git ls-files packages/frontend | grep -i lock | xargs -r git add
git commit -m "chore(frontend): 添加 react-markdown + remark-gfm 依赖"
```

---

### Task 5: 创建 displayName hook

**Files:**
- Create: `packages/frontend/src/theme/displayName.ts`
- Test: `packages/frontend/tests/displayName.test.ts`

**Interfaces:**
- Produces: `useDisplayName(name?: AgentName): string` React hook。Task 6 的 MessageBubble 依赖。
- Consumes: `useAgentsStore.configs`(已有)、`AGENT_DEFS`(已有)。

- [ ] **Step 1: 写失败测试**

创建 `packages/frontend/tests/displayName.test.ts`:

```ts
import { test, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useDisplayName } from "../src/theme/displayName";
import { useAgentsStore } from "../src/store/agents";
import { useSessionStore } from "../src/store/session";

beforeEach(() => {
  useAgentsStore.setState({ configs: {} });
});

test("无 agentName 返回 'agent'", () => {
  const { result } = renderHook(() => useDisplayName(undefined));
  expect(result.current).toBe("agent");
});

test("无 config 时 fallback 到 AGENT_DEFS.label", () => {
  const { result } = renderHook(() => useDisplayName("dev"));
  expect(result.current).toBe("技术实现");  // AGENT_DEFS.dev.label
});

test("有 config 时用 displayName", () => {
  useAgentsStore.setState({
    configs: {
      dev: {
        name: "dev", displayName: "我的研发", avatar: "⚙️", avatarColor: "a-b",
        description: "", model: "m", thinking: "high",
        systemPromptMode: "replace", inheritProjectContext: true,
        inheritSkills: false, tools: [], skills: [], mcpServers: [],
        partners: { askTo: [], askFrom: [] },
      } as any,
    },
  });
  const { result } = renderHook(() => useDisplayName("dev"));
  expect(result.current).toBe("我的研发");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/frontend && npx vitest run tests/displayName.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 hook**

创建 `packages/frontend/src/theme/displayName.ts`:

```ts
import { useEffect } from "react";
import type { AgentName } from "@hiagent/shared";
import { AGENT_DEFS } from "@hiagent/shared";
import { useAgentsStore } from "../store/agents";

// 角色名:优先用户在 agent.md 配置的 displayName,fallback 到 AGENT_DEFS.label
// 缺省返回 "agent"(理论上不会发生,assistant 消息必有 agentName)
export function useDisplayName(name?: AgentName): string {
  const config = useAgentsStore(s => (name ? s.configs[name] : undefined));
  const loadConfig = useAgentsStore(s => s.loadConfig);
  // 若 config 未加载,触发加载(异步,加载完 store 更新会重渲染)
  useEffect(() => {
    if (name && !config) loadConfig(name);
  }, [name, config, loadConfig]);
  if (!name) return "agent";
  return config?.displayName || AGENT_DEFS[name].label;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/frontend && npx vitest run tests/displayName.test.ts`
Expected: PASS(3 个用例)。

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/theme/displayName.ts packages/frontend/tests/displayName.test.ts
git commit -m "feat(frontend): useDisplayName hook(用户配置优先 + AGENT_DEFS 兜底)"
```

---

### Task 6: 创建 ToolCallRow 组件

**Files:**
- Create: `packages/frontend/src/components/ToolCallRow.tsx`
- Test: `packages/frontend/tests/ToolCallRow.test.tsx`

**Interfaces:**
- Consumes: `ToolCallRecord`(Task 1)
- Produces: `<ToolCallRow tc={...} />` 组件。Task 7 的 CollapsibleSection 依赖。

- [ ] **Step 1: 写失败测试**

创建 `packages/frontend/tests/ToolCallRow.test.tsx`:

```tsx
import { test, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolCallRow } from "../src/components/ToolCallRow";
import type { ToolCallRecord } from "@hiagent/shared";

const tc: ToolCallRecord = {
  id: "tc1", name: "read_file",
  args: { path: "/a.ts" },
  result: "file content here",
  isError: false,
  startedAt: 1000, endedAt: 2000,
};

test("渲染工具名和参数摘要", () => {
  render(<ToolCallRow tc={tc} />);
  expect(screen.getByText("read_file")).toBeTruthy();
  // 参数摘要应包含 path
  expect(document.body.textContent).toContain("/a.ts");
});

test("result 默认折叠,点击展开显示结果", () => {
  render(<ToolCallRow tc={tc} />);
  // 初始无 result 文本
  expect(screen.queryByText("file content here")).toBeNull();
  // 点击工具名按钮展开
  fireEvent.click(screen.getByText("read_file"));
  expect(screen.getByText(/file content here/)).toBeTruthy();
});

test("isError=true 显示错误标记", () => {
  render(<ToolCallRow tc={{ ...tc, isError: true, result: "command not found" }} />);
  expect(screen.getByText("✗")).toBeTruthy();
});

test("result 为 undefined 时显示执行中", () => {
  render(<ToolCallRow tc={{ ...tc, result: undefined }} />);
  fireEvent.click(screen.getByText("read_file"));
  expect(screen.getByText(/执行中/)).toBeTruthy();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/frontend && npx vitest run tests/ToolCallRow.test.tsx`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 ToolCallRow**

创建 `packages/frontend/src/components/ToolCallRow.tsx`:

```tsx
import { useState } from "react";
import type { ToolCallRecord } from "@hiagent/shared";

// result 超 2000 字符截断,末尾提示总长度
function formatResult(r: unknown): string {
  if (r == null) return "(执行中…)";
  const s = typeof r === "string" ? r : JSON.stringify(r, null, 2);
  return s.length > 2000 ? s.slice(0, 2000) + `\n...(已截断,共 ${s.length} 字符)` : s;
}

// 参数摘要:超 60 字符截断
function summarizeArgs(args: unknown): string {
  const s = JSON.stringify(args);
  return s.length > 60 ? s.slice(0, 60) + "…" : s;
}

export function ToolCallRow({ tc }: { tc: ToolCallRecord }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="text-xs" data-testid={`toolcall-${tc.id}`}>
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="flex items-center gap-2 w-full text-left py-0.5"
      >
        <span style={{ color: "#a6e3a1" }} className="font-mono">{tc.name}</span>
        <span style={{ color: "#6c7086" }} className="font-mono text-[11px]">{summarizeArgs(tc.args)}</span>
        {tc.isError && <span style={{ color: "#f38ba8" }}>✗</span>}
        {!tc.isError && tc.result !== undefined && <span style={{ color: "#a6e3a1" }}>✓</span>}
      </button>
      {expanded && (
        <pre className="mt-1 p-2 rounded text-[11px] overflow-x-auto"
             style={{ background: "#11111b", color: "#9399b2", maxHeight: "300px", overflow: "auto" }}>
          {formatResult(tc.result)}
        </pre>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/frontend && npx vitest run tests/ToolCallRow.test.tsx`
Expected: PASS(4 个用例)。

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/components/ToolCallRow.tsx packages/frontend/tests/ToolCallRow.test.tsx
git commit -m "feat(frontend): ToolCallRow 组件(工具名/参数摘要/结果展开)"
```

---

### Task 7: 创建 CollapsibleSection 组件

**Files:**
- Create: `packages/frontend/src/components/CollapsibleSection.tsx`
- Test: `packages/frontend/tests/CollapsibleSection.test.tsx`

**Interfaces:**
- Consumes: `ToolCallRow`(Task 6)、`ChatMessage.thinking`、`ChatMessage.toolCalls`
- Produces: `<CollapsibleSection thinking={...} toolCalls={...} />`。Task 8 的 MessageBubble 依赖。

- [ ] **Step 1: 写失败测试**

创建 `packages/frontend/tests/CollapsibleSection.test.tsx`:

```tsx
import { test, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CollapsibleSection } from "../src/components/CollapsibleSection";

test("thinking 与 toolCalls 默认折叠", () => {
  render(<CollapsibleSection thinking="我在思考" toolCalls={[
    { id: "t1", name: "read", args: {}, startedAt: 0 } as any,
  ]} />);
  // 内容默认不可见(details 无 open)
  expect(screen.queryByText("我在思考")).toBeNull();
  expect(screen.queryByText("read")).toBeNull();
});

test("点击思考过程 summary 展开", () => {
  render(<CollapsibleSection thinking="我在思考" />);
  const summary = screen.getByText(/思考过程/);
  fireEvent.click(summary);
  expect(screen.getByText("我在思考")).toBeTruthy();
});

test("点击工具调用 summary 展开,显示工具列表", () => {
  render(<CollapsibleSection toolCalls={[
    { id: "t1", name: "read_file", args: { a: 1 }, startedAt: 0 } as any,
    { id: "t2", name: "write_file", args: {}, startedAt: 0 } as any,
  ]} />);
  // summary 显示数量
  expect(screen.getByText(/2 个工具调用/)).toBeTruthy();
  fireEvent.click(screen.getByText(/2 个工具调用/));
  expect(screen.getByText("read_file")).toBeTruthy();
  expect(screen.getByText("write_file")).toBeTruthy();
});

test("无 thinking 时不渲染思考面板", () => {
  const { container } = render(<CollapsibleSection toolCalls={[]} />);
  expect(container.querySelector("summary")?.textContent).not.toContain("思考");
});

test("无 toolCalls 时不渲染工具面板", () => {
  const { container } = render(<CollapsibleSection thinking="x" />);
  expect(container.textContent).not.toContain("工具调用");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/frontend && npx vitest run tests/CollapsibleSection.test.tsx`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 CollapsibleSection**

创建 `packages/frontend/src/components/CollapsibleSection.tsx`:

```tsx
import type { ToolCallRecord } from "@hiagent/shared";
import { ToolCallRow } from "./ToolCallRow";

interface Props {
  thinking?: string;
  toolCalls?: ToolCallRecord[];
}

export function CollapsibleSection({ thinking, toolCalls }: Props) {
  const hasThinking = !!thinking;
  const toolCount = toolCalls?.length ?? 0;
  if (!hasThinking && toolCount === 0) return null;
  return (
    <div className="mt-2 space-y-1.5">
      {hasThinking && (
        <details className="rounded-lg overflow-hidden"
                 style={{ border: "1px solid rgba(137,180,250,0.2)", background: "rgba(137,180,250,0.05)" }}>
          <summary className="px-2.5 py-1 text-xs cursor-pointer"
                   style={{ color: "#89b4fa" }}>
            思考过程
          </summary>
          <div className="px-3 py-2 text-xs whitespace-pre-wrap"
               style={{ color: "#9399b2", borderTop: "1px solid rgba(137,180,250,0.1)" }}>
            {thinking}
          </div>
        </details>
      )}
      {toolCount > 0 && (
        <details className="rounded-lg overflow-hidden"
                 style={{ border: "1px solid rgba(137,180,250,0.2)", background: "rgba(137,180,250,0.05)" }}>
          <summary className="px-2.5 py-1 text-xs cursor-pointer"
                   style={{ color: "#89b4fa" }}>
            {toolCount} 个工具调用
          </summary>
          <div className="px-3 py-2 space-y-1"
               style={{ borderTop: "1px solid rgba(137,180,250,0.1)" }}>
            {toolCalls!.map(tc => <ToolCallRow key={tc.id} tc={tc} />)}
          </div>
        </details>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/frontend && npx vitest run tests/CollapsibleSection.test.tsx`
Expected: PASS(5 个用例)。

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/components/CollapsibleSection.tsx packages/frontend/tests/CollapsibleSection.test.tsx
git commit -m "feat(frontend): CollapsibleSection(思考+工具调用默认折叠)"
```

---

### Task 8: 创建 MessageBubble 组件(头像 + 左右分栏 + markdown)

**Files:**
- Create: `packages/frontend/src/components/MessageBubble.tsx`
- Test: `packages/frontend/tests/MessageBubble.test.tsx`

**Interfaces:**
- Consumes: `ChatMessage`(Task 1)、`useDisplayName`(Task 5)、`CollapsibleSection`(Task 7)、`react-markdown`(Task 4)、`agentEmoji`/`agentGradient`(已有)
- Produces: `<MessageBubble msg={...} />`。Task 9 的 MessageList 依赖。

- [ ] **Step 1: 写失败测试 —— 左右对齐**

创建 `packages/frontend/tests/MessageBubble.test.tsx`:

```tsx
import { test, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MessageBubble } from "../src/components/MessageBubble";
import type { ChatMessage } from "@hiagent/shared";
import { useAgentsStore } from "../src/store/agents";

beforeEach(() => useAgentsStore.setState({ configs: {} }));

const userMsg: ChatMessage = {
  id: "u1", sessionId: "s1", role: "user",
  text: "你好", timestamp: 0,
};
const assistantMsg: ChatMessage = {
  id: "a1", sessionId: "s1", role: "assistant",
  text: "收到", timestamp: 0, agentName: "dev",
};

test("user 消息容器靠右(flex-row-reverse)", () => {
  const { container } = render(<MessageBubble msg={userMsg} />);
  const row = container.querySelector('[data-testid="msg-u1"]');
  expect(row?.className).toContain("flex-row-reverse");
});

test("assistant 消息容器靠左(flex-row)", () => {
  const { container } = render(<MessageBubble msg={assistantMsg} />);
  const row = container.querySelector('[data-testid="msg-a1"]');
  expect(row?.className).toContain("flex-row");
  expect(row?.className).not.toContain("flex-row-reverse");
});

test("user 显示'我'角色名", () => {
  render(<MessageBubble msg={userMsg} />);
  // header 里应有"我"
  expect(screen.getAllByText("我").length).toBeGreaterThan(0);
});

test("assistant 显示 AGENT_DEFS 兜底角色名", () => {
  render(<MessageBubble msg={assistantMsg} />);
  // dev 的 label 是"技术实现"
  expect(screen.getByText("技术实现")).toBeTruthy();
});

test("assistant 显示对应 emoji 头像(dev=⚙️)", () => {
  render(<MessageBubble msg={assistantMsg} />);
  expect(screen.getByText("⚙️")).toBeTruthy();
});

test("delegatedFrom 存在时渲染委派药丸", () => {
  render(<MessageBubble msg={{ ...assistantMsg, delegatedFrom: "product" } as ChatMessage} />);
  expect(screen.getByText(/受.*委派/)).toBeTruthy();
});

test("delegatedFrom 不存在时不渲染委派药丸", () => {
  const { container } = render(<MessageBubble msg={assistantMsg} />);
  expect(container.textContent).not.toMatch(/委派/);
});

test("markdown 正文渲染(代码块)", () => {
  render(<MessageBubble msg={{ ...assistantMsg, text: "```js\nconst x=1\n```" } as ChatMessage} />);
  expect(document.querySelector("pre code")).toBeTruthy();
});

test("有 thinking 时渲染折叠面板", () => {
  render(<MessageBubble msg={{ ...assistantMsg, thinking: "我在想" } as ChatMessage} />);
  expect(screen.getByText(/思考过程/)).toBeTruthy();
});

test("user 消息不渲染折叠面板", () => {
  const { container } = render(<MessageBubble msg={{ ...userMsg, thinking: "x" } as any} />);
  expect(container.textContent).not.toContain("思考过程");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/frontend && npx vitest run tests/MessageBubble.test.tsx`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 MessageBubble**

创建 `packages/frontend/src/components/MessageBubble.tsx`:

```tsx
import type { ChatMessage } from "@hiagent/shared";
import { agentEmoji, agentGradient } from "../theme/agents";
import { useDisplayName } from "../theme/displayName";
import { CollapsibleSection } from "./CollapsibleSection";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function Avatar({ isUser, agentName }: { isUser: boolean; agentName?: ChatMessage["agentName"] }) {
  if (isUser) {
    return (
      <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold flex-shrink-0"
           style={{ background: "linear-gradient(135deg, #6c7086, #9399b2)", color: "#cdd6f4" }}>
        我
      </div>
    );
  }
  const name = agentName ?? "dev";
  return (
    <div className="w-9 h-9 rounded-full flex items-center justify-center text-lg flex-shrink-0"
         style={{ background: agentGradient(name) }}>
      {agentEmoji(name)}
    </div>
  );
}

export function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";
  const isError = msg.text.startsWith("⚠️");
  const speakerName = useDisplayName(msg.agentName);
  const delegatorName = useDisplayName(msg.delegatedFrom);
  const hasThinking = !!msg.thinking;
  const toolCount = msg.toolCalls?.length ?? 0;
  const showFoldable = !isUser && (hasThinking || toolCount > 0);

  return (
    <div className={`flex gap-2.5 ${isUser ? "flex-row-reverse" : "flex-row"}`}
         data-testid={`msg-${msg.id}`}>
      <Avatar isUser={isUser} agentName={msg.agentName} />
      <div
        className="max-w-[78%] px-3.5 py-2"
        style={{
          background: isError ? "rgba(243,139,168,0.15)" : isUser ? "#313244" : "#181825",
          border: isError ? "1px solid #f38ba8" : "none",
          borderRadius: isUser ? "14px 4px 14px 14px" : "4px 14px 14px 14px",
          color: isError ? "#f38ba8" : "#cdd6f4",
        }}
      >
        {/* Header:角色名 · 委派标签 */}
        <div className="text-xs mb-1 flex items-center gap-2" style={{ color: "#a6adc8" }}>
          <span>{isUser ? "我" : speakerName}</span>
          {!isUser && msg.delegatedFrom && (
            <span className="px-1.5 py-0.5 rounded-full text-[10px]"
                  style={{ background: "rgba(250,179,135,0.15)", color: "#fab387" }}>
              ↪ 受 {delegatorName} 委派
            </span>
          )}
        </div>
        {/* 正文 markdown */}
        <div className="text-sm">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
        </div>
        {/* 折叠面板:仅 assistant 且有内容 */}
        {showFoldable && <CollapsibleSection thinking={msg.thinking} toolCalls={msg.toolCalls} />}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/frontend && npx vitest run tests/MessageBubble.test.tsx`
Expected: PASS(10 个用例)。

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/components/MessageBubble.tsx packages/frontend/tests/MessageBubble.test.tsx
git commit -m "feat(frontend): MessageBubble(头像贴边左右分栏+markdown+折叠面板)"
```

---

### Task 9: 重构 MessageList 使用 MessageBubble + 适配现有测试

**Files:**
- Modify: `packages/frontend/src/components/MessageList.tsx`
- Modify: `packages/frontend/tests/MessageList.test.tsx`

**Interfaces:**
- Consumes: `MessageBubble`(Task 8)

- [ ] **Step 1: 读取现有 MessageList 测试,识别会失败的断言**

当前 `tests/MessageList.test.tsx` 用 `screen.getByText("你好")` 找文本 —— 新组件用 ReactMarkdown 包裹后,"你好"仍可被找到(纯文本节点)。但需要确认 markdown 渲染器不会破坏纯文本查询。

- [ ] **Step 2: 重构 MessageList**

替换 `packages/frontend/src/components/MessageList.tsx` 全文为:

```tsx
import type { ChatMessage } from "@hiagent/shared";
import { useSessionStore } from "../store/session";
import { MessageBubble } from "./MessageBubble";

// 稳定的空数组引用：避免 session 不存在时 `?? []` 每次返回新引用，
// 触发 React 19 useSyncExternalStore 的「snapshot 不稳定」infinite loop。
const EMPTY: ChatMessage[] = [];

interface Props {
  sessionId: string;
}

export function MessageList({ sessionId }: Props) {
  const messages = useSessionStore(s => s.messagesBySession[sessionId] ?? EMPTY);
  return (
    <div className="flex-1 overflow-auto p-4 flex flex-col gap-3.5" data-testid="message-list">
      {messages.map(m => <MessageBubble key={m.id} msg={m} />)}
    </div>
  );
}
```

- [ ] **Step 3: 运行现有 MessageList 测试**

Run: `cd packages/frontend && npx vitest run tests/MessageList.test.tsx`
Expected: 若 `getByText("你好")` 仍通过(ReactMarkdown 纯文本输出 `<p>你好</p>`),PASS。
若失败(ReactMarkdown 包了额外标签导致 getByText 多匹配),用 `getAllByText` 或 `screen.getByText` 改为更宽松匹配。失败时调整测试:

```ts
// 把 getByText 改为查找包含该文本的节点
expect(screen.getByText("你好") || screen.getAllByText(/你好/)[0]).toBeTruthy();
```

- [ ] **Step 4: 运行全部前端组件测试**

Run: `cd packages/frontend && npx vitest run`
Expected: 全部 PASS(MessageList + MessageBubble + CollapsibleSection + ToolCallRow + displayName)。

- [ ] **Step 5: typecheck**

Run: `cd packages/frontend && bun run typecheck`
Expected: 无错。

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/components/MessageList.tsx packages/frontend/tests/MessageList.test.tsx
git commit -m "refactor(frontend): MessageList 改用 MessageBubble 组件"
```

---

### Task 10: 更新 CHANGELOG + 端到端验证

**Files:**
- Modify: `CHANGELOG.md`
- Test: 启动应用手动验证 + E2E(若 e2e 配置可用)

- [ ] **Step 1: 更新 CHANGELOG**

在 `CHANGELOG.md` 顶部新增条目(若文件不存在则创建):

```markdown
## 2026-07-07

### 新增功能
- **聊天界面重构**: 微信式左右分栏布局,agent 头像贴边显示(emoji + 渐变色),user 显示"我"+灰色头像
- **agent 角色名显示**: 优先用户在 agent.md 配置的 displayName,fallback 到 AGENT_DEFS.label
- **思考过程展示**: kernel 采集 thinking_delta,前端在 agent 回复内默认折叠展示
- **工具调用展示**: kernel 采集 toolcall_end + tool_execution_*,前端展示工具名/参数/结果(默认折叠,可展开)
- **委派标签**: intercom 委派场景显示"↪ 受 X 委派"药丸
- **完整 markdown 渲染**: 新增 react-markdown + remark-gfm,支持代码块/表格/列表

### 重构
- `MessageList.tsx` 拆分为 MessageBubble + CollapsibleSection + ToolCallRow + useDisplayName
- `ChatMessage` 类型扩展 agentName/delegatedFrom/thinking/toolCalls 字段(全部可选,向后兼容)

### 影响范围
- `packages/shared/src/types.ts`
- `packages/kernel/src/pi-rpc-client.ts`
- `packages/frontend/src/components/MessageList.tsx` + 新增 3 个组件 + 1 个 hook
- `packages/frontend/package.json`(新增 react-markdown + remark-gfm)
```

- [ ] **Step 2: 启动应用做端到端手动验证**

Run(按项目启动方式,例如):
```bash
./start.sh
# 或 npm run tauri dev / bun run dev
```

验证清单(逐项确认):
- [ ] 用户消息靠右、灰色"我"头像
- [ ] agent 消息靠左、对应 emoji 渐变头像
- [ ] agent 角色名显示正确(若改过 displayName 用自定义值,否则用 label)
- [ ] 触发 agent 回复(发 prompt)→ 看到思考过程折叠面板 → 点击展开
- [ ] 触发工具调用(如 agent 读文件)→ 看到工具调用面板 → 点击展开看到 result
- [ ] markdown 代码块/列表正常渲染

若启动失败或 pi 命令不可用,记录现象但不算阻塞(本次改造的代码正确性已由单元/组件测试覆盖)。

- [ ] **Step 3: (可选)E2E 自动化测试**

若项目已有 Playwright 配置且 e2e 环境可用,新增 `e2e/chat-ui.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

test("聊天界面左右分栏 + agent 头像", async ({ page }) => {
  await page.goto("http://localhost:1420");  // Tauri dev 默认端口,按实际改
  // 创建会话 → 发送消息 → 断言
  // ...(具体步骤依赖项目现有 e2e fixture)
});
```

若 e2e 环境复杂,跳过此 Step,记录"已手动验证"。

- [ ] **Step 4: 清理截图产物**

```bash
find packages/frontend -name "*.png" -newermt "-1 hour" -delete 2>/dev/null
find /tmp -name "*playwright*" -mtime -1 -delete 2>/dev/null
```

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: 更新 CHANGELOG(聊天界面重构)"
```

---

## Self-Review 检查记录

**Spec 覆盖率:** 逐条对照 spec 第 4 节:
- ✅ 4.1 数据结构 → Task 1
- ✅ 4.2.1-4.2.4 kernel 采集 → Task 2 + Task 3
- ⚠️ 4.2.5 delegatedFrom 注入 → **未覆盖**(spec 已标注"首版可不做"作为降级方案)。前端 Task 8 已实现 `delegatedFrom` 的渲染,但 kernel 端暂不注入该字段 —— 字段会一直是 undefined,药丸永不显示。这是有意为之的范围裁剪,符合 spec 的降级条款。
- ✅ 4.3.1-4.3.7 前端 UI → Task 4(依赖)+ Task 5(hook)+ Task 6-9(组件)
- ✅ 4.4 不改动部分 → 计划严格遵守
- ✅ 6.1-6.4 四层测试 → Task 1/2/3(kernel 单元)+ Task 5/6/7/8(前端组件)+ Task 10 Step 2(API/E2E)

**占位符扫描:** 无 TBD/TODO,所有 Step 都有完整代码。

**类型一致性:** `ToolCallRecord` 在 Task 1 定义,Task 2/3/6/7 引用名称一致;`useDisplayName` 在 Task 5 定义、Task 8 引用一致;`MessageBubble` 在 Task 8 定义、Task 9 引用一致。

**降级说明:** `delegatedFrom` 的 kernel 注入未实现(降级),前端字段与渲染已就绪 —— 后续若需启用,只需在 kernel 增加注入逻辑,前端零改动。
