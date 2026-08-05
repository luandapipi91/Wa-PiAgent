# notify 居中消息保留 + setStatus/setWidget/setTitle ANSI 颜色透传设计

## 目标

1. 扩展 `ctx.ui.notify` 继续以「聊天会话居中消息」展示，文字颜色解析 ANSI 颜色码。
2. notify 消息**不再自动消退**，永久保留在聊天列表中。
3. `setStatus` / `setWidget` / `setTitle` 的文本不再被 kernel 过滤 ANSI 颜色码，前端解析并以内联颜色渲染。
4. kernel 对齐 pi 官方行为：fire-and-forget 方法（notify/setStatus/setWidget/setTitle/set_editor_text）不再回复 `extension_ui_response`。
5. `examples/ext-ui-bridge-demo` 测试桩补充带 ANSI 颜色的用例，便于人工回归。

## 背景

当前实现中：

- `packages/kernel/src/rpc-client.ts` 的 `handleUiRequest` 对 `notify` / `setStatus` / `setWidget` / `setTitle` 统一调用 `stripAnsi` 剥离 ANSI SGR 颜色码，导致扩展经 `ctx.ui.theme` 着色的文字在 GUI 中失去颜色。
- `packages/frontend/src/store/session.ts` 的 `case "extension_notify"` 把 notify 插入 `messagesBySession` 作为 `customType: "extension_notify"` 的居中消息，20s 后自动移除。
- `packages/frontend/src/components/MessageList.tsx` 中 custom 消息以 `text-tertiary` 固定颜色渲染。
- `SessionView.tsx` 中 `extStatus` / `extWidget` / `extTitle` 以固定颜色渲染。
- pi 官方 RPC 源码（`dist/modes/rpc/rpc-mode.js`）中 `notify` / `setStatus` / `setWidget` / `setTitle` / `setEditorText` 均为 fire-and-forget，不期待 `extension_ui_response`；当前 kernel 对它们也回复 `cancelled: true` 是多余的。

## 方案概述

采用「kernel 透传 ANSI 原文 + 前端解析渲染」路线：

1. kernel 不再调用 `stripAnsi`，把带 ANSI 颜色码的字符串原样转发给前端。
2. notify 继续进入聊天消息列表作为居中消息，但**移除 20s 自动消失逻辑**。
3. 前端新增 `AnsiText` 组件，把 ANSI 颜色码解析为 `<span style={{ color: ... }}>`。
4. `MessageList` 中 `extension_notify` 消息、`SessionView` 中 `extStatus` / `extWidget` / `extTitle` 均改用 `AnsiText` 渲染。
5. kernel 对 fire-and-forget 方法不再回复 `extension_ui_response`（仅 dialog 方法回复）。
6. examples 测试桩补充带 ANSI 颜色的演示文本。

## 详细设计

### 1. Kernel 协议变更（rpc-client.ts）

**notify / setStatus / setWidget / setTitle 分支：**
- `message`、`statusText`、`widgetLines`、`title` 均不再 `stripAnsi`，透传原始字符串。
- `notifyType` 字段继续透传（可选字符串）。

**fire-and-forget 不再回复 `extension_ui_response`：**
- 从 pi 源码确认：`notify` / `setStatus` / `setWidget` / `setTitle` / `setEditorText` 均为 fire-and-forget，pi 不注册 pending 回调。
- 当前 kernel 对它们也回复 `{ cancelled: true }` 是多余的；改为只对 dialog 方法（`select` / `confirm` / `input` / `editor` / `custom`）回复 `extension_ui_response`。
- 具体实现：把回复逻辑从「所有请求统一回复」改为「仅 `UI_DIALOG_METHODS` 中的方法回复」。

**保留 stripAnsi 的场景：**
- `stripAnsi` 函数本身不删除，其他需要剥离 ANSI 的调用处（如有）继续可用。
- 对话类 UI 方法的标题、选项等仍按原逻辑处理（dialog 的 title/message/options 当前已 stripAnsi，如需保留颜色可后续单独评估）。

### 2. notify 展示路径变更（store/session.ts）

- `case "extension_notify"` 继续向 `messagesBySession` 插入 `customType: "extension_notify"` 的居中消息。
- **删除 20s 后自动从消息列表移除的 `setTimeout` 逻辑**；notify 消息永久保留。
- **删除同内容去重逻辑**；多条相同内容的 notify 各自插入聊天列表。

### 3. ANSI 解析组件 AnsiText

**位置：** `packages/frontend/src/components/ui/AnsiText.tsx`

**职责：**
- 输入带 ANSI SGR 转义序列的字符串。
- 输出 React 片段，把颜色变化段包裹为 `<span style={{ color }}>`。

**解析范围：**
- 支持 16 色（`\x1b[31m`、`\x1b[91m` 等 foreground/background）。
- 支持 256 色（`\x1b[38;5;Nm`）。
- 支持 RGB（`\x1b[38;2;R;G;Bm`）。
- 支持 reset（`\x1b[0m` / `\x1b[39m` / `\x1b[49m`）。
- 其他控制序列（光标移动、清屏、样式如加粗/下划线）直接丢弃，不渲染也不报错。

**实现策略：**
- 单文件轻量解析器，不引入第三方 ANSI 库。
- 维护当前 foreground / background 状态机，按 `\x1b[` 切分段落。
- 输出为 `ReactNode[]`，父组件用 `<>{nodes}</>` 渲染。
- 默认无 ANSI 时返回原字符串，避免多余 span。

**使用位置：**
- `MessageList.tsx`：`customType === "extension_notify"` 的 custom 消息内容。
- `SessionView.tsx`：
  - `extStatusEntries` 每条状态文本。
  - `ExtWidget` 的收起摘要（`lines[0]`）与展开正文（`lines.join("\n")`）。
  - `extTitle` 顶部状态条标题（如 App.tsx 直接渲染则同步修改）。

### 4. setStatus / setWidget / setTitle / notify 前端渲染

**MessageList.tsx：**
- `extension_notify` 消息保持现有居中样式（`text-center text-tertiary`）。
- 文字部分 `{m.content}` 改为 `<AnsiText text={m.content} />`。

**SessionView.tsx：**
- `extStatusEntries`：保持底部状态栏布局，每条 status 文本改用 `<AnsiText text={text} />`。
- `ExtWidget`：
  - 收起态摘要行：`lines[0]` 改用 `<AnsiText>`。
  - 展开态正文：`lines.join("\n")` 改用 `<AnsiText>`。
  - 组件边框 accentColor 逻辑不变。

**App.tsx：**
- App.tsx 中 `{extTitle && (<div data-testid="ext-title-bar">…</div>)}` 直接渲染 extTitle，需同步改用 `<AnsiText text={extTitle} />`。

### 5. examples 测试桩颜色用例

**`examples/ext-ui-bridge-demo/index.ts`：**
- `fireAll` 中增加带 ANSI 颜色的文本：
  - notify 消息使用手写 ANSI 码（如 `\x1b[38;5;214m橙色提示\x1b[39m`）。
  - setStatus 文本使用 ANSI 颜色（如 `\x1b[32m运行中\x1b[39m`）。
  - setWidget 每行使用不同 ANSI 颜色（如红/绿/黄/蓝/品红/青/灰）。
  - setTitle 使用 ANSI 颜色（如 `\x1b[38;5;39mUI Demo 标题\x1b[39m`）。
- 手动命令 `notify` / `status` / `widget` / `title` 同步提供彩色示例。
- 新增 `/uidemo color` 子命令，一键触发全部彩色 UI 请求，便于回归。

**`examples/ext-ui-bridge-demo/README.md`：**
- 更新表格，说明 notify 保持聊天居中消息、不再自动消退。
- 增加「颜色演示」章节，列出 `/uidemo color` 及各命令的彩色效果。

### 6. 测试策略

**第一层：单元测试**
- `packages/kernel/tests/rpc-client.test.ts`：
  - 更新 `setStatus/setWidget/setTitle 桥接为 extension_status/widget/title 事件` 测试，断言 ANSI 原文透传（不再剥离）。
  - 更新 notify 测试，断言 `notifyType` 被正确转发。
  - 新增/更新测试：断言 fire-and-forget 方法**不**收到 `extension_ui_response`（dialog 方法仍收到）。
- `packages/frontend/tests/ansi-text.test.ts`（新增）：
  - 覆盖 16 色、256 色、RGB、reset、多段颜色、无 ANSI 原样返回、非法序列容错。

**第二层：组件测试**
- `packages/frontend/tests/session-extension-notify.test.ts`（更新）：
  - 断言 notify 仍写入 `messagesBySession`。
  - 断言不再设置 20s 自动移除。
  - 断言同内容 notify 连续触发时各自插入（不去重）。
- `packages/frontend/tests/session-notify-auto-dismiss.test.ts`（删除或重写）：
  - 20s 自动移除逻辑已删除，该测试文件可删除或改为「notify 永久保留」断言。
- `packages/frontend/tests/MessageList.test.tsx`（更新/新增用例）：
  - 断言 `extension_notify` 消息的 ANSI 颜色被解析为内联样式。
- `packages/frontend/tests/SessionView.test.tsx`（更新/新增用例）：
  - 断言 `extStatus` / `extWidget` / `extTitle` 的 ANSI 颜色被解析为内联 `style.color`。

**第三层：API 集成测试**
- 本特性通过 SSE/sdk:event 传递，无独立 REST 端点，由 E2E 覆盖。

**第四层：E2E（Playwright）**
- 更新 `packages/frontend/e2e/ext-ui-bridge-demo.spec.ts`：
  - 验证 notify 消息出现在聊天列表中且不再自动消失。
  - 执行 `/uidemo color`，截图验证 notify、widget、title、status 的彩色文字。
  - 测试结束后清理截图文件。

## 影响范围

**修改文件：**
- `packages/kernel/src/rpc-client.ts`
- `packages/kernel/tests/rpc-client.test.ts`
- `packages/frontend/src/components/ui/AnsiText.tsx`（新增）
- `packages/frontend/src/components/MessageList.tsx`
- `packages/frontend/src/components/SessionView.tsx`
- `packages/frontend/src/App.tsx`
- `packages/frontend/src/store/session.ts`
- `packages/frontend/tests/ansi-text.test.ts`（新增）
- `packages/frontend/tests/session-extension-notify.test.ts`
- `packages/frontend/tests/session-notify-auto-dismiss.test.ts`（删除或重写）
- `packages/frontend/tests/MessageList.test.tsx`
- `packages/frontend/tests/SessionView.test.tsx`
- `examples/ext-ui-bridge-demo/index.ts`
- `examples/ext-ui-bridge-demo/README.md`

**可能影响：**
- `packages/frontend/e2e/ext-ui-bridge-demo.spec.ts`

## 风险与注意事项

1. **notify 永久保留：** 长时间运行的会话可能积累多条 notify 消息；同内容不去重，多条各自保留。
2. **fire-and-forget 不回复：** 对齐 pi 官方行为，减少无效响应；如果未来 pi 版本改变行为（开始期待响应），需要重新评估。
3. **ANSI 解析覆盖度：** 仅支持颜色 SGR，不支持加粗/下划线/光标控制；`ctx.ui.theme` 常用颜色调用已覆盖。
4. **stripAnsi 移除后的兼容：** 如果其他代码路径依赖 `stripAnsi` 后的纯文本（如日志、搜索索引），需确认不受影响。当前仅 UI 桥接路径使用 `stripAnsi`，风险较低。
5. **dialog 方法 title/message/options 的 ANSI：** 当前 dialog 的 title/message/options 仍 stripAnsi（见 `agent-manager.ts` 的 `_onExtUiRequest`）；如需保留颜色需单独评估，不在本次范围。

## 成功标准

- 触发扩展 `ctx.ui.notify` 后，聊天列表出现居中消息，文字按 ANSI 颜色码显示，且不再自动消失。
- 触发扩展 `ctx.ui.setStatus` / `setWidget` / `setTitle` 后，对应区域文字按 ANSI 颜色码显示彩色文字。
- kernel 对 fire-and-forget 方法不再回复 `extension_ui_response`。
- `examples/ext-ui-bridge-demo` 执行 `/uidemo color` 后，四类 UI 均显示彩色文本。
- 四层测试全部通过。
