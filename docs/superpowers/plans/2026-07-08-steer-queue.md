# Steer 消息队列 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现消息队列控制 — agent 运行中用户消息默认 followUp 排队，支持「引导」升级、「立即」执行、「取消」引导、「清空」排队。

**Architecture:** AgentManager 新增 5 个队列操作方法（promoteToSteer / immediate / clearSteeringQueue / clearFollowUpQueue），prompt() 改为默认 followUp。SDK 的 queue_update 事件通过已有 sdk:event 信封透传前端。WS 协议新增 4 个 steer 命令。

**Tech Stack:** TypeScript, Bun, @earendil-works/pi-coding-agent SDK

## Global Constraints

- 所有消息默认 followUp 排队（非 steer）
- queue_update 事件通过已有 sdk:event 透传，不新增 WS event 类型
- Kernel 层改动，前端 UI 不在本次范围
- 测试遵循 4 层金字塔要求
- Bun:test 用于 backend 逻辑测试

---

## File Map

| 文件 | 职责 | 操作 |
|---|---|---|
| `packages/shared/src/types.ts` | 新增 4 个 WSClientEvent + queue_update SDKEvent | Modify |
| `packages/kernel/src/agent-manager.ts` | prompt 改 followUp + 新增 5 个队列方法 | Modify |
| `packages/kernel/src/ws-server.ts` | agent:prompt 调整 + 4 个新 steer handler | Modify |
| `packages/kernel/tests/agent-manager.test.ts` | 更新 mock + 新增队列方法测试 | Modify |

---

### Task 1: shared/types.ts — 新增 WS 协议事件和 queue_update SDKEvent

**Files:**
- Modify: `packages/shared/src/types.ts`

**Interfaces:**
- Produces: `SteerPromoteEvent`, `SteerImmediateEvent`, `SteerCancelEvent`, `SteerClearQueueEvent`, 更新的 `WSClientEvent`, 更新的 `SDKEvent`

- [ ] **Step 1: 添加 4 个 Client → Kernel 事件接口**

在 `AbortEvent` 接口之后、`ProjectCreateEvent` 之前，插入 4 个 steer 事件：

```typescript
export interface SteerPromoteEvent {
  type: "steer:promote";
  sessionId: string;
  text: string;
  remainingTexts: string[];
}
export interface SteerImmediateEvent {
  type: "steer:immediate";
  sessionId: string;
  text: string;
  remainingTexts: string[];
}
export interface SteerCancelEvent {
  type: "steer:cancel";
  sessionId: string;
}
export interface SteerClearQueueEvent {
  type: "steer:clear-queue";
  sessionId: string;
}
```

- [ ] **Step 2: 将 4 个事件加入 WSClientEvent 联合类型**

找到 `export type WSClientEvent =` 行（约 L184），在 `| ProjectsListRequest` 之前插入：

```typescript
  | SteerPromoteEvent | SteerImmediateEvent | SteerCancelEvent | SteerClearQueueEvent
```

- [ ] **Step 3: 在 SDKEvent 联合类型中新增 queue_update**

找到 `SDKEvent` 类型定义（约 L233），在最后一个 `| { type: "tool_execution_end"; ... }` 之后、`;` 之前，插入：

```typescript
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
```

- [ ] **Step 4: 验证类型编译**

```bash
cd /Users/pipi/work/HiAgent && bun run --filter @hiagent/kernel typecheck
```
预期: exit code 0

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat(types): 新增 steer 队列 WS 协议事件 + queue_update SDKEvent"
```

---

### Task 2: agent-manager.ts — prompt 改为 followUp + 新增队列方法

**Files:**
- Modify: `packages/kernel/src/agent-manager.ts`

**Interfaces:**
- Consumes: `SteerPromoteEvent`, `SteerImmediateEvent` 等类型（Task 1）
- Produces: `prompt()` 改签名语义，`promoteToSteer(sid,text,remaining)`, `immediate(sid,text,remaining)`, `clearSteeringQueue(sid)`, `clearFollowUpQueue(sid)`

- [ ] **Step 1: 更新 prompt 方法 — agent 运行中默认 followUp**

找到 `async prompt(sessionId: string, text: string)` 方法（约 L167），替换当前实现：

```typescript
  /** 发送用户输入。agent 运行中或有排队消息时 followUp 排队；空闲时直接 prompt。 */
  async prompt(sessionId: string, text: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`会话未启动: ${sessionId}`);
    if (session.agent.state.isStreaming || session.agent.hasQueuedMessages()) {
      await session.prompt(text, { streamingBehavior: "followUp" });
    } else {
      await session.prompt(text);
    }
  }
```

- [ ] **Step 2: 新增 _jumpQueue 私有方法（promoteToSteer 和 immediate 共享实现）**

在 `prompt()` 方法之后插入：

```typescript
  /** 
   * 清空队列 + abort + 剩余重入队 + 发目标消息。
   * promoteToSteer 和 immediate 共享实现。
   */
  private async _jumpQueue(sessionId: string, text: string, remainingTexts: string[]): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`会话未启动: ${sessionId}`);

    // 1. 中断当前运行
    session.agent.abort();
    await session.agent.waitForIdle();

    // 2. 清空全部队列
    session.agent.clearAllQueues();

    // 3. 剩余消息用底层 agent.followUp() 入队（避免触发新 prompt）
    //    直接用 Agent.followUp 而非 AgentSession.prompt，因为 abort 后 agent idle，
    //    session.prompt(rt, {streamingBehavior:"followUp"}) 会启动新回合而非排队
    for (const rt of remainingTexts) {
      session.agent.followUp({ role: "user", content: rt, timestamp: Date.now() });
    }

    // 4. 目标消息作为新回合开始
    await session.prompt(text);
  }
```

- [ ] **Step 3: 新增 promoteToSteer / immediate / clearSteeringQueue / clearFollowUpQueue 公开方法**

在 `_jumpQueue` 之后插入：

```typescript
  /** 提升排队消息为引导（abort → 清空 → 剩余重入队 → 目标消息作为新回合） */
  async promoteToSteer(sessionId: string, text: string, remainingTexts: string[]): Promise<void> {
    await this._jumpQueue(sessionId, text, remainingTexts);
  }

  /** 立即执行排队消息（abort → 清空 → 剩余重入队 → 目标消息作为新回合） */
  async immediate(sessionId: string, text: string, remainingTexts: string[]): Promise<void> {
    await this._jumpQueue(sessionId, text, remainingTexts);
  }

  /** 清空 steer 引导队列（session 不存在时静默忽略） */
  clearSteeringQueue(sessionId: string): void {
    this.sessions.get(sessionId)?.agent.clearSteeringQueue();
  }

  /** 清空 followUp 排队队列（session 不存在时静默忽略） */
  clearFollowUpQueue(sessionId: string): void {
    this.sessions.get(sessionId)?.agent.clearFollowUpQueue();
  }
```

- [ ] **Step 4: 验证类型编译**

```bash
cd /Users/pipi/work/HiAgent && bun run --filter @hiagent/kernel typecheck
```
预期: exit code 0

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/agent-manager.ts
git commit -m "feat(agent-manager): prompt 默认 followUp 排队 + 新增 5 个队列控制方法"
```

---

### Task 3: agent-manager.test.ts — 更新 mock + 新增队列方法测试

**Files:**
- Modify: `packages/kernel/tests/agent-manager.test.ts`

**Interfaces:**
- Consumes: AgentManager 新方法（Task 2）
- 更新现有 fakeAgent mock，新增 `hasQueuedMessages`/`clearSteeringQueue`/`clearFollowUpQueue`/`clearAllQueues`/`waitForIdle`/`state.isStreaming`

- [ ] **Step 1: 更新 fakeAgent mock 对象**

找到 fakeAgent 定义（约 L10），替换为：

```typescript
const fakeAgent: any = {
  steer: mock(() => {}),
  followUp: mock(() => {}),
  clearSteeringQueue: mock(() => {}),
  clearFollowUpQueue: mock(() => {}),
  clearAllQueues: mock(() => {}),
  hasQueuedMessages: mock(() => false),
  abort: mock(() => {}),
  waitForIdle: mock(async () => {}),
  subscribe: mock(() => mock(() => {})),
  state: { isStreaming: false },
};
```

- [ ] **Step 2: 更新 fakeSession 中的 agent 引用**

找到 fakeSession 定义（约 L10），将 `agent: fakeAgent as any` 替换为：

```typescript
const fakeSession: Partial<AgentSession> = {
  prompt: mock(async () => {}),
  abort: mock(async () => {}),
  dispose: mock(() => {}),
  setSessionName: mock(() => {}),
  subscribe: mock(() => fakeUnsubscribe),
  messages: [],
  agent: fakeAgent as any,
};
```

- [ ] **Step 3: 清除 mock 记录时重置 fakeAgent 状态**

找到 beforeEach 块（约 L25），在 `fakeSession` mock 清理之后添加：

```typescript
  fakeAgent.state.isStreaming = false;
  (fakeAgent.hasQueuedMessages as any).mockImplementation(() => false);
```

- [ ] **Step 4: 替换「prompt 使用 steer」的旧测试**

找到测试 `test("prompt 调用 session.prompt，使用 steer 流式行为", ...)`（约 L92），替换为两个测试：

```typescript
test("prompt — agent 空闲且无排队 → 直接 prompt（不带 streamingBehavior）", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  fakeAgent.state.isStreaming = false;
  (fakeAgent.hasQueuedMessages as any).mockReturnValue(false);

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);
  await am.prompt(session.id, "你好");

  expect(fakeSession.prompt).toHaveBeenCalledWith("你好");
});

test("prompt — agent 运行中 → followUp 排队", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  fakeAgent.state.isStreaming = true;
  (fakeAgent.hasQueuedMessages as any).mockReturnValue(true);

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);
  await am.prompt(session.id, "排队消息");

  expect(fakeSession.prompt).toHaveBeenCalledWith("排队消息", { streamingBehavior: "followUp" });
});
```

- [ ] **Step 5: 新增 promoteToSteer 测试**

在 abort 测试之后插入：

```typescript
test("promoteToSteer — abort → clearAllQueues → 剩余重入 followUp → prompt", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);

  await am.promoteToSteer(session.id, "引导消息", ["剩余A", "剩余B"]);

  expect(fakeAgent.abort).toHaveBeenCalledTimes(1);
  expect(fakeAgent.waitForIdle).toHaveBeenCalledTimes(1);
  expect(fakeAgent.clearAllQueues).toHaveBeenCalledTimes(1);
  // 剩余消息用 agent.followUp 入队（非 session.prompt）
  expect(fakeAgent.followUp).toHaveBeenCalledWith({ role: "user", content: "剩余A", timestamp: expect.any(Number) });
  expect(fakeAgent.followUp).toHaveBeenCalledWith({ role: "user", content: "剩余B", timestamp: expect.any(Number) });
  // 目标消息直接 prompt
  expect(fakeSession.prompt).toHaveBeenCalledWith("引导消息");
});
```

- [ ] **Step 6: 新增 clearSteeringQueue / clearFollowUpQueue 测试**

在 promoteToSteer 测试之后插入：

```typescript
test("clearSteeringQueue — 调用 session.agent.clearSteeringQueue()", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);
  am.clearSteeringQueue(session.id);

  expect(fakeAgent.clearSteeringQueue).toHaveBeenCalledTimes(1);
});

test("clearFollowUpQueue — 调用 session.agent.clearFollowUpQueue()", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);
  am.clearFollowUpQueue(session.id);

  expect(fakeAgent.clearFollowUpQueue).toHaveBeenCalledTimes(1);
});

test("clearSteeringQueue / clearFollowUpQueue — session 不存在时静默忽略", async () => {
  const am = new AgentManager({
    projectStore: newProjectStore(), configStore: null as any, onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  // 不抛异常
  am.clearSteeringQueue("nonexistent");
  am.clearFollowUpQueue("nonexistent");
});
```

- [ ] **Step 7: 运行测试**

```bash
cd /Users/pipi/work/HiAgent && bun test packages/kernel/tests/agent-manager.test.ts
```
预期: 全部 PASS

- [ ] **Step 8: Commit**

```bash
git add packages/kernel/tests/agent-manager.test.ts
git commit -m "test(agent-manager): 更新 mock + 新增队列方法测试"
```

---

### Task 4: ws-server.ts — agent:prompt 调整 + 4 个新 steer handler

**Files:**
- Modify: `packages/kernel/src/ws-server.ts`

**Interfaces:**
- Consumes: AgentManager 新方法（Task 2），Steer 事件类型（Task 1）
- 处理 `steer:promote`, `steer:immediate`, `steer:cancel`, `steer:clear-queue`

- [ ] **Step 1: 调整 agent:prompt handler — 确保 session.id 传入 AgentManager.prompt**

当前代码（约 L131-153）已经正确传入 `session.id`，无需改动。但 `agentManager.prompt()` 内部逻辑已在 Task 2 改为默认 followUp。

> 确认：当前 handler 已正确调用 `agentManager.prompt(session.id, event.text)`，无需修改。

- [ ] **Step 2: 新增 4 个 steer handler**

在 `agent:abort` handler（约 L154-158）之后、`agent:config:get` 之前，插入：

```typescript
      case "steer:promote": {
        try {
          await this.opts.agentManager.promoteToSteer(event.sessionId, event.text, event.remainingTexts);
        } catch (err) {
          this.broadcast({ type: "error", message: `引导失败: ${(err as Error).message}` });
        }
        break;
      }
      case "steer:immediate": {
        try {
          await this.opts.agentManager.immediate(event.sessionId, event.text, event.remainingTexts);
        } catch (err) {
          this.broadcast({ type: "error", message: `立即执行失败: ${(err as Error).message}` });
        }
        break;
      }
      case "steer:cancel": {
        this.opts.agentManager.clearSteeringQueue(event.sessionId);
        break;
      }
      case "steer:clear-queue": {
        this.opts.agentManager.clearFollowUpQueue(event.sessionId);
        break;
      }
```

- [ ] **Step 3: 验证类型编译**

```bash
cd /Users/pipi/work/HiAgent && bun run --filter @hiagent/kernel typecheck
```
预期: exit code 0

- [ ] **Step 4: Commit**

```bash
git add packages/kernel/src/ws-server.ts
git commit -m "feat(ws-server): 新增 steer:promote/immediate/cancel/clear-queue handler"
```

---

### Task 5: 全量测试验证

**Files:**
- 无新文件

- [ ] **Step 1: 运行所有 kernel 测试**

```bash
cd /Users/pipi/work/HiAgent && bun test packages/kernel/tests/
```
预期: 全部 PASS，无 FAIL

- [ ] **Step 2: typecheck 全局**

```bash
cd /Users/pipi/work/HiAgent && bun run typecheck
```
预期: exit code 0

- [ ] **Step 3: Commit + push**

```bash
git add -A
git commit -m "test: steer 队列全量测试通过"
git push
```
