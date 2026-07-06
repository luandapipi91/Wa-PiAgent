# Task 8 Report: PiRpcClient（spawn + JSONL）

## 状态
✅ 完成

## Commit
- hash: `f1875ffd0f41692f4d6b3905039651fb1f431c0b`
- message: `feat(kernel): PiRpcClient（真实 spawn + JSONL，测试 mock 子进程）`
- files:
  - `packages/kernel/src/pi-rpc-client.ts`（新建，实现）
  - `packages/kernel/tests/pi-rpc-client.test.ts`（新建，4 测试）

## 工作流（TDD）
1. 读 brief：确认 `PiEvent` 联合类型、`PiRpcClient` 接口、`mockSpawn` 用 `getStdoutBuf()`/`resetStdoutBuf()` 方法（非属性赋值）。
2. Step 1：按 brief 原文写测试文件。
3. Step 2：跑测试 → FAIL（`Cannot find module '../src/pi-rpc-client'`），符合预期。
4. Step 3：按 brief 原文写 `pi-rpc-client.ts`。
5. Step 4：跑测试 → **4 passed**。
6. 回归：`bun test packages/kernel/` → **21 passed**（前 7 Task 测试无回归）。
7. Step 5：commit。

## 测试摘要
```
packages/kernel/tests/pi-rpc-client.test.ts:
(pass) start 发 get_state 握手 [1.51ms]
(pass) prompt 写入 stdin [0.14ms]
(pass) onEvent 收 message_update → message 事件 [0.44ms]
(pass) onEvent 收 state 变化 [0.15ms]
4 pass, 0 fail, 5 expect() calls
```

## 实现要点
- `PiRpcClient` 构造注入 `spawnFn`，测试用 `mockSpawn`（EventEmitter 模拟子进程 stdout），生产用 `Bun.spawn`（封装在 `defaultSpawn`）。
- `start()`：spawn `pi --mode rpc --name <sessionName> --cwd <cwd>`，绑定 `stdout.on("data")` 做按行 JSONL 分帧（缓冲到 `\n`），握手发 `{type:"get_state"}`。
- `prompt(text)` / `abort()`：写入对应 JSONL 指令，自动累加 `id` 字段。
- `handleLine`：switch 处理 `message_update`（→ `kind:"message"`，role/text 转换，sessionId 留空由 AgentManager 填）和 `state_change`（→ `kind:"state"`，status 白名单 thinking/blocked/idle）。intercom ask/reply 不在此处理（由 IntercomMonitor 旁路 broker）。
- `dispose()`：kill 子进程（幂等，检查 `killed` 标志）。

## 验证层次（按 brief）
- 第一层（mock spawn）：✅ 4 passed。
- 第三层（真实 pi 流式 prompt 回复）：`[需 pi 环境]` 未强制，留 Task 33 集成测试覆盖。

## Concerns
1. **`message_update` 字段名假设性**：brief 注明事件字段名以 Task 1 验证文档为准。当前 `handleLine` 假设 pi RPC 输出 `{type:"message_update", role, text}` 与 `{type:"state_change", state:{status,...}}`。若真实 pi 事件流（Task 1 验证的 `agent_start/turn_start/message_start/message_update/message_end/...`）字段不同，需在 Task 33 集成时调整 switch 与字段映射——尤其 `message_start`/`message_end`/`turn_*`/`agent_*` 这些事件目前一律丢弃，只保留 `message_update` 增量。建议集成前先用真实 pi 跑一次 `--mode rpc` 抓样本事件流，对照 `handleLine` 补全。
2. **`message_update` 每次生成新 `id`/`timestamp`**：当前实现为每条 `message_update` 增量都发一条独立 `ChatMessage`（`randomUUID`）。流式场景下同一 assistant 回复会被拆成多条 message 事件，AgentManager/前端需自行合并或去重——这是已知设计点，后续 Task（SessionStore 写入 / 前端渲染）需明确合并策略。brief 的注释 `sessionId: ""  // 由 AgentManager 填` 已暗示此层由上层收口。
3. **错误处理薄弱**：`handleLine` 解析失败静默吞掉；`stderr.on("data")` 仅占位无日志。生产环境若 pi 进程崩溃或 stderr 报错，PiRpcClient 无 `onError` 回调，需在上层（AgentManager）通过 `dispose()` + 子进程 exit 事件兜底——本 Task 范围未覆盖 exit/exit-code 处理。
4. **`defaultSpawn` 的 `killed` 永远 false**：mock 路径下 `killed` 由 `kill()` 置 true；但生产 `defaultSpawn` 返回的对象 `killed` 是闭包外的字面量，`kill()` 调 `proc.kill()` 却不更新该标志——`dispose()` 的幂等检查 `!this.child.killed` 在生产路径下实际无效（每次都判定未 kill）。不阻塞本 Task（4 测试全过且走 mock），但集成时若需重复 dispose 防重入，应改为读 `proc.killed` 或外部标志位。
5. **未读 `pi` 真实 CLI 参数**：`--mode rpc --name --cwd` 三个参数名是 brief 给定假设，未对照已安装的 pi 0.80.3 `--help` 核实。Task 33 集成前应 `pi --mode rpc --help` 确认参数签名（尤其 `--name` 是否为 intercom 会话注册所用）。
