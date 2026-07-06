# Task 9 Review：IntercomMonitor（连 broker，跟踪 ask）

## 双判定结论

| 维度 | 结论 |
|---|---|
| **Spec 合规** | ✅ PASS |
| **代码质量** | ✅ PASS（无需修复，1 处合理偏差已最小化） |
| 是否需修复 | ❌ 不需要 |
| broker 协议联调推迟 | ✅ 确认推迟到 Task 33 集成联调，mock 层不阻断 |

---

## 一、Spec 合规判定：✅ PASS

逐项核对 brief 的交付契约：

| Spec 要求 | 验证 | 结论 |
|---|---|---|
| `class IntercomMonitor` 五方法 `connect/handleLine/getQueues/injectReply/dispose` | 源码 110 行，5 方法齐备（handleLine 为 private，符合"内部解析"语义） | ✅ |
| `connectReal` 生产连接（pi-intercom broker 路径） | `connectReal()` 动态 import `pi-intercom/broker/paths` 取 `getBrokerSocketPath()`，失败回退 HOME/USERPROFILE 派生默认路径（win32 Named Pipe / Unix sock） | ✅ |
| 构造 `connectFn` 可注入（测试 mock / 生产 connectReal） | `connect()`：`opts.connectFn ? await connectFn() : await connectReal()` | ✅ |
| `getQueues()` 返回 `Map<AgentName, AskItem[]>` 按 `to`（被问 agent）维度聚合 | `queues` 键为 `ask.to`；getQueues 返回浅拷贝 Map | ✅ |
| 4 个测试 passed | 实跑复现：`4 pass / 0 fail`（与报告一致） | ✅ |
| 全 kernel 25 passed | 实跑复现：`25 pass / 0 fail`（无回归） | ✅ |

**字段映射校验**（对照 `packages/shared/src/types.ts` 的 `AskItem` 定义）：
brief 测试用例发出的 `kind:"ask"` 消息含 `messageId/sessionId/from/to/text/startedAt`，`handleLine` 全部正确映射到 `AskItem` 七字段（含 `resolved:false`、`startedAt ?? Date.now()` 兜底）。`reply` 走 `askMessageId`（注意与 `ask` 用的 `messageId` 字段名不同——这是 pi-intercom 协议特征，brief 测试已正确区分）。✅

**getQueues 聚合维度**：测试 3 发 2 条 `to:"dev"`（from 分别 product/pm），断言 `q.get("dev")` 长度 2，证明按 `to` 而非 `from` 聚合。✅

**mock socket 注入**：测试通过 `connectFn: async () => sock` 注入 EventEmitter-based mock，与生产 `net.Socket` 共享 `on("data")`/`write` 接口，注入边界清晰。✅

---

## 二、代码质量判定：✅ PASS（无需修复）

### 1. `dispose()` 防御式处理 — ✅ 合理，处理对了

**问题背景**：brief 模板的 `dispose()` 调 `this.socket?.destroy()`，但 brief 自带的 mock socket（行 22-33）只挂了 `write/end/destroyed`，**没有 `destroy()` 方法**。这是 brief 模板自身的不一致（瑕疵），不是实现者引入的。

**实现者处理方式**（不改测试、不引入额外 mock 字段）：
```ts
if (typeof sock.destroy === "function") sock.destroy();
else if (typeof sock.end === "function") sock.end();
```

**判定合理**：
- 生产 `net.Socket` 同时具备 `destroy()` 与 `end()`，走 `destroy()` 分支，行为与 brief 原意一致。
- mock socket 缺 `destroy`，走 `end()` 分支（mock 的 `end` 是空函数），测试不再 fail。
- 语义等价"关闭连接"，未改变 connect/injectReply/handleLine 的任何契约，未污染 mock。
- 注释清晰说明了双分支的必要性。这是对 brief 瑕疵的最小、最干净的补救。

> 唯一可吹毛求疵处：`destroy()` 是 `net.Socket` 实例方法，靠 `typeof sock.destroy === "function"` 判别已足够（非伪造），不构成脆弱点。

### 2. `handleLine` 的 ask/reply 处理 — ✅ 正确

- **ask**：`allAsks.set(messageId, ask)` + `queues[to].push(ask)` + `onAsk(ask)`。入队与回调顺序正确。
- **reply**：先从 `allAsks` 反查到 ask（拿到 `to`），再 `queues[to].filter(移除该 messageId)` + `allAsks.delete(messageId)` + `onReply(askMessageId, sessionId)`。**reply 时确实既从队列移除、又从 allAsks 删除**（diff 行 76、77），双向清理无遗漏。
- 边界：`ask` 未找到时（`allAsks` 无此 id），仅触发 onReply，不抛错，容错合理。
- JSON 解析失败静默 return，符合 JSONL 流式解析惯例。

### 3. `injectReply` 写 socket 格式（`kind:"inject-reply"`）— ⚠️ 推迟（非阻断）

当前写 `{ kind:"inject-reply", askMessageId, text } + "\n"`。这是按 brief 注释"对照 pi-intercom client API"做的**当前最佳猜测**。

**判定：不阻断，推迟到 Task 33 联调**。理由：
- brief 明确标注"inject-reply 的实际发送格式需对照 pi-intercom client API"，本 task 无法在 mock 层验证真实格式。
- 若 pi-intercom 用 method+id 的 RPC 风格（类似 PiRpcClient.send 的递增 id），格式需调整——但这是 broker 集成层职责，非本 mock 单测能覆盖。
- 当前实现满足"写入 socket 且含 id+text"的契约（测试 2 已证），格式微调属联调期。

### 4. `connectReal` 动态 import + win32/Unix 回退 — ✅ 正确

- 动态 `import("pi-intercom/broker/paths")` 取 `getBrokerSocketPath()`，避免在仓库硬编码平台分支，正确把平台决策权交给 pi-intercom。
- 回退路径：win32 Named Pipe（`\\.\pipe\pi-intercom-<sanitized-home>`）/ Unix（`$HOME/.pi/agent/intercom/broker.sock`），与 pi-intercom 惯用命名一致。
- import 失败用 try/catch 兜底，未 import 整个 pi-intercom（只取 paths 子模块），最小化耦合。
- `connect(socketPath, () => resolve(sock))` + `sock.on("error", reject)`，连接期错误处理正确。

> connectReal 未被单测覆盖——设计如此（需真 broker），不阻断。

---

## 三、Concerns 归类确认

实现者报告列了 5 个 concerns，归类如下：

| # | Concern | 归类 | 是否阻断 |
|---|---|---|---|
| 1 | broker 消息协议字段（ask/reply 的 messageId/sessionId/from/to/text）未经真实集成验证 | **Task 33 集成联调** | ❌ 推迟 |
| 2 | inject-reply 发送格式未经真 broker 验证 | **Task 33 集成联调** | ❌ 推迟 |
| 3 | connectReal 未被测试覆盖 | 设计如此（需真 broker） | ❌ 推迟 |
| 4 | getQueues 浅拷贝 Map，AskItem 仍是同一引用 | 当前无调用方 mutate，本 task 范围外 | ❌ 推迟 |
| 5 | connect 未做运行期 error/重连 | 生产化项 | ❌ 推迟 |

**broker 协议联调推迟确认：✅** concerns 1、2 属 broker 真实协议联调项（ask/reply/inject-reply 字段格式），统一推迟到 Task 33 集成时联调，mock 层（本 task 4 测试）不阻断。这与 brief 末尾"以 Task 1 验证文档为准/调整 handleLine"的注解一致。

---

## 四、总评

实现严格遵循 brief 契约，5 方法齐备 + connectReal，4 + 25 测试均实跑复现通过。唯一的实现偏差（dispose 防御式 destroy→end 回退）是对 brief mock 模板瑕疵的正确补救，已最小化、有注释、不污染 mock、不改变契约。代码质量方面 handleLine 双向清理、connectReal 平台兜底、字段映射均无问题。broker 协议字段（concerns 1/2/3）确属 Task 33 集成联调范畴，mock 层不阻断。

**结论：Task 9 通过，无需修复，可进入下一 task。**
