# Task 10 Review：AgentManager（双 key spawn/kill）

**Reviewer**: task reviewer · **Commit**: `524a5ef` (base `a55719c`)

## 结论

| 维度 | 结论 |
|---|---|
| Spec 合规 | ✅ PASS |
| 代码质量 | ✅ PASS |
| mock 偏离合理性 | ✅ 合理修复（非绕过断言） |
| 是否需修复 | ❌ 不需（无阻塞项） |

---

## 1. Spec 合规 ✅

### 五方法签名一致
| 方法 | brief 签名 | 实现（agent-manager.ts） | 一致 |
|---|---|---|---|
| `ensureStarted(projectId, agentName)` | `Promise<PiRpcClient>` | ✓ | ✅ |
| `abort(projectId, agentName)` | `Promise<void>` | ✓ | ✅ |
| `getState(key)` | `AgentState \| undefined` | ✓ | ✅ |
| `getAllStates()` | `Map<AgentStateKey, AgentState>` | ✓ | ✅ |
| `disposeAll()` | `Promise<void>` | ✓ | ✅ |

构造参数 `{ projectStore, onEvent, spawnFn? }` 与 brief 完全一致。

### 测试实跑（独立复核）
```
bun test packages/kernel/tests/agent-manager.test.ts
  (pass) ensureStarted 用 projectId+agentName 双 key
  (pass) 不同 projectId 是独立进程
  (pass) onEvent 携带正确 key
 3 pass, 0 fail

bun test packages/kernel   →  28 pass, 0 fail
```
3 passed 与 kernel 全量 28 passed 均经独立复跑确认，无回归。

### 双 key 复用逻辑
- key 通过 `makeAgentStateKey(projectId, agentName)` → `${projectId}:${agentName}`（shared/pure.ts 已确认格式）。
- 同 key：`ensureStarted` 第一行 `agents.get(key)` 短路返回同实例 → test 1 `expect(c1).toBe(c2)` 验证。✅
- 不同 projectId：生成不同 key → 不同 client → test 2 `expect(c1).not.toBe(c2)` 验证。✅

### cwd 取自 project.cwd
`ensureStarted` 内 `const project = projects.find(...)` → `cwd: project.cwd`，未硬编码。✅
sessionId = `${projectId}-${agentName}`（pi-intercom 会话名），与 brief 一致。

---

## 2. 代码质量 ✅

### ensureStarted
- 同 key 短路复用，避免重复 spawn。✅
- 项目不存在抛 `Error("项目不存在: ${projectId}")` — 合理，调用方应保证 projectId 有效，失败应显式报错而非静默。✅
- `await client.start()` 成功后才 `agents.set` — 失败不入 Map，状态干净。✅

### onEvent 包装 + state Map
```ts
onEvent: (e) => {
  if (e.kind === "state") this.states.set(key, e.state);
  this.opts.onEvent(key, e);
}
```
- 闭包捕获外层 `key`，为该 client 的事件打上双 key 标签 — 正确。✅
- 只拦截 `state` 存 Map，其余事件透传（message / intercom:ask / intercom:reply）— 不丢事件。✅
- `getState` 直读 Map，`getAllStates` 返回 `new Map(this.states)` 拷贝 — 防外部篡改。✅

### disposeAll
- `for (const client of agents.values()) await client.dispose()` 逐个 dispose 后清空两 Map。✅
- 串行 await（MVP ≤4 agent 无影响，报告 concern 2 已记，规模化改 `Promise.all`）。

### abort
- 转发 `client.abort()`（发 RPC abort，不销毁进程）。语义为「中止当前推理，进程可继续对话」，符合直觉。报告 concern 1 已明确这是设计选择，非遗漏。

---

## 3. mockSpawn 偏离 brief 的合理性 ✅（确认合理）

### 偏离内容
| | brief mock | 实现 mock |
|---|---|---|
| `stdin.write` | `() => {}`（空操作） | 解析 JSON，`get_state` 时 `stdout.emit(state_change)` |

### 为什么必须改（brief 原 mock 有内在矛盾）
复核 `pi-rpc-client.ts`（pi-rpc-client.ts:42-64）：
- `PiRpcClient.start()` 握手发 `get_state`，并注册 `stdout.on("data", ...)` → `handleLine` → `onEvent`。
- **`onEvent` 只在收到 stdout `data` 时触发**。

brief 原 mock 的 stdout 是裸 EventEmitter，从不 emit → `onEvent` 永不调用 → test 3 `expect(seen).toContain(\`${p.id}:dev\`)` 必然 FAIL。

即：**brief 原 mock 与其自身 test 3 的断言不可同时成立**。不改 mock，test 3 写出来就是死的。

### 改后 mock 是否真实模拟 Pi 行为（关键判定）
实现 mock 的握手回路：
1. client `start()` → `send({type:"get_state"})` → `stdin.write('{"type":"get_state","id":1}\n')`
2. mock `write` 解析出 `obj.type === "get_state"`（注意：`id` 由 send 添加，但匹配只看 `type`，兼容）→ `stdout.emit("data", '{"type":"state_change","state":{"status":"idle"}}\n')`
3. client `handleLine` 把 `state_change` 映射成 `{kind:"state", state:{status:"idle"}}` → 调 `onEvent`
4. AgentManager 包装器：存 states Map + `opts.onEvent(key, e)` → `seen.push(key)` ✅

这条链路**完整复现了真实 pi 的 get_state→state_change 握手语义**，与 `pi-rpc-client.test.ts` 里 `emitLine({type:"state_change",...})` 推 state 的做法同源（只是触发点从手动 `emitLine` 移到 `write` 内自动触发，以适配 AgentManager 不暴露子进程的场景）。

**判定：合理修复，性质等同于 Task 6 的 EMPTY 默认值修正、Task 9 的 dispose 补全——都是修复 brief 自身测试数据不足以驱动真实代码路径的问题，而非为通过断言而硬编码绕过。三个测试的断言语义（同 key 复用 / 不同 key 独立 / onEvent 带 key）均原样保留，未被弱化。**

### 附带质量
- mock 对非 `get_state` 的 write 静默返回（try/catch 兜底）— 不污染其他请求。✅
- 仅 test 3 依赖事件回路；test 1/test 2 靠实例引用判定，不强依赖 mock 行为，mock 改动不影响其结论。✅

---

## 4. 是否需修复

**否。** 无阻塞项。

报告自列的 5 个 concern（abort 语义 / 串行 dispose / state 残留 / getAllStates 未单测 / CRLF）均为非阻塞的后续关注点，已在 report 中如实记录，不影响 Task 10 交付判定。其中：
- concern 3（单 agent 崩溃后 state 残留）建议后续进程退出监听 Task 处理。
- concern 4（getAllStates 无测试）符合「按 brief 交付 3 测试」的要求，方法实现本身正确（返回 Map 拷贝）。

---

## 最终判定

**PASS** — Spec 合规 + 代码质量合格 + mock 偏离为合理修复，可合并进入下一 Task。
