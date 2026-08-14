# 企微机器人通讯录 设计规格

日期：2026-08-14
状态：待用户审查

## 1. 背景与目标

企微机器人（智能机器人长连接接入）每天有大量用户/群给它发消息。当前发送者信息（`fromUserId`）已随消息持久化在 `channel-sessions.json` 的 mapping 中，但没有「人/群」维度的通讯录，用户无法直观看到「和谁、哪个群说过话」，也无法给难识别的加密 userid / 群 chatid 起备注名。

本功能新增**通讯录**：自动收录与机器人对话过的人和群，在机器人管理界面查看，并支持重命名（备注名）。

## 2. 已确认的设计决策

| 决策点 | 结论 |
|--------|------|
| 收录范围 | 分「人」「群」两类：单聊记人（userid），群聊记群（chatid，一个群一条） |
| 采集时机 | 只记新对话，不回填历史 |
| 重命名 | 备注名，通讯录 + IM 会话列表都显示 |
| 入口位置 | 每个机器人内嵌通讯录，独立滑出面板（右侧滑出） |
| 重命名交互 | 行内展开（点行展开输入框 + 保存/取消） |

## 3. 数据模型

新增文件 `~/.pi/agent/contacts.json`（`WA_PI_DIR` 下），并在 `packages/shared/src/constants.ts` 新增 `CONTACTS_FILE` 常量。

```ts
// packages/shared/src/types.ts
interface Contact {
  id: string;            // ct_xxx
  channelId: string;     // 所属机器人 ch_xxx
  kind: "person" | "group";
  userId?: string;       // kind=person：企微 userid（单聊的 fromUserId）
  chatId?: string;       // kind=group：群 chatid
  remark?: string;       // 备注名（重命名结果，用户侧稳定标识）
  firstChatAt: number;   // 首次对话时间戳（ms）
  lastChatAt: number;    // 最近对话时间戳（ms）
}

interface ContactsFile {
  schemaVersion: 1;
  contacts: Contact[];
}
```

**去重键**：`person` 按 `channelId + userId`；`group` 按 `channelId + chatId`。

## 4. 存储层

新增 `packages/kernel/src/contact-store.ts`，仿 `channel-store.ts` 的 `readJson/writeJson` + `schemaVersion` 模式：

- `list(channelId)`：返回某机器人的通讯录（按 kind 分组，组内按 `lastChatAt` 倒序）
- `upsert(input)`：按去重键新增或更新（更新 `lastChatAt`；首次设置 `firstChatAt`）
- `rename(id, remark)`：设置备注名，不存在返回 null

文件损坏/读取失败 → 返回空列表 + 记日志，不抛异常阻断主链路。

## 5. 采集逻辑

在 `packages/kernel/src/channel-manager.ts` 的 `handleInbound()` 中，拿到进站消息 `msg` 后**立即采集**（在 `handleInbound` 顶部、`unsupported` 检查与消息类型/指令拦截、mapping 查找之前）：

- `msg.chatType === "single"` → `contactStore.upsert({ channelId: channel.id, kind: "person", userId: msg.fromUserId })`
- `msg.chatType === "group"` → `contactStore.upsert({ channelId: channel.id, kind: "group", chatId: msg.chatId })`

约束：
- 只记新对话，不做历史回填。
- upsert 失败只记日志，**不阻断消息处理**（消息照常流转到智能体）。
- 任何进站消息（含不支持的消息类型）都视为「对话过」并收录其发送者/群。

## 6. API（kernel，仿 `routes/channels.ts`）

- `GET /api/contacts` → `{ contacts: Contact[] }`（平铺全量；可选 `channelId` 查询参数用于按机器人过滤）
- `PUT /api/contacts/:id` → body `{ remark: string }`；成功返回 `{ contacts: Contact[] }` 全量；id 不存在返回 404

> `GET` 与 `PUT` 都返回 `{ contacts }` 全量——rename 返回全量，前端 store 整体替换，避免「子集覆盖全量」的契约陷阱；前端拿到全量后按 `channelId` 客户端过滤/分组。

配套 `ws-server.ts` 增加事件处理 + 广播 `contacts:changed`（仿 `channel-conversations:changed`），前端 SSE 刷新。

## 7. 前端界面

### 7.1 入口与布局（方案 C：独立滑出面板）

`SettingsModal → BotsSection`：选中某个机器人后，配置表单右上角「通讯录」按钮。点击后从右侧滑出一个通讯录面板，与配置表单并列展示（设置弹窗内右侧新增一栏，不离开设置页）：

- 面板标题「通讯录」
- 「人」「群」两个分段（有备注名显示备注名，无则显示 userid / 群 id 前 8 位）
- 每行附「最近对话时间」
- 面板可关闭（点遮罩或关闭按钮）

### 7.2 重命名交互（方案 C：行内展开）

点某一行 → 该行展开出输入框 + 「保存 / 取消」按钮：

- 输入框预填当前备注名（无备注则为空）
- 保存 → 调 `PUT /api/contacts/:id`，成功后收起
- 取消 / 点其他行 → 收起，不保存
- 备注名为空时，通讯录与 IM 会话列表回退显示原始 id

### 7.3 IM 会话列表联动

`ImConversationList.tsx` 的 `titleOf()`：

- 单聊会话（`chatType === "single"`）：优先显示该 `channelId + userId` 的 remark，回退 userid
- 群聊会话（`chatType === "group"`）：优先显示该 `channelId + chatId` 的 remark，回退 `群聊(chatId前8) · 发送者` 原逻辑

前端 store 新增 `store/contacts.ts`（Zustand，仿 `store/channels.ts`）：`loadContacts()`（无参拉全部通讯录）、`renameContact(id, remark)`（rename 后拿到全量并整体替换 store）；监听 `contacts:changed` SSE 刷新。前端拿到全量后按 `channelId` 客户端过滤/分组（人/群）。

## 8. 数据流

```
企微长连接 → wecom-adapter.normalizeInbound (拿到 fromUserId/chatId)
  → channel-manager.handleInbound
      ├─ contactStore.upsert（新增：人/群入通讯录，进站即采集）
      ├─ 新建/更新 ChannelSessionMapping（现有逻辑）
      └─ agentManager.prompt（现有逻辑）
```

用户查看/重命名：

```
BotsSection → store/contacts.loadContacts → GET /api/contacts
            → 行内展开重命名 → store.renameContact → PUT /api/contacts/:id
            → ws-server 广播 contacts:changed → SSE → 前端刷新
```

## 9. 错误处理

| 场景 | 处理 |
|------|------|
| contacts.json 损坏/读取失败 | 空通讯录 + 日志，不阻断 |
| 重命名不存在的 id | 404 |
| 采集 upsert 失败 | 只记日志，消息照常流转 |
| 备注名为空字符串 | 视为「清除备注名」，回退显示原始 id |

## 10. 测试（四层）

| 层 | 覆盖 |
|----|------|
| 单元 | `contact-store`：upsert 去重（person/group 分别）、firstChatAt 不覆盖、rename、文件损坏兜底；`channel-manager` 采集：单聊→人、群聊→群 |
| 组件 | BotsSection 通讯录面板渲染（人/群分段）、行内展开重命名交互（保存/取消） |
| API | `GET /api/contacts` 列表、`PUT` 重命名成功 + 404 |
| E2E | 视 IM 全链路成本，本期不强制 |

## 11. 复用清单

| 复用对象 | 位置 |
|---|---|
| `ChannelSessionMapping.fromUserId`（数据源语义参照） | `channel-store.ts` |
| `readJson/writeJson` 持久化模式 | `channel-store.ts` |
| 会话重命名 API 模式 | `routes/projects-sessions.ts` + `ws-server.ts` |
| REST 路由注册模式 | `routes/channels.ts` |
| SSE 广播/刷新模式 | `App.tsx` + `ws-server.ts` |
| Zustand store 模式 | `store/channels.ts` |
| IM 会话标题显示 | `ImConversationList.tsx` `titleOf()` |

## 12. 注意事项

1. **企微 userid 加密且跨企业不稳定**：备注名（remark）是用户侧唯一稳定标识，userid 只做底层主键。
2. **群聊不细分成成员**：群聊按「群」收录（一个群一条），群内具体发送者不单独入通讯录。
3. **机器人删除**：删除渠道时通讯录条目是否级联清理——本期先保留（条目孤儿化不报错），后续需要再决策。
4. **robot_push 主动推送不产生联系人**：无 fromUserId，不污染通讯录。
