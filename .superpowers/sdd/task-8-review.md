# Task 8 Review: PiRpcClient（spawn + JSONL）

**Reviewer verdict: ✅ PASS（无本 Task 阻断项）**

## 双判定总结

| 维度 | 结论 | 说明 |
|---|---|---|
| **Spec 合规** | ✅ 全部满足 | 四方法/联合类型/spawnFn 注入/4 passed/21 passed 全核实 |
| **代码质量** | ✅ mock 层无阻断 | 5 concerns 均为集成层（Task 33）推迟项，本 Task 无需修复 |

**是否需修复**：
- mock 层阻断：**无**
- 集成层推迟：**5 项 Important（→ Task 33）**，详见下文

---

## Spec 合规判定

| Spec 项 | 实际 | 结果 |
|---|---|---|
| `PiRpcClient` 四方法（start/prompt/abort/dispose） | `pi-rpc-client.ts:101-187` 四方法齐备 | ✅ |
| `spawnFn` 可注入 + 默认 `Bun.spawn` | `opts.spawnFn ?? defaultSpawn`（L112），`defaultSpawn` 用 `Bun.spawn`（L192） | ✅ |
| `PiEvent` 联合类型（message/state/intercom:ask/intercom:reply） | L73-77 四 kind 完整 | ✅ |
| `PiRpcHandlers`（onMessage/onState/onIntercomAsk/onIntercomReply） | brief 已演化为单一 `onEvent(e: PiEvent)`（更优，见质量栏），实现与 brief 一致 | ✅ |
| `mockSpawn` 用 `getStdoutBuf()`/`resetStdoutBuf()`（非属性赋值） | test L38-40 用方法，PiRpcClient 不接触此接口 | ✅ |
| 4 passed 实跑 | reviewer 重跑确认：`4 pass, 0 fail, 5 expect() calls` | ✅ |
| 全 kernel 21 passed | reviewer 重跑确认：`21 pass, 0 fail, 37 expect() calls across 5 files` | ✅ |

**spec 合规：✅ 通过**

---

## 代码质量判定

### ✅ 正确项（逐一核实）

**1. JSONL 分帧正确**（`pi-rpc-client.ts:121-129`）
```typescript
this.stdoutBuf += chunk.toString();
let nl: number;
while ((nl = this.stdoutBuf.indexOf("\n")) >= 0) {
  const line = this.stdoutBuf.slice(0, nl);
  this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
  if (line.trim()) this.handleLine(line);
}
```
- 按 `\n` 切、缓冲跨 chunk 残片、`trim()` 过滤空行 ✅
- while 循环处理同 chunk 内多行 ✅

**2. `handleLine` 字段映射正确**（`pi-rpc-client.ts:156-187`，已与 `shared/types.ts` 交叉核对）
- `message_update` → `ChatMessage`：id/sessionId/role/text/timestamp 五字段齐全，role 白名单（user/assistant）✅
- `state_change` → `AgentState`：name/status/tokenCount?/model? 字段齐全，status 白名单（thinking/blocked/idle）与 `AgentStatus` 类型一致 ✅

**3. `defaultSpawn` 用 `Bun.spawn` + stdin/stdout/stderr pipe**（L191-207）
- `stdin: "pipe"`, `stdout: "pipe"`, `stderr: "pipe"` 三 pipe ✅
- 包装 `stdin.write/end`、透传 stdout/stderr 的 `on` 方法 ✅

**4. 测试 mock EventEmitter 用法正确**（test L27-36）
- `const stdout = new EventEmitter()` 原生 `on/emit`，无 `.on = .bind` 的旧 bug ✅
- `emitLine` 用 `stdout.emit("data", Buffer)` 触发 PiRpcClient 注册的 `stdout.on("data", cb)` ✅
- mock `kill()` 置 `killed=true`，`dispose()` 幂等检查有效 ✅

**5. intercom ask/reply 刻意不在 handleLine 处理**（L184-185 注释）
- 设计合理：intercom 旁路 broker，由 IntercomMonitor 监听，PiRpcClient 只管 pi 主线 RPC ✅

### 5 Concerns 严重性复核（区分 mock 层阻断 vs 集成层推迟）

按 brief 判定标准：**mock 层已覆盖的不算阻断；真实 pi 集成才暴露的标 Important，推迟到 Task 33。**

| # | Concern | 严重性 | 判定 | 归属 |
|---|---|---|---|---|
| 1 | `message_update`/`state_change` 字段名假设性 | Important | mock 用同名字段，4 测试全过；真实 pi 事件流（`agent_start`/`turn_start`/`message_start`/`message_update`/`message_end` 等）字段若不同需调 switch。brief L249 已明示此假设需 Task 1/33 核对 | **推迟 Task 33** |
| 2 | 流式 `message_update` 每次新 `randomUUID()` → 同一回复被拆多条 message 事件 | Known design | mock 测试不涉及流式累积；这是上层（SessionStore 写入 / 前端渲染）的合并策略问题，brief L165 注释 `sessionId: "" // 由 AgentManager 填` 已暗示此层上推 | **推迟上层 Task（非本 Task）** |
| 3 | 错误处理薄弱（JSON.parse 静默吞、stderr 仅占位、无 exit/exit-code 处理） | Important | mock 路径下 pi 不崩溃，4 测试全过；生产路径下 pi 崩溃时 PiRpcClient 无 `onError` 回调，需 AgentManager 通过子进程 exit 事件 + `dispose()` 兜底。PiRpcClient 职责是 RPC 客户端，进程生命周期归上层 | **推迟上层（Task 33 / AgentManager）** |
| 4 | `defaultSpawn` 返回的 `killed` 永远 false → 生产路径 `dispose()` 幂等失效 | Important | mock 路径 `killed` 由 `kill()` 置 true，幂等检查有效，4 测试全过；生产路径 `killed: false` 字面量，`kill()` 调 `proc.kill()` 却不更新标志，二次 `dispose()` 会重复 `proc.kill()`。**唯一触及真实代码逻辑的 concern**，但因全测试走 mock 未暴露 | **推迟 Task 33**（建议修复方案：`get killed() { return proc.killed }` 或闭包标志位） |
| 5 | `--mode rpc --name --cwd` CLI 参数未对照 pi 0.80.3 `--help` | Important | mock 路径不 spawn 真实 pi（`spawnFn: () => mock`），4 测试全过；生产路径参数签名需集成时核实 | **推迟 Task 33** |

**关键结论**：5 个 concerns 中，**无一构成 mock 层阻断**。全部属于「真实 pi 集成才暴露」的范畴，符合 brief L265「第三层 `[需 pi 环境]` 未强制，留 Task 33 集成测试覆盖」的设计意图。

---

## 给后续 Task 的接力债（Task 33 集成前必做）

1. **抓真实 pi 事件样本**：`pi --mode rpc` 跑一次，抓 stdout JSONL，对照 `handleLine` 补全 `agent_start`/`turn_start`/`message_start`/`message_end`/`turn_*`/`error` 等事件分支（concern 1）
2. **核 CLI 参数**：`pi --mode rpc --help` 确认 `--name`（intercom 注册名）/`--cwd` 签名（concern 5）
3. **修 `defaultSpawn.killed`**：改为读 `proc.killed` 或闭包标志，恢复 `dispose()` 幂等（concern 4）
4. **补 exit 兜底**：AgentManager 监听子进程 exit，异常退出时调 `dispose()` 并上报（concern 3）
5. **定 message 合并策略**：SessionStore 写入 / 前端渲染层如何聚合同一 assistant 回复的多个 `message_update` 增量（concern 2）

---

## 最终结论

- **Spec 合规：✅**
- **代码质量：✅（mock 层无阻断）**
- **需修复：否（本 Task 无需修复；5 项 Important 已登记为 Task 33 集成前接力债）**

Task 8 可放行，进入下一 Task。
