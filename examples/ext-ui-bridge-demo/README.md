# ext-ui-bridge-demo（UI 桥接测试桩）

覆盖 WaPi 支持的全部四类扩展 fire-and-forget UI 请求 + 对话子协议（dialog / set_editor_text），用于人工演示/回归验证：

| 扩展调用 | kernel 桥接事件 | 前端表现 |
| --- | --- | --- |
| `ctx.ui.notify(msg, type)` | `extension_notify` | 聊天居中消息（永久保留，ANSI 颜色解析） |
| `ctx.ui.setStatus(key, text)` | `extension_status` | 聊天列底部状态栏（右对齐） |
| `ctx.ui.setWidget(key, lines, { placement })` | `extension_widget` | Composer 上/下方**可折叠**文本块（默认收起一行摘要） |
| `ctx.ui.setTitle(title)` | `extension_title` | 聊天窗顶部状态条 |
| `ctx.ui.select/confirm/input/editor(...)` | `extension_dialog`（应答 `/api/extensions/dialog/respond`） | ExtensionDialog 弹窗，应答后 notify 回显结果 |
| `ctx.ui.setEditorText(text)` | `extension_editor_text` | 文本注入 Composer 输入框 |

## 安装（本地扩展）

扩展管理页 → 安装扩展 → 输入本目录绝对路径：

```
/path/to/HiAgent/examples/ext-ui-bridge-demo
```

或走 API：

```bash
curl -X POST http://127.0.0.1:9776/api/extensions/install \
  -H 'Content-Type: application/json' \
  -d '{"name": "/path/to/HiAgent/examples/ext-ui-bridge-demo"}'
```

## 演示

1. 安装后**新开一个会话**（触发 `session_start`，自动 `fireAll`）：
   - 出现 toast（notify）
   - 聊天列底部状态栏出现 `ui-demo 状态条 · 运行中`（setStatus）
   - Composer 上方出现 `ui-demo-above` 折叠摘要行、下方出现 `ui-demo-below`（setWidget）
   - 聊天窗顶部出现「UI Demo 标题」状态条（setTitle）
2. 点击 widget 摘要行 → 展开多行内容；再次点击 → 收起为一行。
3. 手动触发（先在扩展管理页开启 `uidemo` 命令开关）：

```
/uidemo notify    # 手动 toast（warning）
/uidemo status    # 更新底部状态栏（带当前时间）
/uidemo widget    # 更新 aboveEditor widget
/uidemo title     # 更新顶部状态条
/uidemo color     # 一键触发全部彩色 UI（notify + status + widget + title）
/uidemo clear     # 清除 status/widget
/uidemo all       # 全部重新触发
/uidemo select    # 弹选择框（甲/乙/丙），应答后 notify 回显
/uidemo confirm   # 弹确认框，应答后 notify 回显
/uidemo input     # 弹输入框，应答后 notify 回显
/uidemo editor    # 弹多行编辑器，应答后 notify 回显
/uidemo seteditor # 把固定文本注入 Composer
```

## 颜色演示

扩展文本中的 ANSI SGR 颜色码会原样透传到前端，由 AnsiText 组件解析为彩色文字。

```bash
/uidemo color    # 一键触发全部彩色 UI（notify + status + widget + title）
```

## 卸载

扩展管理页卸载即可（local 来源不会删本目录文件）。
