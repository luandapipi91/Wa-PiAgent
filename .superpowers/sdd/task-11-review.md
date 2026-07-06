# Task 11 Review: StateAggregator

**Reviewer 视角**：spec 合规 + 代码质量双判定
**Base** `524a5ef` → **Head** `bf0f598`
**Files** `packages/kernel/src/state-aggregator.ts`（56 行）、`packages/kernel/tests/state-aggregator.test.ts`（68 行）

---

## 一、Spec 合规判定：✅ PASS

| 判定点 | 结论 | 证据 |
|---|---|---|
| 四方法签名一致 | ✅ | `routePiEvent(key, e): void` / `routeAsk(ask): void` / `routeReply(askMessageId, sessionId): void` / `snapshot(): Promise<WSServerEvent[]>` 与 brief L10 接口逐字一致；构造 opts 三字段（sessionStore/agentManager/onServerEvent）一致 |
| 4 passed 实跑 | ✅ | 复跑 `bun test state-aggregator.test.ts` → 4 pass / 0 fail，时延与报告吻合（66/0.31/60/125 ms） |
| 全 kernel 32 passed | ✅ | 复跑 `bun test packages/kernel` → 32 pass / 0 fail / 8 文件，无回归 |
| routePiEvent 用 parseAgentStateKey | ✅ | `const { projectId, agentName } = parseAgentStateKey(key)`（L36）；`parseAgentStateKey` 已在 `@hiagent/shared/pure.ts:29` 导出，返回类型对齐 |
| message 分支：异步 appendMessage + 同步 onServerEvent | ✅ | L40-45：先同步推 `agent:message`（含 projectId/sessionId/agentName/message 全字段），再 `sessionStore.appendMessage(...).catch(()=>{})` 不阻塞 |
| state 分支：仅 onServerEvent | ✅ | L48-52：只推 `agent:state`，无持久化（状态驻 AgentManager 内存，符合 brief 说明） |
| routeAsk/routeReply 行为 | ✅ | routeAsk → `intercom:ask` + `appendAsk`；routeReply → `intercom:reply` + `resolveAsk`；事件字段与 `IntercomAskEvent`/`IntercomReplyEvent`（shared/types.ts:150/155）完全对齐 |

**事件 shape 校验**：四种生成事件（agent:message / agent:state / intercom:ask / intercom:reply）字段逐一比对 `shared/types.ts` 中的 interface 定义，无遗漏、无多余字段，TypeScript 联合类型 `WSServerEvent` 可正确收窄。

**结论**：实现与 brief 源码模板逐行一致，无偏移。Spec 合规 ✅。

---

## 二、代码质量判定：✅ PASS（附 1 条非阻断建议）

### 2.1 `await setTimeout(50)` 等异步持久化 — 合理 ✅

- 实测 appendMessage/appendAsk 持久化时延均 <5ms，50ms 余量约 10×，无 flake 风险。
- routeReply 测试串行两段 50ms 等待（先等 appendAsk 落盘再 resolveAsk），设计正确——必须先确保 ask 存在才能 resolve，时序依赖处理得当。
- 改进项（非阻断）：理想做法是 SessionStore 暴露同步可观测的 flush 信号或测试注入 mock store 以消除 magic number；MVP 阶段不阻断。

### 2.2 fire-and-forget `.catch(()=>{})` 静默吞错 — MVP 可接受，建议加日志 ⚠️（非阻断）

- 三处（appendMessage / appendAsk / resolveAsk）均为 `.catch(()=>{})`，持久化失败完全无感。
- 评估：MVP 阶段可接受（避免持久化异常反压事件流，符合"事件流不被阻塞"设计意图）。但生产化前应改为 `.catch(err => log/emit error)`，否则消息丢失无任何可观测性，排障困难。
- **不阻断本次合并**，记为后续 hardening 项。

### 2.3 snapshot() 空实现 — 不阻断 ✅

- `return []`，brief L143-146 明确"Task 12 的 WS server 启动时调用，此处给最小实现"。
- 已核实 Task 12 所需原料就绪：`AgentManager.getAllStates()`（agent-manager.ts:54）返回 `Map<AgentStateKey, AgentState>`；SessionStore 有 loadMessages/loadAsks。Task 12 可直接聚合填充。
- **不阻断**。

### 2.4 routePiEvent 不处理 intercom 类 PiEvent — 合理 ✅

- `PiEvent` 类型（pi-rpc-client.ts:4-8）含 `intercom:ask`/`intercom:reply` 两个 kind，但 switch 仅覆盖 message/state，无 default 分支。
- 设计依据：pi-rpc-client.ts:115 注释明确"intercom ask/reply 由 IntercomMonitor 从 broker 旁路监听"，即 intercom 事件走独立管道 → routeAsk/routeReply，不经 routePiEvent。
- 无 default 分支：未匹配 kind 静默跳过（switch 穷尽性已在 PiEvent 联合类型层面保证类型安全，TS 不会报漏判）。设计自洽，合理。

### 2.5 其他

- **CRLF 警告**：Windows 环境 LF→CRLF，无功能影响，忽略。
- **TDD 流程**：报告记录 FAIL（Cannot find module）→ PASS，符合红绿循环。
- **类型导入**：`import type` 与值导入（parseAgentStateKey）正确分离，符合 TS isolatedModules 规范。

---

## 三、是否需修复

**否，无需修复即可合并。**

- Spec 合规 ✅（签名/路由/解析/分支全部对齐）
- 代码质量 ✅（4 项质量关切均评估为可接受或不阻断）
- 唯一建议（非阻断、可延后）：将 `.catch(()=>{})` 升级为带日志/错误事件的版本，列入后续 hardening backlog。

**Task 11 评审通过，可进入 Task 12。**
