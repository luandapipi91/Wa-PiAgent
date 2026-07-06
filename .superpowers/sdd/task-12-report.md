# Task 12 报告：WS Server（端口 9776，全协议路由）+ 入口编排

- **Commit**: `a81922c` — `feat(kernel): WS Server（端口 9776，全协议路由）+ 入口编排`
- **状态**: ✅ 完成（Phase 2 kernel Pi 集成收尾，总集成点）
- **测试**: `ws-server.test.ts` **3 passed**；全 kernel 回归 **35 passed, 0 fail**

## 交付物

| 文件 | 动作 |
|---|---|
| `packages/kernel/src/ws-server.ts` | 新建（WSServer 类） |
| `packages/kernel/src/index.ts` | 重写（main 编排） |
| `packages/kernel/tests/ws-server.test.ts` | 新建（真实 WS server + mock Pi） |

## broadcast clients 集群（按 brief 实现 ✅）

`private clients = new Set<any>()` 跟踪连接的 WS 客户端：

- **open**: `open: (ws) => { this.clients.add(ws); }` — 新连接加入集群
- **close**: `close: (ws) => { this.clients.delete(ws); }` — 断开移除
- **broadcast(e)**: 遍历 `this.clients`，逐个 `ws.send(JSON.stringify(e))`，单条 `try/catch` 防止坏连接中断广播
- **未用** `server.publish("all")`（无 subscribe 会失败，按 brief 约束避开）

`bindAggregatorBroadcast()` 把 `stateAggregator.opts.onServerEvent` 重指向 `(e) => this.broadcast(e)`，在 `start()` 末尾自动调用一次（test 用默认 no-op onServerEvent 也能跑）。

## handle 的 broadcast vs reply 区分（正确 ✅）

| WSClientEvent | 响应方式 | 理由 |
|---|---|---|
| `projects:list` | **reply**（定向回请求者） | 仅请求者关心快照 |
| `agent:config:get` | **reply** | 仅请求者关心配置 |
| `agent:config:save`（出错时） | **reply** error | 仅请求者关心校验错误 |
| `project:create` | **broadcast** `project:created` | 多客户端需同步 |
| `project:update` / `project:delete` | **broadcast** `projects:list` | 全量重推 |
| `session:rename` / `session:delete` | **broadcast** `projects:list` | 全量重推 |
| `agent:prompt` | **broadcast** `session:created` | 所有客户端需知道新会话 |
| `agent:abort` / `intercom:inject-reply` | 无直接回包（异步经 StateAggregator 回流） | — |

`message` 回调内同时定义 `reply = (e) => ws.send(...)`（定向）与类方法 `broadcast`（广播），传入 `handle(event, reply)`。

## agent:prompt 的 session 创建（按 brief ✅）

- 前端传的 `sessionId` 仅作请求追踪
- kernel 先 `projectStore.load()` 查 `existing`；不存在则 `projectStore.createSession()`（`randomUUID` 生成真实 `session.id`）
- **先广播 `session:created`**（test 3 验证此点），再 `touchSession` + `ensureStarted` + `prompt`
- ⚠️ **对 brief 源码的一处加固**：把 `ensureStarted` + `prompt` 包进 `try/catch`，失败转 `reply({type:"error"})` 而非让 WS message handler reject。原因：test 3 的 mock `spawnFn: (()=>({}))` 返回无 `stdout` 的 stub，原始 brief 代码会让 `PiRpcClient.start()` 抛 `TypeError`、异步 handler reject、test fail。这同时也是正确生产行为——spawn 失败不应崩 server。详见 Concerns。

## index.ts 的 wire 链路（全部接好 ✅）

```
AgentManager.onEvent(key,e) ──► stateAggregator.routePiEvent(key,e)
IntercomMonitor.onAsk(ask) ──► stateAggregator.routeAsk(ask)
IntercomMonitor.onReply(id,sid) ──► stateAggregator.routeReply(id,sid)
stateAggregator.onServerEvent(e) ──► broadcast(e) ──► 全部 WS clients
```

具体编排：
1. `configStore / projectStore / sessionStore` 用默认路径实例化
2. 占位 `let broadcast = () => {}`（server.start 前的安全兜底）
3. `agentManager` 先用 no-op `onEvent` 建，再 `(agentManager as unknown as {opts:{onEvent}}).opts.onEvent = (key,e) => stateAggregator.routePiEvent(...)` 重写（opts 是 private，经 `unknown` 转）
4. `stateAggregator` 的 `onServerEvent` 先指 `broadcast` 闭包
5. `intercomMonitor` 的 `onAsk/onReply` 直连 aggregator，`await intercomMonitor.connect()`
6. `server.start()` → `bindAggregatorBroadcast()` 把 aggregator 输出重指 server.broadcast（覆盖闭包，两者等效）
7. 日志 `[kernel] WS 监听 ws://127.0.0.1:${actualPort}`

## TDD 过程

- Step 1-2: 写 test → `Cannot find module '../src/ws-server'` FAIL ✅
- Step 3-4: 实现 ws-server.ts → 加固 try/catch 后 **3 passed** ✅
- Step 5: index.ts → typecheck clean（除预存 intercom-monitor.ts:96）
- 回归: 全 kernel **35 passed / 0 fail**

## Typecheck

```
tsc --noEmit
# 仅剩预存错误（非本 Task 引入）：
# src/intercom-monitor.ts(96,32): Cannot find module 'pi-intercom/broker/paths'
```

- `intercom-monitor.ts:96` 为 Task 9（commit a55719c）预存的动态 import 回退路径，运行期才解析，非本 Task 回归。
- 本 Task 修掉 brief 源码自带的 2 个 strict cast 错误：`msg as ArrayBuffer` → `as unknown as ArrayBuffer`（ws-server.ts）；`agentManager as {opts}` → `as unknown as {opts}`（index.ts，因 opts 为 private）。

## Concerns

1. **agent:prompt 加固（偏离 brief 原文）**：brief 原始 `ensureStarted`+`prompt` 不包 try/catch，会在 mock spawn 失败时让 test 3 reject。已加 try/catch → reply error。这是防御式增强（生产中 spawn 失败也不应崩 server），不改变 brief 的事件语义（session:created 仍在启动前广播）。如果 Task 33 真实 Pi 集成需要不同的错误回流方式，可届时调整。

2. **测试 mock spawn 是裸 `{}`**：test 的 `spawnFn: (()=>({})) as any` 返回无 stdin/stdout 的对象。当前靠 try/catch 让 test 3 只验证 session:created（符合 brief 意图）。真实 spawn 路径（defaultSpawn → Bun.spawn）未在本 Task 测试，留 Task 33 `[需 pi 环境]` 第三层验证。

3. **intercom-monitor.ts:96 typecheck 预存**：`import("pi-intercom/broker/paths")` 无类型声明，运行期回退。建议后续给 `pi-intercom` 加 `// @ts-ignore` 或 d.ts，但不在本 Task 范围。
