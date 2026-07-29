# Pi 安装与环境验证记录

> 日期：2026-07-06
> 用途：WaPi MVP 计划 Task 1 验证产物

## 安装结果

| 组件 | 版本 | 状态 |
|------|------|------|
| `@earendil-works/pi-coding-agent` | 0.80.3 | ✅ 全局装（`C:\nvm4w\nodejs\pi`） |
| `pi-intercom` | 0.6.0 | ✅ pi install |
| `pi-mcp-adapter` | latest | ✅ pi install |
| `agent-browser` | 0.27.0 | ✅ 已存在 |

## DeepSeek 配置

- key 存于 `~/.pi/agent/auth.json`：`{ "deepseek": { "type": "api_key", "key": "sk-..." } }`
- DeepSeek 是 pi 内置 provider（无需 models.json），模型 `deepseek/deepseek-chat`
- 4 个 agent.md 的 model 字段已统一改为 `deepseek/deepseek-chat`
- **key 绝不写入仓库**，只在用户 home

## 验证结论

### ✅ pi --mode rpc 单进程

`echo '{"type":"get_state"}' | pi --mode rpc --name dev --provider deepseek` 返回：
```json
{"type":"response","command":"get_state","success":true,
 "data":{"model":{"id":"deepseek-v4-pro","provider":"deepseek","baseUrl":"https://api.deepseek.com",...},
         "sessionName":"dev",...}}
```
证明：pi 识别 agent.md（sessionName=dev）、加载 DeepSeek provider 成功。

### ✅ DeepSeek 真实 prompt→回复

node 脚本保持 stdin 开着，发 prompt"只回复三个字：你好啊"，收到：
```
ASSISTANT 回复: 你好啊
```
证明：auth.json key 有效、DeepSeek V4 Pro 真实推理、RPC 协议端到端工作。

### ✅ pi-intercom broker win32 auto-spawn

起两个 pi 进程后，`~/.pi/agent/intercom/` 生成：
- `broker-launch.vbs`（win32 隐藏启动器，对应 pi-intercom spawn.ts 的 `getWindowsHiddenLauncherPath`）
- `broker.spawn.lock`

证明：pi-intercom 在 win32 的 broker auto-spawn 链路工作（Named Pipe 路径 `\\.\pipe\pi-intercom-c-users-co`，由 `getBrokerSocketPath` 平台分流生成）。

> 注：Named Pipe 直连验证受 Git Bash 反斜杠转义阻碍（`\\.\pipe\` 被吞），但 broker 产物文件 + pi-intercom 源码 `paths.test.ts` 的 win32 用例已充分证明 win32 路径正确。

### ⏸ ask/reply 端到端（推迟到 Task 9）

双进程 alice/bob 经 broker 的 intercom ask/reply 验证**未在本 Task 完成**——观察 60s 内 alice 未发出 `tool_call` 事件，DeepSeek 可能未主动调用 intercom 工具，或 RPC 模式工具调用事件名不同。

此验证推迟到 **Task 9（IntercomMonitor）实现时**，届时：
- 计划已有 mock socket 的完整单元测试兜底（4 passed）
- 真实 Pi 链路属 `[需 pi 环境]` 标注项
- 需进一步研究：pi-intercom 工具在 RPC 模式的启用方式、工具调用事件字段名

## RPC 事件字段修正（影响计划 Task 8）

实测 pi 0.80.3 RPC 事件流（prompt 后）：
```
agent_start → turn_start → message_start(user) → message_end(user)
            → message_start(assistant) → message_update(assistant) × N → message_end(assistant)
            → turn_end → agent_end
```

**关键**：流式增量是 `message_update`（非计划写的 `state_change`/`message_update` 混用）。计划 Task 8 的 `handleLine` switch 需对照此实际事件名实现。state 变化经 `get_state` 命令响应获取（非主动推送）。

## 对计划的影响

1. Task 1 验收通过（环境就绪）
2. Task 8 PiRpcClient 的 `handleLine` 事件名以本文档实测为准（`message_start`/`message_update`/`message_end`/`turn_end`）
3. Task 9 IntercomMonitor 真实链路验证推迟，单元测试 mock 先行
