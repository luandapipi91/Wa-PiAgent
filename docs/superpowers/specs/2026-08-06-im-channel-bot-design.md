# IM 渠道机器人功能设计（v1：企业微信）

日期：2026-08-06
状态：已确认（架构方案 A + 界面原型 v3 经用户确认）

## 1. 背景与目标

把外部 IM 渠道的消息接入 WA PI Agent 的智能体：用户在 IM 里与机器人对话，消息路由到系统内指定智能体处理，回复再推回 IM。v1 优先支持**企业微信**，架构预留微信 / 飞书 / QQ。

核心需求（用户确认）：

1. 可配置多个相同类型的渠道（多个企微机器人并存）
2. 每个渠道可指定系统内的智能体
3. 渠道不绑死工作目录，IM 用户可通过指令在已有项目（工作区）间切换，默认落「默认工作区」
4. 渠道可配置额外系统提示词，追加拼接到已有系统提示词中、**位于记忆内容之前**
5. 可设置机器人回复粒度（简洁 / 标准两档）

## 2. 调研结论

- 企业微信「智能机器人」支持 API 模式 + **WebSocket 长连接**，官方 SDK `@wecom/aibot-node-sdk`（GitHub: WecomTeam/aibot-node-sdk）提供消息收发、事件回调、文件下载解密、媒体上传能力，**无需公网回调地址**，适合本地/桌面应用。官方文档：developer.work.weixin.qq.com/document/path/101463
- ZCode 截图中的「扫码快捷绑定」需要厂商云端中转服务接收凭据，本地版无法实现自动回传 → **v1 仅手动配置 Bot ID + Secret**
- 企微限制：**同一 Bot ID 同时只能有一条 WebSocket 连接**，重复连接会互踢（pi-wecombot 文档明确记载）→ 配置层面检测冲突
- 平台行为：群聊中只有 @机器人 的消息会推送给机器人；单聊全量推送。无需自建触发开关
- 参考插件（均为 pi 扩展形态，不直接复用）：`@amaster.ai/pi-channels`（渠道适配契约 + chat bridge 思路）、`pi-wecombot`（多机器人配置分层、Bot ID 冲突限制）、`pi-agent-push`（单向推送，渠道配置数组形态）
- 本仓库现状：无任何 IM/渠道代码；kernel 为 Bun 自研零框架 HTTP + SSE（端口 9776），每会话 spawn `pi --mode rpc` 子进程

## 3. 范围

**v1 做**：仅企业微信渠道（UI 预留微信/飞书/QQ 置灰「敬请期待」）；进站文本 + 图片；出站 markdown 文本（非流式）；多机器人多开；智能体绑定；工作区指令切换；渠道附加提示词；简洁/标准两档回复粒度。

**v1 不做**：扫码快捷绑定、流式输出、语音/文件/视频消息、出站图片/文件、消息白名单、飞书/微信/QQ 实际接入、渠道级固定工作目录绑定。

## 4. 架构（方案 A：kernel 内置渠道服务）

选定 kernel 进程内置 `ChannelManager`，否决 pi 扩展形态（host 架构下每个会话一个 pi 子进程，扩展装在子进程会导致同一 Bot ID 被多条 WS 连接互踢）与独立 sidecar 进程（本地桌面工具过度设计）。

```
企微 WS ⇄ WecomAdapter ⇄ ChannelManager ─→ 会话映射 ─→ AgentManager.prompt()
                              │                            │
                              └──← 按粒度组装回复 ←── agent_end / 会话事件
```

kernel 新增模块（职责单一、可独立测试）：

- `packages/kernel/src/channel-store.ts` — 渠道配置 + IM 会话映射持久化（仿 `settings-store.ts` read-modify-write JSON）
- `packages/kernel/src/channel-manager.ts` — 渠道实例生命周期（启动/停止/重连）、消息编排、每会话 FIFO 队列
- `packages/kernel/src/channels/wecom-adapter.ts` — 企微适配器，唯一依赖 `@wecom/aibot-node-sdk` 处
- `packages/kernel/src/channels/types.ts` — `ChannelAdapter` 接口（`connect/disconnect/sendText/onMessage`），未来飞书/QQ 各实现一个
- `packages/kernel/src/routes/channels.ts` — REST 路由（仿 `routes/settings.ts`），在 `ws-server.ts:457-467` 处统一注册；`ChannelManager` 在 `startKernel()`（`index.ts:60` 附近）启动

## 5. 数据模型

`~/.wa-pi/channels.json`（密钥本地明文存储，API 输出脱敏）：

```jsonc
{
  "schemaVersion": 1,
  "channels": [{
    "id": "ch_8f3a",
    "type": "wecom",                 // 预留 feishu/wechat/qq
    "name": "客服机器人",
    "enabled": true,
    "credentials": { "botId": "...", "secret": "..." },
    "agentName": "研发助手",           // 智能体 displayName；空 = 系统默认
    "extraSystemPrompt": "……",
    "replyGranularity": "standard"    // simple | standard
  }]
}
```

`~/.wa-pi/channel-sessions.json` — IM 会话映射，键 = `channelId + chatId`：

```jsonc
{
  "mappings": [{
    "channelId": "ch_8f3a",
    "chatId": "wr_xxx 或 userid",
    "currentProjectId": "__system__",          // /use 指令修改
    "sessions": { "__system__": "sess_1", "proj_9": "sess_7" },
    "updatedAt": 1786000000
  }]
}
```

## 6. 消息链路

**进站**：

1. 适配器收到消息（群聊仅 @机器人，平台行为；文本需剥离 @前缀）
2. 按 `channelId+chatId` 找/建映射；按 `currentProjectId` 找/建 hiagent 会话（`ProjectStore.createSession`，默认 `__system__` 默认工作区，每会话独立临时目录由现有机制保证）
3. 调用 `AgentManager.prompt(sessionId, text, { model, attachments })`（`agent-manager.ts:1159`；`model` 必填，取渠道关联智能体的 `model` 字段）
4. 会话执行中再来消息 → 进入该会话 FIFO 队列，当前轮结束后依次消费
5. 图片消息：SDK 下载解密 → 存 `~/.wa-pi/tmp/channels/<channelId>/` → 作为 `attachments` 传入
6. 语音/文件/卡片等 → 回复「暂不支持该消息类型」

**出站**：`agent_end` 后按回复粒度组装一次发出（非流式）；超长按企微 markdown 长度上限切分多条。

## 7. IM 指令

消息以 `/` 开头时由 ChannelManager 拦截，不进智能体：

- `/new` — 重置当前对话在当前项目下的会话（新建 session 替换映射）
- `/projects` — 列出可用工作区（已有项目列表）
- `/use <项目名>` — 切换当前对话工作目录（改 `currentProjectId`；该项目已有会话则续用，否则新建）
- `/help` — 指令说明

## 8. 提示词注入

`composePrompt()`（`system-prompt.ts:196`）组装时，若会话来自渠道映射，注入 `channel` 段（内容 = 渠道 `extraSystemPrompt`），**位置固定在 `env-constraints` 之后、`memory-policy` 之前**（现有段序：base → self-protection → delegate-mechanism → delegate-roster → env-constraints → memory-policy → memory-snapshot；记忆快照另经 `--append-system-prompt` 挂在末尾）。该段为运行时注入，不写入 `prompts.json`。

## 9. 回复粒度

- `simple` 简洁：仅助手最终正文
- `standard` 标准：正文 + 文件变更汇总（从本轮工具调用记录提取 write/edit 涉及的文件路径列表，如「📄 修改：auth.ts、client.ts」）

## 10. 智能体被删除的兜底

- 渠道存智能体 `displayName`，ChannelManager **每次收消息时实时解析**（不缓存）
- 解析失败 → 降级为系统默认智能体（seed 保证存在），kernel 日志记 warning，机器人不中断
- 删除智能体时：agents API 返回被渠道引用的计数，前端删除确认弹窗提示「删除后 N 个机器人将改用默认智能体」
- 渠道编辑界面：引用失效时智能体下拉框下方显示警告条「原智能体已删除，当前使用默认智能体」

## 11. 前端 UI

高保真原型（已确认）：`assets/2026-08-06-im-channel-bot/ui-preview-v3.html`（浏览器直接打开即可，企微/飞书官方 logo 在同目录；微信/QQ 品牌 SVG 已内联，实现时存入 frontend 静态资源）。

**设置页新 Section「机器人」**（`SettingsModal.tsx` 左侧 nav 加项，`store/settings.ts` 的 `SettingsSection` 联合加 key；仿 `GeneralSection.tsx` 控件风格）：

- 左：机器人列表（渠道图标 + 名称 + 启用开关 + 连接状态点）+「新建机器人」
- 新建弹层选渠道类型：企业微信可用；微信/飞书/QQ 置灰「敬请期待」
- 右：详情表单 — 名称、Bot ID、Secret（密码框）、关联智能体下拉、额外系统提示词 textarea、回复粒度下拉（简洁/标准）、启用开关、删除机器人、保存
- 保存即时生效（启停对应 WS 连接）；连接状态经 SSE 实时刷新

**侧边栏 IM 页签**（`Sidebar.tsx`）：

- 顶部加「任务 | IM」分段控件：任务 = 现有项目/会话列表（不变）；IM = 全部渠道会话列表（渠道图标 + 对话标识 + 最后消息预览 + 时间）
- 点击 IM 会话 → 打开对应 hiagent 会话视图（复用现有会话组件），可从界面直接追问（等同 IM 侧发消息，走同一 prompt 链路）
- 历史消息**最多加载 100 条**
- 新 IM 消息经 SSE（`GET /api/events`）推送，事件类型加入 `packages/shared/src/types.ts` 的事件联合

## 12. API

- `GET /api/channels` — 列表（secret 脱敏，含实时连接状态）
- `POST /api/channels` — 新建（校验 botId/secret 必填、botId 不重复）
- `PUT /api/channels/:id` — 更新（保存后重启该渠道连接）
- `DELETE /api/channels/:id` — 删除（断开连接，保留历史会话映射）
- `GET /api/channel-conversations` — IM 会话列表（侧边栏 IM 页签数据源）
- 智能体删除接口返回渠道引用计数（见 §10）

## 13. 错误处理

- SDK 指数退避自动重连；连接状态经 SSE 广播
- 同一 Bot ID 出现在两个启用渠道 → 第二个启动失败，设置页显示「Bot ID 冲突」
- 智能体执行出错 → IM 回复「处理出错：<简要原因>」
- kernel 重启 → 自动拉起所有 enabled 渠道；会话映射已持久化，对话可续
- 图片下载/解密失败 → 回复「图片处理失败，请重发或改发文字」

## 14. 测试策略（四层，缺一不可）

1. **单元**（bun:test）：channel-store 读写与迁移、会话映射增删查、指令解析（/new /use /projects /help）、回复粒度组装、channel 提示词段插入位置、智能体删除兜底降级、Bot ID 冲突检测
2. **组件**（Vitest + @testing-library/react + happy-dom）：机器人 Section 渲染/增删改/启停交互、渠道选择弹层置灰态、智能体删除警告条、侧边栏任务/IM 页签切换
3. **API**（curl 集成）：channels CRUD 正常路径 + 错误路径（缺 botId 400、重复 Bot ID 409、删除后被引用智能体的引用计数）
4. **E2E**（Playwright）：设置页创建机器人 → MockAdapter（实现同一 `ChannelAdapter` 接口的内存假渠道）灌入消息 → 侧边栏 IM 页签出现会话 → 界面追问 → 断言 MockAdapter 收到按粒度组装的回复；finally 清理测试数据。真实企微连通用真实测试 Bot ID 人工验证一次。截图测试完成后全部删除

## 15. 风险与限制

- 企微智能机器人能力以官方 SDK 为准（markdown 长度上限、图片格式限制），实现时以联调为准
- 同一 Bot ID 单连接限制无法绕开，靠配置校验 + 明确报错兜底
- 凭证明文落盘（`~/.wa-pi/channels.json`），与现有 settings 同级风险，文档中明示
