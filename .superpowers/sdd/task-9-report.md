# Task 9 报告：IntercomMonitor（连 broker，跟踪 ask）

## 状态
✅ 完成

## Commit
`a55719c` — `feat(kernel): IntercomMonitor（连 broker，跟踪 ask 队列 + injectReply）`

## 交付物
- `packages/kernel/src/intercom-monitor.ts`（IntercomMonitor 类）
- `packages/kernel/tests/intercom-monitor.test.ts`（4 个 mock-socket 测试）

## 测试摘要
```
bun test packages/kernel/tests/intercom-monitor.test.ts
 4 pass / 0 fail

bun test packages/kernel/（全量回归）
 25 pass / 0 fail
```

### 4 个测试
| 测试 | 验证点 |
|---|---|
| connect 后收 ask → onAsk | JSONL 按行解析；`kind:"ask"` 触发 onAsk，AskItem.to 正确 |
| injectReply 写入 socket | `injectReply(id, text)` 经 socket.write 写出含 id+text 的 JSONL |
| getQueues 按 to 维度聚合 | 两条 to=dev 的 ask 聚合到同一队列，长度=2 |
| 收 reply 后从队列移除 | `kind:"reply"` 触发 onReply(id, sessionId)，并从 to 队列移除对应 ask |

## 实现要点
- `connect()`：用注入的 `connectFn`（测试）或 `connectReal`（生产）拿 socket，挂 `data` 监听做按行 JSONL 缓冲解析（`buf` + `indexOf("\n")` 循环，同 PiRpcClient 模式）。
- `handleLine`：`kind/type === "ask"` 入队（queues 按 `to` 维度 + allAsks 按 messageId）并 onAsk；`kind/type === "reply"` 按 askMessageId 从 allAsks 反查 to，从对应队列 filter 移除并 onReply。
- `getQueues()`：返回浅拷贝 Map（避免外部直接改内部状态）。
- `injectReply`：写 `{ kind: "inject-reply", askMessageId, text } + "\n"`。
- `connectReal`：动态 `import("pi-intercom/broker/paths")` 取 `getBrokerSocketPath()`；import 失败时回退到 HOME/USERPROFILE 派生的默认路径（win32 Named Pipe / Unix socket）。平台分支不在本仓库硬编码，交给 pi-intercom。

## 与 brief 的偏差（1 处，已最小化）
**`dispose()` 做了防御式处理。** brief 模板的 `dispose()` 调 `this.socket?.destroy()`，但 brief 自带的 mock socket 只挂了 `write/end/destroyed`，没有 `destroy()` 方法，导致 4 个测试在 `mon.dispose()` 处全 fail。

解决方式（不改测试、不引入额外 mock 字段）：dispose 优先调 `destroy()`，不存在时回退 `end()`：
```ts
if (typeof sock.destroy === "function") sock.destroy();
else if (typeof sock.end === "function") sock.end();
```
生产 `net.Socket` 两者皆有，行为不变；mock socket 走 `end()` 分支。语义上等价于"关闭连接"，未改变 connect/injectReply/handleLine 的任何契约。

## Concerns
1. **broker 消息协议未经真实集成验证**：`handleLine` 对 `kind`/`type` 双字段容错（`obj.kind === "ask" || obj.type === "ask"`），但 pi-intercom broker 实际广播字段名（messageId/sessionId/from/to/text）未在本仓库内联验证。brief 注释明确"以 Task 1 验证文档为准"——建议在能跑真 broker 时做一次端到端联调，必要时调整 handleLine 的字段映射。
2. **inject-reply 发送格式未经真 broker 验证**：当前写 `{kind:"inject-reply", askMessageId, text}`，是否匹配 pi-intercom client API 需对齐其文档（brief 已标注）。若 pi-intercom 用 method+id 的 RPC 风格（类似 PiRpcClient.send 的递增 id），此格式可能要改。
3. **connectReal 未被测试覆盖**（设计如此，需真 broker）。当前仅保证 mock 路径（connectFn 注入）的契约正确。回退 socketPath 派生逻辑也无单测。
4. **getQueues 是浅拷贝 Map，但 AskItem 对象仍是同一引用**：外部若 mutate 单个 AskItem 会影响内部队列。当前无调用方这样做，但严格起见可考虑深拷贝；本 task 范围内未处理。
5. **connect 未做错误/重连**：socket `error` 事件未挂监听（connectReal 内单独 reject 了一次，但 connect 成功后的运行期 error 未处理）。生产化时需补 error/close 处理与重连。
