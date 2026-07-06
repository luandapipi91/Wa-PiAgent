# Task 33 集成前必做（来自 Task 8/9 review 接力债）

来自 Task 8（PiRpcClient）：
1. 抓真实 pi RPC 事件样本，对照 handleLine 的 message_update/state_change 字段名（Task 1 验证文档已部分记录）
2. 核实 pi CLI 参数：--mode rpc --name --cwd 是否正确（跑 `pi --help` 对照）
3. 修 defaultSpawn 的 killed 属性：用 `get killed() { return proc.killed }` 替代永 false
4. 补子进程 exit/error 兜底处理
5. 定 message 流式合并策略（message_update 多条如何合并成一条 ChatMessage）

来自 Task 9（IntercomMonitor）：
6. 联调 broker ask/reply 真实消息字段名（kind/messageId/sessionId/from/to）
7. 验证 injectReply 的 {kind:"inject-reply"} 发送格式对齐 pi-intercom client API
8. connectReal 真实 broker 连接 + error/重连覆盖

来自 Task 12（WS Server）：
9. 真实 spawn（Bun.spawn(["pi",...])）端到端验证
10. Pi stdout 行解析对照真实事件字段
11. agent:message/agent:state 端到端
12. IntercomMonitor.connectReal 含 import("pi-intercom/broker/paths") 的 typecheck 预存错误
13. ws-server.ts 死导入 AgentName/makeAgentStateKey 清理（minor）
