# 去 WS 化：HTTP REST + SSE 架构迁移 & 对话卡顿修复设计

- 日期：2026-07-26
- 状态：已获用户批准
- 范围：kernel 对外传输层全量迁移（WebSocket → REST + SSE + HTTP 文件通道），并先行修复对话卡顿

## 1. 背景与目标

### 1.1 现状

- 前端与 kernel 之间只有**一条 WebSocket**（`ws://127.0.0.1:9776`，`packages/frontend/src/ws-instance.ts` → `packages/kernel/src/ws-server.ts`），承载 60+ 种消息类型：对话流、项目/会话 CRUD、provider/skill/extension/mcp 管理、文件系统（含 base64 大文件上传与录音分片，`WS_MAX_PAYLOAD=80MB`）。
- 对话链路：浏览器 ──WS──> kernel ──stdin/stdout JSONL──> pi 子进程 ──HTTPS──> LLM API。LLM 调用在 pi 子进程内部，与 WS 无关。

### 1.2 卡顿根因（调查结论）

WS 协议本身（本机 loopback）**不是**卡顿根因，根因有三：

1. **`message_update` 全量传输 O(n²)**：pi 每 token delta 发出携带完整 partial message 的事件，kernel 原样 `JSON.stringify` 广播（`packages/kernel/src/index.ts:131-144`、`ws-server.ts:199-215`），前端全量替换 streaming message（`packages/frontend/src/store/session.ts:186-194`）。序列化+传输+渲染总成本随输出长度平方增长。
2. **前端每 token 全量重渲染**：`streamingBySession` 每个 delta 触发 zustand set → `MessageList.tsx:45-51` 重渲染，无节流/合帧。
3. **大文件帧队头阻塞**：base64 上传/录音分片（最大 50MB）与流式事件共用一条 WS。

另：前端 WS **无任何重连/心跳逻辑**（`ws-instance.ts` 全文 43 行），静默断线后 UI 永久失联。

### 1.3 目标

- **阶段一**：修复对话卡顿（不动协议，快速交付）。
- **阶段二**：全面去 WS 化——所有请求/响应走 REST，所有服务端推送走全局 SSE 事件总线，大文件走 multipart HTTP。彻底移除 WebSocket。
- 多客户端兼容：多个标签页/客户端同时连接 kernel 时均能看到一致的会话状态（保持现有 broadcast 语义）。

### 1.4 非目标

- 不改 pi 子进程、AgentManager、kernel↔pi 的 RPC 协议。
- 不做 WS/HTTP 双协议并存与灰度切换（本机应用、前后端同版本发布）。
- 不引入新的 HTTP 路由框架（在现有 `Bun.serve` fetch 路由上扩展轻量路由表）。

## 2. 整体架构

```
浏览器/Electron 前端                        kernel (Bun.serve)
─────────────────                         ──────────────────
api-client.ts (fetch)  ──HTTP POST/GET──>  REST 路由层（新）
events.ts (EventSource) <──SSE 流────────  /api/events（新，广播总线）
files (multipart)      ──HTTP POST──────>  /api/files/*（新）
                                            │
                                     AgentManager → pi 子进程（不变）
```

三条通道，职责单一：

1. **REST 通道**：所有请求/响应类消息（约 50 种）。同步语义，直接返回 JSON 结果或错误码，不再需要 WS 的 id/reply 回调匹配。
2. **SSE 事件总线**：`GET /api/events`，一条长连接承载所有服务端主动推送。kernel 维护 `Set<SSEClient>`，现有 `broadcast()` 改为向所有 SSE 客户端写帧。
3. **文件通道**：multipart 上传与录音分片上传。

协议 schema 不变：`packages/shared/src/types.ts` 现有消息类型直接复用为 REST body / SSE data 帧的 TS 类型，仅去掉 WS 特有的 id/reply 关联信封（REST 用 HTTP 状态码+响应体表达）。

## 3. REST 通道设计

- 统一前缀 `/api`，按域分组，与现有消息类型一一对应。示例：
  - `POST /api/agents/:projectId/:sessionId/prompt`（body：text/model/thinking/attachments）
  - `POST /api/agents/:projectId/:sessionId/abort`、`/answer`、`/cancel-ask`
  - `POST /api/steer/:sessionId/promote|immediate|cancel|clear-queue`
  - `GET/POST/DELETE /api/projects…`、`/api/sessions…`、`/api/providers…`、`/api/models/presets`、`/api/skills…`、`/api/extensions…`、`/api/memories…`、`/api/instructions…`、`/api/mcp…`、`/api/fs/list-dir|read-file|copy…`
- 实现：在 `ws-server.ts` 现有 fetch 路由上扩展轻量路由表（method+path 模式 → handler）。现有 `handle()` 大 switch 每个 case 的业务逻辑**原样搬入对应 handler**，入参从"WS 消息+reply 回调"改为"Request→Response"。
- 响应约定：成功 `200 {data}`；错误 body 统一 `{error: string}`，状态码：参数错误 400、资源不存在 404、未支持 501、内部错误 500。
- 保留现有 `POST /bridge/tool` 与 `GET /file?path=` 不变。

## 4. SSE 事件总线设计

- `GET /api/events` → `text/event-stream`。kernel 为每个连接分配 `clientId`（仅用于连接管理与日志），存入 `Set`；写失败或连接关闭即移除。
- 帧格式：

  ```
  event: <消息类型>\n
  data: <JSON>\n\n
  ```

  JSON 即现有 server→client 消息类型（`SDKEventEnvelope`、`session:created`、`session:echo_user`、`queue_update`、进度帧等）。
- **定向进度消息**：客户端 `api.post` 发起操作（如 `fs:search`、extension 安装），响应带 `requestId`；进度帧带同一 `requestId` 经总线广播，前端按 id 过滤，完成帧到达后取消监听。原则：**推送只走总线**，前端只有一种流式路径。
- **心跳**：每 30s 发一行 `: ping\n\n` 注释帧，防代理/空闲断连，前端可感知连接存活。
- **重连与对齐**：EventSource 断线自动重连；重连成功后前端触发快照刷新（重新拉 `GET /api/sessions/:id/messages` 等）对齐状态。kernel 不做事件重放（本地单进程、事件均为瞬态进度，快照足够）。

## 5. 文件与录音通道

- `POST /api/files/upload`：multipart/form-data，替代 `fs:upload` 的 base64 分片；kernel 侧流式写盘，不再需要 80MB 内存上限。
- `POST /api/files/recording`：录音分片逐段 POST（每片一个请求，带 `recordingId` + `seq`），替代 `fs:recording` WS 分片。
- `GET /file?path=` 下载端点保留不变。

## 6. 前端改造

- 删除 `ws-instance.ts`，新增：
  - `src/api-client.ts`：fetch 封装（`api.get/post/del(path, body)`），非 2xx 统一抛错（带 `{error}` 消息）。
  - `src/events.ts`：EventSource 单例连接 `/api/events`；`Map<type, Set<listener>>` 分发；`on(type, fn)` / `off(type, fn)`；重连成功后触发快照刷新回调。
- `App.tsx:50-122` 大 switch 改为向 `events.ts` 注册各类型监听；store 层（`session.ts` 的 `handleSDKEvent` 等）**不动**。
- `Composer.tsx` 等发送点从 `ws.send({type:...})` 改为 `api.post(...)`；原依赖 reply 回调处改用 `await` 返回值。
- 进度类流程：`api.post` 拿 `requestId` → 监听总线同 `requestId` 帧 → 完成后取消监听。
- desktop 包：仅核查 kernel 启动/端口探测是否有 WS 专属假设，Electron 壳不变。

## 7. 卡顿修复专项（阶段一）

1. **kernel 节流合并**：`AgentManager.onEvent` 出口处对同一 session 的 `message_update` 节流——每 ~50ms 最多发一帧（帧内为最新完整 partial），间隔内中间帧丢弃。协议零改动，前端无感。
2. **前端 rAF 合帧**：`session.ts` 对 streaming 更新做 rAF 合帧，一帧内多次 delta 只提交一次 zustand set；`MessageList` 渲染路径不变。
3. **大文件阻塞**：随第 5 节文件通道迁移到 HTTP multipart 自然解决；若阶段一先行时文件迁移未完成，kernel 可对上传分片做优先级隔离（流式事件优先写入）作为过渡。

验收：用 >2000 token 长回复实测修复前后对比——kernel 出站字节数、前端渲染帧数、主观流畅度。

## 8. 错误处理与兼容

- REST：统一 `{error}` body + 状态码；前端 `api-client` 统一抛错，UI 层 toast。
- SSE：断线由 EventSource 自动重连 + 快照刷新；kernel 写失败即移除客户端。
- 迁移期一次性切换，不保留 WS 兼容层；迁移完成后删除 WS upgrade 逻辑与 `WS_MAX_PAYLOAD` 等 WS 专属配置。

## 9. 测试策略（四层）

- **单元测试（bun:test）**：kernel 各 REST handler 参数校验与错误路径；节流合并函数；前端 `api-client` / `events.ts` 分发逻辑。
- **组件测试（Vitest + @testing-library/react + happy-dom）**：`Composer` 发送路径；`MessageList` streaming 合帧后行为。
- **API 接口测试（curl）**：每个新 REST 端点至少覆盖成功 + 一个错误路径；`/api/events` 连接后触发事件验证收到帧。
- **E2E（Playwright）**：完整对话流（发消息→流式输出→中断）、文件上传、多标签页同步（两个 page 验证 broadcast）。
- 现有 `packages/kernel/tests/ws-*.test.ts` 改写为对应 REST/SSE 版本。

## 10. 交付计划

- **阶段一（卡顿修复）**：kernel 节流合并 + 前端 rAF 合帧（+ 可选上传优先级隔离），先行交付。
- **阶段二（去 WS 化）**：REST 路由层 + SSE 总线 + 文件通道 + 前端改造，整体完成后一次性切换，删除 WS。
- 每阶段完成后更新根目录 `CHANGELOG.md`（新条目置顶）。
