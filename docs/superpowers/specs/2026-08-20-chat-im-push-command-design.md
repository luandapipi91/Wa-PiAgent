# 设计文档：聊天界面「发送给 IM 联系人」命令

**日期**: 2026-08-20
**状态**: Approved（三部分设计均经用户确认）
**作者**: co

---

## 1. 问题陈述

自动化任务（定时任务）已具备完整的 IM 推送闭环：任务指令可写 `@im-push-to(ch_xxx,ct_xxx)` 标记，kernel 执行时注入 `im_push_to` 工具 + 系统提示词 im-push 段，agent 完成任务后主动推送结果给 IM 联系人。

但**主聊天界面无法使用这一能力**：
- 主聊天输入框刻意不并入 IM 联系人 chip（`prompt-tokens.ts` 注释明确「避免联系人 chip 语义泄漏进主聊天」）
- 普通聊天会话的 pi 进程 spawn 时没有 `WA_PI_IM_PUSH_TARGETS` env → `im_push_to` 工具未注册

**目标**：在主聊天界面提供 `/发送给`（i18n，英文 `/send-to`）命令，选中后弹窗选择 IM 联系人（渠道分组、单选，person/group 均支持），插入「发送给：张三」chip，agent 执行任务过程中自主调用 `im_push_to` 工具实时推送。

**成功标准**：
- 用户能在主聊天用 3 步内完成「指定推送目标 → 下达任务」
- 带标记的会话中 agent 能成功调用 `im_push_to` 推送（复用 `channelManager.pushToContact`）
- 无标记的普通会话不出现 agent 误推送（工具无目标时明确报错）
- 定时任务路径零改动、零回归

---

## 2. 交互流程

```
用户输入 "/" → 命令菜单出现「发送给 IM 联系人」（builtin 命令 cmd:send-im，i18n）
→ 选中 → 弹出「选择 IM 联系人」对话框（渠道分组 → 联系人单选，person/group 均可选）
→ 确认 → 输入框插入 chip「发送给：张三」（存储形态 @im-push-to(ch_xxx,ct_xxx)）
→ 用户继续输入任务指令 → 发送（chip 原样保留，不展开）
→ kernel 检测消息含 @im-push-to 标记 → 会话推送注册表惰性激活 + 消息级引导
→ agent 执行中自主调用 im_push_to → 实时推送到 IM 联系人
```

---

## 3. 前端改动

### 3.1 命令注册（`packages/frontend/src/components/ui/ComposerInput.tsx`）

在 `builtinCommands` 数组中新增一项（与 settings/agents/reload/compact 同级）：

```ts
{
  id: "cmd:send-im",
  name: t("composer.cmdSendIm"),      // 「发送给 IM 联系人」/ "Send to IM contact"
  description: t("composer.cmdSendImDesc"),
  source: { type: "builtin", name: t("composer.sourceCommand") },
  disabled: isRunning || isNewSession,  // 与 reload/compact 一致：运行中/新会话禁用
}
```

`handleSelect` 中 `cmd:send-im` 分支：打开 `ContactPickerDialog`，不回填 `/` 文本。

### 3.2 联系人选择弹窗（新组件 `packages/frontend/src/components/ui/ContactPickerDialog.tsx`）

- 数据源：`useContactsStore`（联系人）+ `useChannelsStore`（渠道），按渠道分组渲染
- 单选；`ContactEntity.kind` 为 person/group 均展示可选
- 确定后通过回调返回 `{ channelId, contactId, label }`
- 空态：无渠道/无联系人时显示引导文案（去 IM 设置页配置），复用现有入口
- UI 复用现有 Dialog 组件样式（参照 `ConfirmDialog`/`ContactsPanel` 的模式）

### 3.3 chip 渲染与 token（`packages/frontend/src/quick-invoke/tokens.ts`）

存储形态 `@im-push-to(ch_xxx,ct_xxx)` 与自动化任务**完全一致**（复用 `automation/prompt-tokens.ts` 的 `imPushToken()` / `parseImPushTokens()`）。

主聊天 `textToHtml` 需支持渲染该 token 为 chip：

- **联系人查询注册表**：参照 `registerAgentMeta` 模式，在 tokens.ts 增加
  `registerContactMeta(channelId, contactId, meta: { label, kind })` 模块级注册表，
  `textToHtml` 渲染 chip 时查表；未注册/已删除 → `chip-im-invalid` 灰化显示 id（复用 automation 模式）
- 调用方注册：聊天输入框/MessageList 挂载时从 contacts store 注册全部联系人
  （或按需：ComposerInput 选完联系人后注册单个）
- chip 显示文案：`发送给：张三`（i18n 前缀 + 联系人 remark/displayName）
- `expandTokens()`：`@im-push-to(...)` **不展开**（与 `@[名称]` 一致，原样保留给 kernel 解析）

### 3.4 i18n（`packages/frontend/src/i18n/locales/zh.ts` / `en.ts`）

| key | zh | en |
|---|---|---|
| `composer.cmdSendIm` | 发送给 IM 联系人 | Send to IM contact |
| `composer.cmdSendImDesc` | 选择 IM 联系人作为任务结果推送目标 | Choose an IM contact to push task results to |
| `sendIm.dialogTitle` | 选择 IM 联系人 | Select IM contact |
| `sendIm.sendTo` | 发送给 | Send to |

---

## 4. kernel 改动

### 4.1 工具始终注册（`packages/kernel/src/wa-pi-bridge.extension.ts`）

去掉 `const IM_PUSH_TARGETS = process.env.WA_PI_IM_PUSH_TARGETS; if (IM_PUSH_TARGETS) { ... }` 条件包裹，改为**始终注册** `im_push_to` 工具：

- description 改为：`推送消息给 IM 联系人。仅当任务指令包含 @im-push-to(渠道,联系人) 标记时使用；无标记会话调用将返回错误。contact 填标记中的 ct_xxx 联系人 id。`
- execute 仍经 `callBridge("im_push_to", ...)` 回 kernel `/bridge/tool` 分发
- 定时任务 env 注入路径（agent-manager.ts L905-908 设置 env）**保留**（无害，兼容）

### 4.2 会话推送注册表（`packages/kernel/src/agent-manager.ts`）

新增模块级（或 agentManager 实例级）`Map<sessionId, ImPushInjection>`：

- **激活**：`_sendPromptNow`（或 prompt 入口）发送前检测 `text` 含 `@im-push-to(...)` 标记：
  - 复用 `tools/robot-push.ts` 的 `parseImPushMentions` / `parseImPushTokens` 解析联系人 id 列表
  - 若该会话尚无条目或目标变化 → 用 `createImPushTool(targets)` 构造并写入注册表
- **执行**：`handleTool` 的 `im_push_to` 分支改为查注册表：
  - 命中 → 校验 contact 合法（ct_ 在 targets 内）→ `imPush.execute(contact, message)` 推送 → 返回文本结果
  - 未命中（普通会话误调）→ 返回 `本会话未配置推送目标` 错误（复用现有 `{ content: [...], details: { error } }` 结构）
- **清理**：会话销毁/切换时删除条目（若现有代码有会话清理钩子则挂接；无则条目轻量可保留，保守处理）

### 4.3 消息级引导（替代系统提示词注入）

检测到标记时，kernel 在发给 pi 的 prompt 文本前附加引导段（复用 `buildImPushSystemPrompt` 文案，位置在消息开头）：

```
任务指令中的 @im-push-to(渠道,联系人) 标记表示推送目标联系人，它们不是智能体引用，
不要对其调用 delegate。请完成任务后用 im_push_to 工具把结果推送给这些联系人。
```

实现位置：`_sendPromptNow` 内、`expandSkillTokens` 之后、`handle.client.prompt()` 之前。带引导的消息**不写入 transcript**（与 slash 命令延迟回显抑制同理）：引导是 kernel 内部注入的系统级上下文，用户消息气泡只显示用户输入的原文（含 chip），不含引导文本。

**不碰**已启动进程的系统提示词文件（`--system-prompt` 启动时定死，热更不可行）。

### 4.4 定时任务零改动

`index.ts executeTask` 的 imPush 注入、env 设置、系统提示词 im-push 段全部保留。bridge 始终注册后，定时任务的 env 判断冗余但不冲突。

---

## 5. 数据模型与复用清单

| 复用点 | 来源 | 说明 |
|---|---|---|
| `imPushToken()` / `parseImPushTokens()` | `frontend/.../automation/prompt-tokens.ts` | token 构造/解析 |
| `chip-im` / `chip-im-invalid` 样式 | 同上（tokens.ts `ensureChipStyles` 需补 `.chip-im` 样式或复用） | 联系人 chip 渲染 |
| `parseImPushMentions` / `createImPushTool` / `buildImPushSystemPrompt` | `kernel/src/tools/robot-push.ts` | 标记解析、工具构造、引导文案 |
| `channelManager.pushToContact` | `kernel/src/channel-manager.ts` | 实际推送 |
| `useContactsStore` / `useChannelsStore` | `frontend/src/store/contacts.ts` / `channels.ts` | 弹窗数据源 |

---

## 6. 边界情况

| 场景 | 处理 |
|---|---|
| 无联系人/无渠道 | 弹窗空态 + 引导去 IM 设置页 |
| 联系人已删除 | chip 灰化显示 id（`chip-im-invalid`），不报错 |
| 消息含多个标记 | 全部注册为目标集合，agent 可推送多人 |
| 无标记会话 agent 误调工具 | 返回明确错误，不崩溃 |
| 跨渠道重名联系人 | 注册表按 `ct_` id 存，推送校验渠道归属 |
| 运行中/新会话 | `cmd:send-im` 禁用（与 reload/compact 一致） |
| 定时任务 | 完全不受影响 |

---

## 7. 测试计划（四层）

1. **单元**（bun:test）
   - tokens.ts：`@im-push-to` 渲染为 chip / 无效联系人灰化 / `expandTokens` 原样保留
   - robot-push.ts：`parseImPushMentions` 多标记解析
   - agent-manager：注册表注册/查询/清理；handleTool 无目标分支返回错误
2. **组件**（Vitest + testing-library）
   - `ContactPickerDialog`：渠道分组渲染、单选、取消、空态
   - `ComposerInput`：选中 `cmd:send-im` → 弹窗 → 插入 chip token
3. **集成**（curl / kernel 测试）
   - 带标记消息 → 注册表激活 → 模拟 `im_push_to` 调用成功路径
   - 无标记会话调用工具 → 明确错误
   - 推送失败（联系人不存在/渠道离线）→ 错误文本返回给 pi
4. **E2E**（Playwright）
   - `/发送给` → 弹窗选联系人 → chip → 发送 → 任务执行 → IM 会话出现推送消息

---

## 8. 不做的事（YAGNI）

- 不做手动直发（选中即推送）——已确认走「agent 自主推送」模型
- 不做多选联系人（弹窗单选）
- 不重构定时任务的注入机制（env + 系统提示词）——保持零改动
- 不引入「推送目标生命周期管理/取消命令」——推送是实时工具动作，无需状态机
- 不合并 automation/prompt-tokens.ts 到聊天 tokens.ts（保留模块边界，仅复用导出函数）
- 不做飞书/钉钉等新渠道（`ChannelAdapter` 已有扩展点，非本次范围）
