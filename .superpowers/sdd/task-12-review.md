# Task 12 Review：WS Server（kernel 总集成点）

**Reviewer**: ZCode task-reviewer
**Commit**: `a81922c` — `feat(kernel): WS Server（端口 9776，全协议路由）+ 入口编排`
**Base → Head**: `bf0f598` → `a81922c`
**判定**: ✅ **Spec 合规 PASS** + ✅ **代码质量 PASS（含 2 处 minor nit）**

---

## 一、Spec 合规判定：✅ PASS

### 1.1 WSServer 类签名一致 ✅

| 成员 | brief | 实现 (ws-server.ts) | 一致 |
|---|---|---|---|
| constructor opts | `{configStore,projectStore,sessionStore,agentManager,intercomMonitor,stateAggregator,port?}` | `WSServerOpts` 同 7 字段 + `port?` | ✅ |
| `actualPort` | start 后可读 | `actualPort = 0`，start 内 `= this.server.port` | ✅ |
| `broadcast(e)` | 遍历 clients | private，遍历 `this.clients` | ✅ |
| `bindAggregatorBroadcast()` | 把 aggregator.onServerEvent 重指 broadcast | `(this.opts.stateAggregator as any).opts.onServerEvent = (e)=>this.broadcast(e)` | ✅ |
| `start()` | Bun.serve + WS upgrade + 返回 void | `async start(): Promise<void>` | ✅ |
| `stop()` | server.stop + disposeAll + dispose | 三步齐全 | ✅ |
| `handle(event, reply)` | 全 case 路由 | switch 10 case | ✅ |

### 1.2 测试实跑：✅ 3 passed + 全 kernel 35 passed

实测复现（非读报告）：
```
bun test packages/kernel/tests/ws-server.test.ts  → 3 pass / 0 fail
bun test packages/kernel                          → 35 pass / 0 fail / 61 expect()
```
报告数据属实。

### 1.3 broadcast clients 集群 ✅

- `private clients = new Set<any>()`
- `open: (ws) => this.clients.add(ws)` — 连接加入
- `close: (ws) => this.clients.delete(ws)` — 断开移除
- `broadcast(e)`：`for (const ws of this.clients) try { ws.send(payload) } catch {}` — 遍历发，单连接失败不中断
- **未用** `server.publish("all")`（无 subscribe 会失败，符合 brief 约束）

### 1.4 handle 的 broadcast vs reply 区分 ✅

| WSClientEvent | 响应 | 验证 |
|---|---|---|
| `projects:list` | **reply**（定向回请求者） | ✅ test 1 |
| `project:create` | **broadcast** `project:created` | ✅ test 2 |
| `project:update/delete`、`session:rename/delete` | **broadcast** `projects:list` 全量重推 | ✅ 逻辑正确（多客户端需同步） |
| `agent:prompt` | **broadcast** `session:created` | ✅ test 3 |
| `agent:config:get`（有 config） | **reply** `agent:config` | ✅ 定向 |
| `agent:config:save`（有错） | **reply** `error` | ✅ 定向 |
| `agent:abort`、`intercom:inject-reply` | 无直接回包（异步经 StateAggregator 回流） | ✅ |

区分逻辑与 brief 完全一致：仅 `projects:list` 与 `agent:config*` 走 reply（请求者私有数据），其余广播（多客户端共享状态）。

### 1.5 agent:prompt 的 session 创建 ✅

- 前端 `sessionId` 仅作请求追踪；kernel 先 `projectStore.load()` 查 `existing`，未命中则 `createSession()`（`project-store.ts:66` 确认 `id: randomUUID()`）→ **session.id 由 kernel 生成**
- **先广播 `session:created`**（test 3 断言此点，实跑通过），再 `touchSession` + `ensureStarted` + `prompt`
- 顺序正确：广播在 spawn 之前，即使 spawn 失败前端也已拿到 session 元数据

### 1.6 index.ts main() wire 链路完整 ✅

四条接线逐一核对（index.ts:19-46）：

```
① AgentManager.onEvent(key,e) ──► stateAggregator.routePiEvent(key,e)   [L29-30]
② IntercomMonitor.onAsk(ask)   ──► stateAggregator.routeAsk(ask)        [L33]
③ IntercomMonitor.onReply(id,sid) ──► stateAggregator.routeReply(...)   [L34]
④ stateAggregator.onServerEvent(e) ──► server.broadcast(e) ──► clients  [L45-46 + bindAggregatorBroadcast]
```

- ① 经 `(agentManager as unknown as {opts:{onEvent}}).opts.onEvent = ...` 重写（opts 为 private，brief 同款 unknown cast）
- ②③ 在 `new IntercomMonitor({...})` 构造时直连 aggregator
- ④ `server.start()` 后 `bindAggregatorBroadcast()` 把 aggregator 输出重指 `server.broadcast`（覆盖 L26 占位闭包，二者等效）
- `await intercomMonitor.connect()` 在 server.start 前（生产连 broker）

链路完整，无断点。

---

## 二、代码质量判定：✅ PASS（2 处 minor nit）

### 2.1 agent:prompt 的 try/catch 加固：**合理修复，非绕过测试** ✅

**根因验证**（不是读报告，是读源码）：
- test mock `spawnFn: (() => ({})) as any` 返回裸 `{}`，无 `stdin/stdout`
- `PiRpcClient.start()`（pi-rpc-client.ts:44-52）：`this.child = spawnFn(...)` 得 `{}`，随即 `this.child.stdout.on("data", ...)` → **`undefined.on` 抛 TypeError**
- 无 try/catch 时：该 TypeError 让 async `message` handler reject → bun:test 默认把 unhandled rejection 判为失败 → test 3 fail

**加固行为**（ws-server.ts:120-125）：
```typescript
try {
  const client = await this.opts.agentManager.ensureStarted(...);
  await client.prompt(event.text);
} catch (err) {
  reply({ type: "error", message: `agent 启动失败: ${(err as Error).message}` });
}
```

**判定：合理修复，理由三条**：
1. **同一处修复同时满足测试与生产**：生产中 spawn 失败（pi 未安装 / cwd 无效）本就不应让 WS message handler 崩溃或产生 unhandled rejection。这是正确的防御式行为，不是仅为让测试绿的 hack。
2. **不改变 brief 事件语义**：`session:created` 仍在 try 块之前广播（L117），test 3 断言的语义点（会话被创建并广播）完整保留。try/catch 只接管后续 spawn/prompt。
3. **错误回流方向合理**：`reply({type:"error"})` 定向回请求者——spawn 失败是单 agent 单请求的私有错误，广播给所有客户端反而泄漏。

> 不是"绕过测试"：若实现者只是想糊弄测试，更省事的是把 mock 改成返回带 stdin/stdout 的 stub，或在 test 里 catch。实现者选择了加固生产代码路径，且事件语义不变。**这是好品味。**

### 2.2 broadcast 的 try/catch（单 client 隔离）✅

```typescript
private broadcast(e: WSServerEvent): void {
  const payload = JSON.stringify(e);
  for (const ws of this.clients) {
    try { ws.send(payload); } catch {}
  }
}
```
- `payload` 在循环外 stringify 一次（避免 N 次序列化）✅
- 单个 `ws.send` 抛错（连接已 CLOSING 等）被吞，不影响其他 client ✅
- `catch {}` 静默——可接受（WS 发送失败通常就是连接已死，close 回调会清理）

### 2.3 clients Set 的 close 删除 ✅

`close: (ws) => this.clients.delete(ws)` — Bun WS close 回调以同一 `ws` 实例触发，Set.delete 精确移除。无泄漏。`stop()` 里 `this.server?.stop()` 会触发所有 client close，clients 自然清空。

### 2.4 index.ts 的 stale closure 风险：**无** ✅

关键点：`broadcast` 是 `let`，闭包 `(e) => broadcast(e)`（L26 stateAggregator.onServerEvent）与 `(e) => server.broadcast(e)`（L45）都**读取的是 `broadcast` 变量本身**，而非捕获某个值。L45 重新赋值后，L26 闭包下次调用即用新值。无 stale。

但实际运行期更干净：`bindAggregatorBroadcast()`（L46，start 内已调一次，这里再调一次幂等）直接把 `stateAggregator.opts.onServerEvent` 重指 `server.broadcast`，**完全绕过 L26 闭包**。所以 L16/L26/L45 的 `let broadcast` 机制在 server.start 后事实上是死代码——它只服务于"start 之前若 aggregator 提前触发"的兜底（实际不会发生，因 Pi 还没起）。报告注释已说明此点。**非缺陷，仅冗余兜底。**

> 轻微过度工程：`bindAggregatorBroadcast()` 被 start() 内部调一次、index.ts 再显式调一次（幂等，无害）。可接受。

### 2.5 Minor nits（不阻塞，建议后续清理）

1. **ws-server.ts 死导入**：`AgentName`（type）与 `makeAgentStateKey`（value）从 `@hiagent/shared` 导入后**全文未用**（grep 仅命中 import 行）。tsc 因无 `noUnusedLocals` 不报错，但应删。  
2. **index.ts 的 `as unknown as` cast**（L29、L45）与 ws-server.ts 的 `(this.opts.stateAggregator as any).opts`：因 opts 为 private 而绕过 TS。这是 brief 原文风格（用 cast 改 private opts），属设计选择而非 bug，但反映了 AgentManager/StateAggregator 未暴露 setter 的接口缺口。建议后续加 `setOnEvent`/`setOnServerEvent` 方法替代 cast（可选，非本 Task 范围）。

---

## 三、集成债（真实 spawn 路径推迟 Task 33）

本 Task 验证层为 **第一/三层合并**：真实 WS server（Bun.serve 真起端口、真 WS 握手、真 JSON 收发）+ **mock Pi**（`spawnFn: ()=>({})`）。以下路径**未在本 Task 覆盖**，明确推迟到 Task 33 `[需 pi 环境]`：

| 未覆盖路径 | 说明 | Task 33 归属 |
|---|---|---|
| `defaultSpawn → Bun.spawn(["pi",...])` 真实进程 | 无 pi 二进制环境，mock 返回 `{}` | 第三层 `[需 pi 环境]` |
| `PiRpcClient` 真实 stdout 行解析（message_update/state_change） | 无真实 stdout | Task 33 |
| `agent:message` / `agent:state` 经 StateAggregator → broadcast 的端到端 | 依赖 Pi 真发事件 | Task 33 |
| `IntercomMonitor.connectReal`（`import("pi-intercom/broker/paths")`） | broker 未起；且该动态 import 在 typecheck 留预存错误（intercom-monitor.ts:96，Task 9 遗留，非本 Task 引入） | Task 33 |
| 多客户端广播（当前 test 单连接） | broadcast 多 client 隔离逻辑无测试覆盖 | 可选，Task 33 补 |

> **债评估：可控且显式**。brief 明确将真实 Pi 集成划入 Task 33，本 Task 的 mock 边界与 brief Step 验证注释（"第三层 `[需 pi 环境]`：Task 33 集成"）一致。test 3 的 try/catch 加固恰好为 Task 33 的真实 spawn 失败处理铺好了路（spawn 失败 → error 事件，而非崩 server）。

---

## 四、结论

| 维度 | 结论 |
|---|---|
| **Spec 合规** | ✅ PASS — 签名/测试/broadcast集群/reply区分/session创建/wire链路 全符 brief |
| **代码质量** | ✅ PASS — try/catch 加固合理、broadcast 隔离正确、无 stale closure；2 处 minor nit（死导入、冗余 cast）不阻塞 |
| **try/catch 加固合理性** | ✅ **合理修复**（非绕过测试）— 同一处同时满足 mock 测试与生产 spawn 失败处理，事件语义不变 |
| **是否需修复** | ❌ 否。2 处 nit（删 `AgentName`/`makeAgentStateKey` 死导入；可选加 setter 替代 cast）可顺手清，非阻塞 |
| **集成债** | 真实 spawn/Pi 事件/intercom broker 路径推迟 Task 33，边界与 brief 一致，显式可控 |

**可放行 Task 33。**
