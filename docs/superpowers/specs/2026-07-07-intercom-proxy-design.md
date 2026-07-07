# 多智能体委派：Kernel 代理方案

> 基于 pi-intercom broker 协议的代理机制，实现 agent 按需唤醒和消息转发
>
> 日期：2026-07-07
> 状态：设计中（POC 已通过）

## 一、问题

### 1.1 现状

`AgentManager.ensureStarted(projectId, agentName)` 采用惰性启动：只有用户在前端直接与该 agent 对话时才启动对应 Pi 进程。

`pi-intercom` 的 `ask` 工具依赖 broker 上已注册的目标 session。若 Agent 1 要委派 Agent 2，但 Agent 2 的 Pi 进程未启动 → broker 上无目标 session → `delivery_failed: "Session not found"` → 委派失败。

### 1.2 约束

- **可扩展**：后期 agent 数量可能达到 200+，不能无脑预启动所有 agent
- **不修改 pi-intercom**：pi-intercom 是外部依赖，保持不动
- **对 agent 透明**：agent 的 LLM 不需要感知代理的存在，正常使用 `intercom` 工具即可
- **支持链式委派**：Agent 1 → Agent 2 → Agent 3 的递归委派无缝支持

## 二、方案概述

**Kernel 在 broker 上为每个 agent 注册一个轻量代理 session**。当有消息发给该 agent 时，代理接收消息 → 唤醒真实 Pi 进程 → 重放消息。

```
Agent 1 (Pi 进程)                      Kernel (代理)                     Agent 2 (未启动)
      │                                     │                                  │
      │  intercom ask("pm", "hi")           │                                  │
      │  → resolveSessionTarget("pm")       │                                  │
      │  → broker.listSessions()            │                                  │
      │  ← 找到代理 session "pm" ✓          │                                  │
      │                                     │                                  │
      │  → broker.send("pm", msg)           │                                  │
      │                                     │  ← 代理收到 message 事件          │
      │                                     │  缓存 {messageId, from, text}      │
      │                                     │  代理 disconnect（释放名字）        │
      │                                     │                                  │
      │                                     │  ensureStarted("pm") ──────────→  │ Pi 进程启动
      │                                     │                                  │ 加载 pi-intercom
      │                                     │                                  │ 注册 broker (name="pm")
      │                                     │  ← session_joined("pm") ──────── │
      │                                     │                                  │
      │                                     │  broker.send("pm", 缓存msg) ──→  │
      │                                     │  （保留原始 messageId）             │
      │                                     │                                  │ 处理消息
      │  ← broker message (reply)           │  ← broker.send(reply) ────────── │ 生成回复
      │  waitForReply 匹配 messageId ✓      │                                  │
```

### 2.1 关键设计点

| 要点 | 说明 |
|------|------|
| **代理注册** | 使用 pi-intercom 的 `IntercomClient`，与真实 Pi 进程同样的注册协议 |
| **名字复用** | 代理 disconnect 后 broker 立即释放名字，真实进程可注册同名 |
| **消息缓存** | 代理收到消息后缓存原始 `messageId`、`from`、`text`、`expectsReply` 等字段 |
| **messageId 保留** | 重放时必须使用原始 `messageId`，否则 `waitForReply` 的 replyTo 匹配会失败 |
| **生命周期** | 真实 agent 退出后，代理自动重新注册，恢复待命状态 |

## 三、架构

### 3.1 新增模块：`BrokerProxyManager`

```typescript
// packages/kernel/src/broker-proxy.ts

class BrokerProxyManager {
  // 为每个 agent name 维护一个代理 session
  private proxies: Map<AgentName, IntercomClient>;
  
  // 缓存收到的消息，key 为 agentName
  private pendingMessages: Map<AgentName, CachedMessage[]>;
  
  // 初始化：为 ALL_AGENT_NAMES 注册代理
  async start(): Promise<void>;
  
  // 当真实 agent 进程退出后，重新注册代理
  async reRegisterProxy(agentName: AgentName): Promise<void>;
  
  // 停止所有代理
  async dispose(): Promise<void>;
}
```

### 3.2 与现有模块的关系

```
index.ts
  ├── BrokerProxyManager  (新增) ← 管理代理 session 生命周期
  │     ↓ 消息事件
  ├── AgentManager        (现有) ← ensureStarted / disposeAll
  │     ↓ 状态事件  
  ├── StateAggregator     (现有) ← 路由 intercom:ask / intercom:reply
  │     ↓
  ├── WSServer            (现有) ← broadcast 到前端
  │
  └── IntercomMonitor     (现有，需重构) ← 改名为直接复用 BrokerProxyManager 的连接
```

**IntercomMonitor 的重构**：当前 `IntercomMonitor` 以裸 socket 连接 broker（未按协议注册），实际收不到任何事件。代理方案实施后，`BrokerProxyManager` 持有的 `IntercomClient` 实例已连接 broker 并正确注册，可直接从中监听 `session_joined`/`session_left` 等事件，替代原有 `IntercomMonitor` 的角色。

### 3.3 代理消息处理流程

```
BrokerProxyManager 收到 message 事件 (target = agentName):
  
  1. 缓存消息:
     pendingMessages.get(agentName).push({
       messageId: msg.id,
       fromId: from.id,
       fromName: from.name,
       text: msg.content.text,
       expectsReply: msg.expectsReply,
       replyTo: msg.replyTo,
     })
  
  2. 断开代理:
     proxies.get(agentName).disconnect()
     proxies.delete(agentName)
  
  3. 通知前端 intercom:ask:
     stateAggregator.routeAsk({
       messageId: msg.id,
       sessionId: ...,  // 发起方 session ID
       from: from.name,
       to: agentName,
       text: msg.content.text,
       startedAt: Date.now(),
       resolved: false,
     })
  
  4. 启动真实 agent:
     agentManager.ensureStarted(projectId, agentName)
  
  5. 等待 agent 上线（监听 session_joined）:
     → 检测 broker 上出现 name=agentName 的新 session
     → 用该 fromId 对应的 IntercomClient 重放缓存消息
     → 清空 pendingMessages.get(agentName)
```

### 3.4 代理重新注册

当真实 agent 的 Pi 进程退出后（`turn_end` + 超时或 `dispose`），需重新注册代理：

```
AgentManager.dispose(agentName) 或 Pi 进程退出
  → BrokerProxyManager.reRegisterProxy(agentName)
  → 新建 IntercomClient，connect({name: agentName, status: "proxy"})
  → proxies.set(agentName, newClient)
```

## 四、生命周期状态机

```
                    ┌──────────────┐
                    │   代理待命    │  IntercomClient 注册在 broker
                    │ (name="pm")  │  等待 message 事件
                    └──────┬───────┘
                           │ 收到 message 事件
                           ▼
                    ┌──────────────┐
                    │   断开代理    │  缓存消息
                    │ (释放名字)   │  通知前端
                    └──────┬───────┘
                           │ ensureStarted("pm")
                           ▼
                    ┌──────────────┐
                    │   Pi 启动中   │  等待 session_joined
                    │ (broker 无pm) │
                    └──────┬───────┘
                           │ Pi 注册 broker (name="pm")
                           ▼
                    ┌──────────────┐
                    │   重放消息    │  代理持有的 client.send("pm", cachedMsg)
                    │              │  保留原始 messageId
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────┐
                    │   真实运行    │  Pi 进程正常工作
                    │ (name="pm")  │  可接收新的 ask/reply
                    └──────┬───────┘
                           │ Pi 进程退出 / dispose
                           ▼
                    ┌──────────────┐
                    │   代理待命    │  重新注册代理
                    └──────────────┘
```

## 五、链式委派

Agent 1 → Agent 2 → Agent 3 的递归委派无需额外处理：

1. Agent 1 的 LLM 调用 `intercom({action:"ask", to:"pm", ...})`
2. 代理 "pm" 收到 → 唤醒真实 pm → 重放消息
3. 真实 pm 的 LLM 处理任务，决定调用 `intercom({action:"ask", to:"test", ...})`
4. 代理 "test" 收到 → 唤醒真实 test → 重放消息
5. test 回复 pm → pm 回复 product

整个链路上，每个 agent 的代理都常驻 broker，互不干扰。

## 六、错误处理

| 场景 | 处理 |
|------|------|
| **代理注册失败** | broker 未就绪时，跳过该 agent 的代理注册，记录 warn 日志。broker 上线后由心跳机制补注册。 |
| **收到消息时 broker 断开** | 丢弃消息（发送方 intercom 工具会收到 delivery_failed，LLM 可重试） |
| **Pi 进程启动失败** | 重新注册代理，标记消息为失败，通知发送方 |
| **重放消息失败** | 记录 error 日志，重新注册代理。发送方的 ask 会在 10 分钟超时后失败 |
| **代理断开后 Pi 未及时注册** | 短暂窗口期（< 1s），若此期间另一 agent 也向该目标发消息，broker 返回 delivery_failed。LLM 可重试 |

## 七、测试策略

### 第一层：单元测试 (bun:test)
- `BrokerProxyManager` 的代理注册/断开逻辑（mock IntercomClient）
- 消息缓存和重放逻辑
- 生命周期状态机转换

### 第二层：组件测试 (Vitest)
- 前端 `AskCard` 在代理场景下的状态变化

### 第三层：集成测试 (curl)
- 不适用（代理逻辑不涉及 HTTP API）

### 第四层：E2E (Playwright / agent-browser)
- 完整委派流程：Agent 1 启动 → 发送 intercom ask → Agent 2 被唤醒 → 回复 → Agent 1 收到回复
- 链式委派：Agent 1 → Agent 2 → Agent 3

## 八、projectId 解析

代理收到消息后，需要确定目标 agent 属于哪个项目，才能调用 `ensureStarted(projectId, agentName)`。

**方案**：代理注册时使用复合名称 `"{projectId}-{agentName}"`（与 Pi 进程 `--name` 参数一致）。

```
代理注册: name = "abc123-pm"    (projectId=abc123, agentName=pm)
Pi 进程:   --name abc123-pm     (同 project 下 persist 同会话)
```

收到消息时：
1. 从代理 name `"abc123-pm"` 解析出 `projectId="abc123"`, `agentName="pm"`
2. 调用 `ensureStarted("abc123", "pm")`
3. Pi 进程启动后以同名注册 broker

发送方（Agent 1）的 system prompt 中包含了目标 session 名称映射，LLM 直接使用完整名称 `"abc123-pm"` 调用 `intercom({to: "abc123-pm", ...})`。

## 九、POC 验证记录

POC 脚本（已清理）验证了以下 9 步全流程：

| 步骤 | 操作 | 结果 |
|------|------|------|
| 1 | broker 连接检查 | ✅ |
| 2 | 代理注册 `name="test-target"` | ✅ |
| 3 | Agent1 发现代理 session | ✅ |
| 4 | 代理收到消息 | ✅ |
| 5 | Agent1 发送成功 (`delivered: true`) | ✅ |
| 6 | 代理断开，名字释放 | ✅ |
| 7 | 真实 session 注册同名 | ✅ |
| 8 | 重放消息送达（保留 messageId） | ✅ |
| 9 | Agent1 收到回复（replyTo 匹配） | ✅ |

使用的依赖：pi-intercom 自带的 `IntercomClient`（无需额外安装）。
