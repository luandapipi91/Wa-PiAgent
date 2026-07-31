# 流式 Bridge + 子代理进度直推前端

**日期**：2026-07-31
**类型**：架构修复 + 功能增强
**状态**：待实现

## 1. 问题

子代理委托（`delegate` / `fleet`）执行到一半，主代理侧报错：

```
bridge 调用失败: The operation timed out.
```

子代理任务被迫中断，主代理拿不到结果。

## 2. 根因（铁证）

架构链路：前端 ←SSE→ kernel ←JSON-RPC→ pi 子进程；工具调用走 **bridge**（pi 进程内的 `wa-pi-bridge` 扩展通过 HTTP 回调 kernel 的 `/bridge/tool` 端点）。

`delegate` / `fleet` 的 bridge 调用是**一次性阻塞请求**：kernel 侧 `handleBridgeRequest`（`bridge-registry.ts:81`）要 `await ctx.handleTool()` 把整个子代理执行跑完才返回响应；期间两端都不写字节。

这条 fetch 跑在 pi 子进程内，而 pi 的 rpc 进程启动时**无条件**调用 `configureHttpDispatcher()`（`@earendil-works/pi-coding-agent` 的 `dist/rpc-entry.js:8` → `dist/core/http-dispatcher.js:66`），用 undici `setGlobalDispatcher` 把全局 fetch 的 `headersTimeout` 和 `bodyTimeout` 都设为：

```
DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000   // 5 分钟（http-dispatcher.js:3）
```

因此**只要子代理执行超过 5 分钟**，那条长期挂起、期间无字节流动的 bridge fetch 就会被 undici 的 idle timeout 判死，抛原生超时错误，被 `wa-pi-bridge.extension.ts:112-114` 的 catch 文本化为 `"bridge 调用失败: ..."`。

> 注：pi 自身设定的 `DELEGATE_TIMEOUT_MS = 1_800_000`（30 分钟，`wa-pi-bridge.extension.ts:43`）**永远不会触发**——在它之前 undici 的 5 分钟 idle timeout 早就把连接砍断了。

**本质**：bridge 是"一次性阻塞到结束"的请求-响应，执行期间无字节流动，被中间层（undici 5 分钟 idle timeout）判死。

## 3. 解决思路

把 `delegate` / `fleet` 的 bridge 调用改成**流式**：kernel 一收到请求就立即回写响应头 + `started` 帧（满足 `headersTimeout`），子代理每产生一个进度事件就 flush 一行 JSON（重置 `bodyTimeout`），结束时写一个 `final` 帧。

**一条流式管道同时解决两个问题**：
1. **超时**：持续有字节流动，undici 的 idle timeout 永远不触发。
2. **实时显示**：进度帧本就要产出，顺带转发到 SSE 总线给前端，主代理和用户都能实时看到子代理在干什么。

## 4. 流式协议设计（kernel ↔ bridge 扩展）

### 4.1 传输格式

NDJSON（每帧一行 UTF-8 JSON + `\n`），`Content-Type: application/x-ndjson`。
用纯流式响应而非 SSE，因为消费方是 pi 进程内的 `fetch`，不是浏览器 `EventSource`。

### 4.2 帧类型（3 种）

```ts
// shared/types.ts 新增

/** 子代理进度事件（从 kernel 内部 subagent-runner.ts:38-44 提升到 shared，供前后端共用） */
export interface SubagentProgressEvent {
  agent: string;
  status: "running" | "done" | "error";
  output: string;          // 子代理累计输出文本（流式累积，可能很长）
  tools: Array<{ id: string; name: string; status: string }>;
  elapsedMs: number;
}

/** bridge 流式协议帧 */
export type BridgeStreamFrame =
  // 握手帧：响应头 flush 后立即发送。
  // 作用：① 让 fetch 拿到响应、满足 headersTimeout；
  //       ② 声明流式协议版本，老客户端可据此降级为一次性 JSON 解析。
  | { type: "started"; protocol: 1; tool: string; toolCallId: string }
  // 进度帧：子代理每次 onProgress 触发。既是保活字节，也承载子代理实时状态（含完整 output）。
  | { type: "progress"; tool: string; toolCallId: string; progress: SubagentProgressEvent }
  // 终止帧：有且仅有一个，标志流结束。承载最终结果或错误。
  | {
      type: "final";
      tool: string;
      toolCallId: string;
      ok: boolean;
      result?: BridgeToolResult;   // ok=true 时的最终结果（含 content/details）
      error?: string;              // ok=false 时的错误文案
    };
```

### 4.3 kernel 侧写入规则（`/bridge/tool` 端点，仅 delegate/fleet 走流式）

1. 校验 token 后，**不等** `handleTool` 完成，立即 flush `started` 帧 + 响应头。
2. `handleTool` 执行期间，把 `SubagentProgressEvent` 实时 flush 成 `progress` 帧。
3. `handleTool` resolve → flush `final`（ok:true, result）；reject 或抛错 → flush `final`（ok:false, error）。
4. **任何情况**下 `final` 帧后立即关闭流，保证 bridge 侧不会无限等待。
5. 写流出错（客户端已断开）时，需中止底层子代理执行（通过 `handleTool` 的 `signal`）。

### 4.4 bridge 侧读取规则（`callBridge` 改造）

1. 发 fetch，`signal` 仍接 `AbortController`（保留超时兜底能力）。
2. 拿到 `res.body` 的 `ReadableStream` 后，逐行读取：
   - `started` → 标记进入流式模式。
   - `progress` → 收到即证明连接存活（重置 undici 计时器）；bridge 侧本身不消费进度内容。**注意：主代理 LLM 在工具调用期间不消费 progress 帧**——LLM 的工具调用语义是"调用→等结果"，中途无法插入；progress 仅用于保活 + 经 kernel SSE 广播给前端展示。主代理 LLM 仍在 `final` 帧一次性拿到工具结果。
   - `final` → 流结束，按 `ok` 组装 `BridgeToolResult` 返回。
3. 流意外中断（未收到 `final` 就 EOF / fetch reject）→ 退化为错误结果 `"bridge 调用失败: 连接中断"`。
4. 超时（setTimeout 触发）→ abort fetch，返回超时错误。正常运行时永不触发，仅在真正卡死时兜底。
   - `DELEGATE_TIMEOUT_MS` 收窄：从 30 分钟改为 **10 分钟无任何帧**才判死（流式后"无帧"才是真卡死信号）。
   - `ASK_TIMEOUT_MS`（10 分钟）、`DEFAULT_TIMEOUT_MS`（60s）保持不变（非流式工具）。

### 4.5 向后兼容（降级）

bridge 侧先读首帧：
- 是 `started` → 流式协议。
- 不是（如老 kernel 返回普通 JSON 对象）→ 走旧的"一次性 JSON"解析路径。

### 4.6 工具分流

- **delegate / fleet** → 走流式（`started`/`progress`/`final`）。
- **ask_user_question / memory_*** → 保持原同步请求-响应（超时分别为 10min / 60s，够用）。

端点层（`ws-server.ts` 的 `/bridge/tool`）根据 body 的 `tool` 字段分流，或由 `handleBridgeRequest` 内部判断。

### 4.7 fleet 的多源进度

fleet 并行跑多个子代理（`runWithConcurrency`，上限 5），进度事件来自多个 `runSubagentAgent`。
- `progress` 帧的 `progress.agent` 字段区分是哪个子代理。
- `final` 仍只有一个（聚合所有子代理结果，沿用 `delegate-tool.ts` 现有聚合逻辑）。

## 5. 改动清单与各层职责

按"从底往上、先 kernel 再 bridge 扩展最后前端"的依赖顺序。

### 5.1 `packages/shared/src/types.ts`

- 新增 `SubagentProgressEvent`（从 kernel 内部提升到 shared）。
- 新增 `BridgeStreamFrame`（started/progress/final 三种）。
- `WSServerEvent` 联合类型新增 `subagent:progress` 事件（前端消费用，承载 `SubagentProgressEvent` + `sessionId` + `toolCallId`）。

### 5.2 `packages/kernel/src/bridge-registry.ts`

`handleBridgeRequest` 当前返回 `BridgeResponse`（`await ctx.handleTool()` 完才返回）。改造支持流式：

- `BridgeSessionContext.handleTool` 增加 `onProgress` 回调参数（可选）：
  ```ts
  handleTool(
    tool: string, toolCallId: string, params: unknown, signal: AbortSignal,
    onProgress?: (e: SubagentProgressEvent) => void,   // 新增
  ): Promise<BridgeToolResult>;
  ```
- 新增 `handleBridgeStream(body, write)`：对 delegate/fleet 走流式分支——先 flush `started`，再 `handleTool(..., onProgress)`，`onProgress` 内 flush `progress`，resolve/reject 后 flush `final`。
- 其余工具保持原 `handleBridgeRequest` 同步返回路径。

### 5.3 `packages/kernel/src/agent-manager.ts:534`（断点修复核心）

`makeSpawnFn`（`delegate-tool.ts`）本就接受 `onProgress`（`:187`）并透传给 `runSubagentAgent`（`:240`），但这里构造 `spawnFn` 时**没传**——进度管道在此断开。

```ts
const spawnFn = makeSpawnFn({
  resolveConfig: resolveSpawnConfig,
  // ... 其他不变
  onProgress: (event) => {
    // ① 作为 bridge 流式的 progress 帧（由 handleTool 的 onProgress 参数透传）
    // ② 转发到 SSE 总线给前端
    this.opts.sseBus.broadcast("subagent:progress", { sessionId, ...event });
  },
  onSpawnComplete: (input) => subagentTelemetry.record(input),
});
```

一条 `onProgress` 同时供给：bridge 流式帧（给主代理）+ SSE 广播（给前端）。

> 注意：`onProgress` 闭包需能拿到当前 `sessionId`；`makeSpawnFn` → `runSubagentAgent` 的透传链路已就绪，仅此处未接线。

### 5.4 `packages/kernel/src/ws-server.ts`（`/bridge/tool` 端点）

当前端点（`:397-413`）对 delegate/fleet 走 `handleBridgeRequest` → 一次性 `Response.json`。改造：

- delegate/fleet：构造流式 `Response`（`Content-Type: application/x-ndjson`），把 `Response` 的 writer 传给 `handleBridgeStream`。
- 其余工具：保持原路径。

### 5.5 `packages/kernel/src/wa-pi-bridge.extension.ts`

`callBridge` 对 delegate/fleet 改为流式读取：
- fetch 后拿 `res.body.getReader()`，按 NDJSON 逐行读帧。
- `started`/`progress` 持续消费（证明存活）。
- `final` → 组装 `BridgeToolResult` 返回。
- 流中断 / 未收到 final → 退化为错误结果。
- `DELEGATE_TIMEOUT_MS` 从 30 分钟收窄到 10 分钟（无帧兜底）。

### 5.6 前端

- 新增 `packages/frontend/src/store/subagent-progress.ts`（或并入现有 thread/messages store）：监听 `subagent:progress` SSE 事件，按 `sessionId + toolCallId` 聚合进度。
- `DelegateCard.tsx` / `FleetCard.tsx` 消费进度事件渲染（详见第 6 节）。

### 5.7 改动文件汇总

| 文件 | 改动 | 复杂度 |
|---|---|---|
| `shared/src/types.ts` | 新增 `SubagentProgressEvent` / `BridgeStreamFrame` / `subagent:progress` 事件 | 低 |
| `kernel/src/bridge-registry.ts` | `handleTool` 加 `onProgress` 参数 + `handleBridgeStream` 流式分支 | 中 |
| `kernel/src/agent-manager.ts:534` | 传 `onProgress`（接通管道 + SSE 广播） | 低 |
| `kernel/src/ws-server.ts` | `/bridge/tool` 端点 delegate/fleet 走流式 `Response` | 中 |
| `kernel/src/wa-pi-bridge.extension.ts` | `callBridge` 流式读取 + 超时收窄 | 中高 |
| `frontend/...` | 进度 store + DelegateCard/FleetCard 渲染 | 中 |

## 6. 前端渲染策略（默认折叠）

**设计原则**：进度数据照常全量接收（含 output、tools 列表），但 **UI 默认收起细节，只露摘要**，避免子代理的工具调用序列淹没主会话上下文。

### 6.1 DelegateCard

**默认态（折叠）**：
- 一行摘要：`子智能体 · 运行中 · 已用时 12s · 5 个工具调用`
- 或当前活动文案：当前正在执行的工具名（如"正在执行 Bash"）/ 累计 output 的最后一行
- 一个 `▶ 展开` 开关

**展开态（用户点击后）**：
- 完整 output（流式累积文本，可滚动）
- 工具调用时间线：`tools` 列表逐条渲染（名称 + 状态徽标 + 耗时）

### 6.2 FleetCard

- 默认折叠，摘要行带汇总：`3 个子智能体：2 运行中 / 1 完成`
- 展开后按 `progress.agent` 分组，每组同 DelegateCard 展开态

### 6.3 完成态

**完成态也默认折叠**（全生命周期一致）：只显示 `子智能体 · 完成 · 耗时 45s` + 结果首行截断。用户想看详情再展开。

## 7. 不做的事（YAGNI）

- **不做子代理"无活动看门狗"**（探活自动中断）：当前根因是 undici 5 分钟 idle timeout，流式管道治本后即解决；子代理真卡死是独立问题，本次不做。
- **不改 ask/memory 工具**：它们是短任务，现有同步请求-响应 + 超时足够。
- **不彻底解决前端 prompt fetch 的 30s 超时**：用户看到的报错（带 "bridge 调用失败" 前缀）根因在 bridge 侧 undici 5 分钟 idle timeout，本次修复它。但需诚实记录：前端 `api.post('/api/.../prompt')`（`api-client.ts:26` 的 `AbortSignal.timeout(30_000)`）在 turn 超过 30s 时仍会抛裸英文 `DOMException`（落到 `App.tsx` catch 的 console），修了 bridge 后 turn 会更长，这个 console 报错会更频繁出现。这是 `callApi` 同步 `await handle()` 设计的遗留问题（`ws-server.ts:321`），属另一个独立议题，本次不展开，但记录于此以免被忽略。

## 8. 验收标准（4 层）

### 第一层：单元测试（bun:test）

- `bridge-registry.ts`：`handleBridgeStream` 在 delegate/fleet 时正确输出 started→progress*→final 序列；ask/memory 仍走同步路径。
- `wa-pi-bridge.extension.ts`（callBridge 流式读取）：mock 一个返回 NDJSON 流的 fetch，验证 started/progress/final 帧正确解析为 `BridgeToolResult`；流中断时退化为错误结果。
- `agent-manager.ts`：`spawnFn` 的 `onProgress` 被调用时，SSE 广播 `subagent:progress` 事件被触发。

### 第二层：组件测试（Vitest + RTL）

- `DelegateCard`：收到 `subagent:progress` 事件后，默认折叠态显示摘要（工具数/耗时）；点击展开后显示 output 和工具时间线。
- `FleetCard`：多 agent 进度按 `progress.agent` 分组渲染；折叠/展开行为正确。

### 第三层：API 接口测试（curl）

- `POST /bridge/tool`（tool=delegate）：返回 `Content-Type: application/x-ndjson`，body 含完整的 started→progress*→final NDJSON 序列。
- `POST /bridge/tool`（tool=memory_add）：仍返回普通 JSON（非流式）。
- 错误路径：子代理执行抛错时，final 帧 `ok:false` 且带 error 文案。

### 第四层：E2E（Playwright）

- 触发一个 delegate 任务（子代理执行 > 5 分钟，如遍历大目录）：验证不再出现 "bridge 调用失败: The operation timed out"，且前端 DelegateCard 实时显示进度（摘要更新），完成后默认折叠。
- 测试截图在全部完成后清理。
