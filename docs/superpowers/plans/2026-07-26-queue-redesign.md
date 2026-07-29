# 排队系统重构 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 删除 WaPi 自管的双队列（steering[] / followUp[]），引导走 pi RPC 原生 steer()，排队走轻量本地列表，消除消息重复/竞态/卡顿。

**架构：**
- "引导" → pi RPC `steer()`，turn_end 自动投递
- "排队" → WaPi 本地 `followUpList: string[]`，agent_settled 逐条 `prompt()`
- 前端乐观更新：点击按钮即时移动 UI，后台发 API

**技术栈：** TypeScript, Bun, React/Zustand, pi RPC (JSONL)

---

### 任务 1：agent-manager.ts 核心重构

**文件：**
- 修改：`packages/kernel/src/agent-manager.ts`

- [ ] **步骤 1：删除 SessionHandle 中的双队列字段**

```typescript
// 删除这两行：
steering: string[];
followUp: string[];

// 替换为：
/** 排队消息列表（agent_settled 时逐条 drain） */
followUpList: string[];
```

- [ ] **步骤 2：删除 _emitQueueUpdate 方法，改用 pi 原生 queue_update 事件透传**

```typescript
// 删除整个 _emitQueueUpdate 方法（line 642-648）
// pi RPC 本身会广播 queue_update 事件，kernel 只需在 _onSessionEvent 中透传
```

- [ ] **步骤 3：删除 _jumpQueue、_lockedQueueOp、_lockedJumpQueue 方法**

删除 line 708-755 的所有方法。这些是卡顿和竞态的根源。

- [ ] **步骤 4：重写 prompt() 的队列判断逻辑**

```typescript
async prompt(sessionId: string, text: string, opts?: {...}): Promise<void> {
    const handle = this.sessions.get(sessionId);
    if (!handle) throw new Error(`会话未启动: ${sessionId}`);
    
    // ... model/thinking/attachment 处理保持不变 ...
    
    if (handle.busy) {
      // agent 运行中 → 追加到本地排队列表
      handle.followUpList.push(finalText);
      return;
    }
    // 空闲 → 直接发送
    await this._sendPromptNow(sessionId, handle, finalText);
}
```

- [ ] **步骤 5：重写 _onSessionEvent 中的 turn_end 和 agent_settled 处理**

```typescript
case "agent_settled":
    handle.busy = false;
    // followUp 本地列表 drain：agent 空闲后逐条发送
    if (handle.followUpList.length > 0) {
      const text = handle.followUpList.shift()!;
      void this._sendPromptNow(sessionId, handle, text).catch((err) => {
        console.error(`[kernel] session ${sessionId} followUp drain 失败:`, err);
      });
    }
    break;
```

删除 `case "turn_end"` 中的 steering 投递逻辑（line 596-603）。

- [ ] **步骤 6：删除 promoteToSteer、immediate、clearSteeringQueue、clearFollowUpQueue、steerMessage**

删除 line 758-810 的所有方法。

- [ ] **步骤 7：新增 steerMessage 简化版 — 直接调 pi steer()**

```typescript
/** 发送引导消息（pi 原生 steer，turn_end 后自动投递） */
async steerMessage(sessionId: string, text: string): Promise<void> {
    const handle = this.sessions.get(sessionId);
    if (!handle) return;
    
    if (!handle.busy) {
      // 空闲时 steer() 会报错，降级为 prompt()
      await this._sendPromptNow(sessionId, handle, text);
      return;
    }
    await handle.client.steer(text);
}
```

- [ ] **步骤 8：重写 abort — 保留清空本地列表逻辑**

```typescript
async abort(sessionId: string): Promise<void> {
    const handle = this.sessions.get(sessionId);
    if (!handle) return;
    
    askRegistry.cancelAll(sessionId);
    handle.followUpList = []; // 清空本地排队列表
    await handle.client.abort().catch((err) => {
      console.error(`[agent-manager] abort 失败 session=${sessionId}:`, err);
    });
    handle.busy = false;
}
```

- [ ] **步骤 9：更新 _createSession 中的 handle 初始化**

```typescript
const handle: SessionHandle = {
    // ... 其他字段不变 ...
    followUpList: [],  // 替换原来的 steering: [], followUp: []
};
```

- [ ] **步骤 10：更新 _reloadIfDirty 中的队列检查**

```typescript
// 原来：if (handle.busy || handle.followUp.length > 0)
// 改为：
if (handle.busy || handle.followUpList.length > 0) return handle;
```

- [ ] **步骤 11：Commit**

```bash
git add packages/kernel/src/agent-manager.ts
git commit -m "refactor(kernel): 简化队列管理，引导走 pi steer，排队走本地列表"
```

---

### 任务 2：ws-server.ts 和 routes/chat.ts 删除 steer 路由

**文件：**
- 修改：`packages/kernel/src/ws-server.ts`
- 修改：`packages/kernel/src/routes/chat.ts`

- [ ] **步骤 1：ws-server.ts 删除 steer 相关 case**

删除以下 case（line 561-585）：
```typescript
case "steer:promote": { ... }
case "steer:immediate": { ... }
case "steer:cancel": { ... }
case "steer:clear-queue": { ... }
```

- [ ] **步骤 2：routes/chat.ts 删除 steer API 路由**

删除以下路由（line 42-59）：
```typescript
r.add("POST", "/api/sessions/:sessionId/steer/promote", ...)
r.add("POST", "/api/sessions/:sessionId/steer/immediate", ...)
r.add("POST", "/api/sessions/:sessionId/steer/cancel", ...)
r.add("POST", "/api/sessions/:sessionId/steer/clear-queue", ...)
```

- [ ] **步骤 3：Commit**

```bash
git add packages/kernel/src/ws-server.ts packages/kernel/src/routes/chat.ts
git commit -m "refactor(kernel): 删除 steer 相关路由和事件处理"
```

---

### 任务 3：前端 SessionView.tsx 乐观更新

**文件：**
- 修改：`packages/frontend/src/components/SessionView.tsx`

- [ ] **步骤 1：重写 handlePromote — 乐观更新 + 调 steerMessage API**

```typescript
const handlePromote = (text: string) => {
  // 乐观更新：从排队列表移除，追加到引导区
  const idx = followUp.indexOf(text);
  const remaining = idx >= 0 ? [...followUp.slice(0, idx), ...followUp.slice(idx + 1)] : [...followUp];
  useSessionStore.setState(s => ({
    queueBySession: { 
      ...s.queueBySession, 
      [sessionId]: { 
        steering: [...(s.queueBySession[sessionId]?.steering ?? []), text], 
        followUp: remaining 
      } 
    },
  }));
  // 后台发送引导命令
  void api.post(`/api/sessions/${encodeURIComponent(sessionId)}/steer`, { text });
};
```

- [ ] **步骤 2：重写 handleImmediate — 乐观更新 + abort + steer**

```typescript
const handleImmediate = (text: string) => {
  // 乐观更新：从排队列表移除
  const idx = followUp.indexOf(text);
  const remaining = idx >= 0 ? [...followUp.slice(0, idx), ...followUp.slice(idx + 1)] : [...followUp];
  useSessionStore.setState(s => ({
    queueBySession: { 
      ...s.queueBySession, 
      [sessionId]: { steering: [...(s.queueBySession[sessionId]?.steering ?? []), text], followUp: remaining } 
    },
  }));
  // 后台发送立即执行命令
  void api.post(`/api/sessions/${encodeURIComponent(sessionId)}/steer/immediate`, { text });
};
```

- [ ] **步骤 3：简化 handleClearFollowUp — 纯本地操作**

```typescript
const handleClearFollowUp = () => {
  useSessionStore.setState(s => ({
    queueBySession: { 
      ...s.queueBySession, 
      [sessionId]: { 
        steering: s.queueBySession[sessionId]?.steering ?? [], 
        followUp: [] 
      } 
    },
  }));
};
```

- [ ] **步骤 4：删除 handleCancelSteer**

steer 消息由 pi 管理，前端不再需要取消引导。删除 `handleCancelSteer` 函数和对应的"取消"按钮。

- [ ] **步骤 5：更新"引导中"区域渲染 — 引导区内容来自 pi 的 queue_update 事件**

引导区（steering）现在完全由 pi 的 `queue_update` 事件驱动，前端只读渲染。

- [ ] **步骤 6：Commit**

```bash
git add packages/frontend/src/components/SessionView.tsx
git commit -m "refactor(frontend): 排队面板乐观更新，消除卡顿"
```

---

### 任务 4：前端 session.ts 简化队列管理

**文件：**
- 修改：`packages/frontend/src/store/session.ts`

- [ ] **步骤 1：删除 appendLocalFollowUp 方法**

```typescript
// 删除整个 appendLocalFollowUp 方法
// 排队消息现在由 kernel followUpList 管理，前端被动接收 queue_update 事件
```

- [ ] **步骤 2：queue_update 事件处理保持不变**

pi RPC 原生 `queue_update` 事件已包含 steering 和 followUp 数组，前端直接渲染即可。无需修改 handleSDKEvent 中的 queue_update 分支。

- [ ] **步骤 3：Commit**

```bash
git add packages/frontend/src/store/session.ts
git commit -m "refactor(frontend): 简化 session store 队列管理"
```

---

### 任务 5：新增路由 /api/sessions/:sessionId/steer 和 /steer/immediate

**文件：**
- 修改：`packages/kernel/src/routes/chat.ts`

- [ ] **步骤 1：新增 POST /steer 路由（引导）**

```typescript
r.add("POST", "/api/sessions/:sessionId/steer", async (req, p) => {
  const { text } = req.body as { text: string };
  if (!text) return { status: 400, body: { error: "text required" } };
  await agentManager.steerMessage(p.sessionId, text);
  return { status: 200, body: { ok: true } };
});
```

- [ ] **步骤 2：新增 POST /steer/immediate 路由（立即）**

```typescript
r.add("POST", "/api/sessions/:sessionId/steer/immediate", async (req, p) => {
  const { text } = req.body as { text: string };
  if (!text) return { status: 400, body: { error: "text required" } };
  // abort 当前运行 + steer 目标消息
  await agentManager.abort(p.sessionId);
  await agentManager.steerMessage(p.sessionId, text);
  return { status: 200, body: { ok: true } };
});
```

- [ ] **步骤 3：Commit**

```bash
git add packages/kernel/src/routes/chat.ts
git commit -m "feat(kernel): 新增简化版 steer 和 steer/immediate 路由"
```

---

### 任务 6：集成测试

**文件：**
- 创建/修改：`packages/kernel/tests/agent-manager.test.ts`

- [ ] **步骤 1：测试发送消息（运行中）→ 进排队列表**

```typescript
test("prompt while busy appends to followUpList", async () => {
  const handle = await agentManager.ensureStarted(projectId, agentName, sessionId);
  handle.busy = true;
  await agentManager.prompt(sessionId, "排队消息");
  expect(handle.followUpList).toEqual(["排队消息"]);
});
```

- [ ] **步骤 2：测试 agent_settled → 自动 drain 排队列表**

```typescript
test("agent_settled drains followUpList", async () => {
  const handle = await agentManager.ensureStarted(projectId, agentName, sessionId);
  handle.followUpList = ["消息1", "消息2"];
  
  // 模拟 agent_settled
  mockClient.emit({ type: "agent_settled" });
  
  // 第一条消息应该被发送
  expect(mockClient.prompt).toHaveBeenCalledWith("消息1");
  expect(handle.followUpList).toEqual(["消息2"]);
});
```

- [ ] **步骤 3：测试 steerMessage（空闲时降级为 prompt）**

```typescript
test("steerMessage falls back to prompt when idle", async () => {
  const handle = await agentManager.ensureStarted(projectId, agentName, sessionId);
  handle.busy = false;
  
  await agentManager.steerMessage(sessionId, "引导消息");
  
  expect(mockClient.prompt).toHaveBeenCalledWith("引导消息");
  expect(mockClient.steer).not.toHaveBeenCalled();
});
```

- [ ] **步骤 4：Commit**

```bash
git add packages/kernel/tests/agent-manager.test.ts
git commit -m "test(kernel): 排队/引导/abort 集成测试"
```

---

### 任务 7：前端组件测试

**文件：**
- 修改：`packages/frontend/tests/SessionView.test.tsx`

- [ ] **步骤 1：测试"引导"按钮乐观更新**

```typescript
test('clicking "引导" optimistically moves message from followUp to steering', async () => {
  render(<SessionView sessionId="test-session" />);
  // 预设队列状态
  useSessionStore.setState({
    queueBySession: { "test-session": { steering: [], followUp: ["排队消息"] } },
  });
  
  const promoteBtn = screen.getByTestId("btn-promote");
  await userEvent.click(promoteBtn);
  
  // 乐观更新：消息应该立即出现在引导区
  expect(screen.getByText("引导中")).toBeInTheDocument();
  expect(screen.queryByText("排队 1 条")).not.toBeInTheDocument();
});
```

- [ ] **步骤 2：测试"清空排队"按钮**

```typescript
test('clicking "清空" clears followUp list immediately', async () => {
  render(<SessionView sessionId="test-session" />);
  useSessionStore.setState({
    queueBySession: { "test-session": { steering: [], followUp: ["msg1", "msg2"] } },
  });
  
  const clearBtn = screen.getByTestId("btn-clear-queue");
  await userEvent.click(clearBtn);
  
  // followUp 列表应该立即为空
  const state = useSessionStore.getState();
  expect(state.queueBySession["test-session"]?.followUp).toEqual([]);
});
```

- [ ] **步骤 3：Commit**

```bash
git add packages/frontend/tests/SessionView.test.tsx
git commit -m "test(frontend): 排队面板乐观更新组件测试"
```

---
