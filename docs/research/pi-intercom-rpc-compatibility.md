# pi-intercom + `pi --mode rpc` 无头模式兼容性验证

> 日期：2026-07-06
> 目的：验证 HiAgent 设计文档（`2026-07-05-hiagent-design.md`）第十三节"待确认问题 1"——pi-intercom 在 `pi --mode rpc` 无头模式下能否正常工作。这是 MVP 可行性的最高优先级前置条件。
> 结论：**兼容，可用。无需回退到 SDK 内嵌。**

## 一、验证方法

分两层：

1. **静态分析**：通读 pi-intercom 源码（入口 `index.ts`、broker 子系统、config）+ 交叉核实 Pi rpc 官方文档，定位"一票否决"风险点（TTY 依赖、stdio 冲突、UI 阻塞）。
2. **运行时实测**：真实安装 pi + pi-intercom，写测试脚本端到端验证 broker 路由、ask/reply 阻塞语义、双无头 pi 进程互通。

## 二、环境

| 组件 | 版本 | 安装方式 |
|------|------|---------|
| Pi Coding Agent | 0.80.3 | `npm install -g @earendil-works/pi-coding-agent --ignore-scripts` |
| bun | 1.3.14 | `curl -fsSL https://bun.sh/install \| bash` |
| pi-intercom | **0.6.0** | `pi install npm:pi-intercom` |
| node | v22.21.1 | nvm |
| DeepSeek 模型 | deepseek-v4-flash | API（补测 LLM 链路用） |
| 平台 | macOS darwin 24.6.0 x64 | — |

⚠️ **版本差异提示**：GitHub main 分支的 pi-intercom 源码（静态分析阶段抓取的）与 npm 发布的 v0.6.0 **架构有差异**。main 分支 broker 有 `askEdges` / `getAskTimeoutMs` / `pruneAskEdges` 机制（ask 超时 GC）；v0.6.0 **没有这些**。下文以**实际安装的 v0.6.0 行为为准**。

## 三、静态分析结论（带源码证据）

### 3.1 rpc 模式语义匹配

`pi --mode rpc` 是纯 **JSONL over stdio**（非 JSON-RPC，无信封）：
- **完整加载扩展**：settings.json packages 列表里的扩展在 rpc 模式下完整加载，setup/init/事件钩子（含 `tool_call`、`session_before_*`）全部运行
- **工具暴露给 LLM**：扩展注册的工具参与 LLM 工具调用，经 `tool_execution_start/end` 事件流回报
- **不渲染 TUI**：`ctx.mode === "rpc"`、`ctx.hasUI === true`；TUI-only 方法降级为 no-op
- 来源：[pi.dev/docs/latest/rpc](https://pi.dev/docs/latest/rpc)、[lzw.me 第 26 章](https://lzw.me/docs/pi-book/ch26-rpc.html)

### 3.2 pi-intercom 工具链路不依赖 TUI

入口 `index.ts`（1886 行）审计所有 `ctx.ui.*` 调用点：

| 调用 | 位置 | 守卫 | rpc 下行为 |
|------|------|------|-----------|
| `ui.notify` | L553 | `if (!liveContext?.hasUI) return` (L549) | 跳过 |
| `ui.confirm`（send 确认） | L1526 | `config.confirmSend && ctx.hasUI` (L1524) | 跳过（且可 config 关） |
| `ui.custom`（overlay） | L1844, L1861 | `hasUI && mode === "tui"` (L1811) 双重 | 跳过 |

**intercom 工具 execute 体（L1462-1771）全程无 dialog 调用**，走 `ensureConnected → client.send`。入站消息有显式无头分支：忙且无 UI 时自动回执 "non-interactive mode"（L740-756）。

### 3.3 broker 进程模型与 stdio 零冲突

- broker 是 **detached + unref + `stdio:"ignore"` 的独立 daemon 子进程**（`broker/spawn.ts:168, 203`），用 `node tsx broker.ts` 启动
- **不碰 `process.stdin/stdout/stderr`**：broker 子进程 stdio 全 ignore；client 只用 `net.Socket`。rpc 模式占用 stdio 跑 JSONL **完全安全**
- socket 路径 `~/.pi/agent/intercom/broker.sock`（默认），基于用户 home，**不含 pid/cwd** → 同机同用户多个无头 pi 进程共享同一 broker

## 四、运行时实测结果

### 4.1 测试 1：rpc 握手 ✅

```bash
pi --mode rpc --name verify-test --no-tools --offline
# 发 {"type":"get_state","id":"t1"}
# → {"success":true,"data":{"sessionName":"verify-test","sessionId":"..."}}
```
stdout 返回合法 JSONL，stderr 干净。`--name`/`--no-tools`/`--offline` 等 flag 全部生效。

### 4.2 测试 2：pi-intercom 加载 + broker 自动 spawn ✅

启动带 pi-intercom 的 pi rpc 进程后：
- **stderr 完全干净**，无加载错误
- `~/.pi/agent/intercom/broker.sock` 在 ~4 秒后自动生成（`session_start → ensureConnected → spawnBrokerIfNeeded` 链路在无头模式完整跑通）
- `get_commands` 返回 `intercom` 命令（`source:"extension"`）+ `skill:pi-intercom` 技能

### 4.3 测试 3：ask/reply 端到端（核心）✅

用 pi-intercom client API 模拟两个 agent session：

```
[02:41:54.835] alice 向 bob 发起 ask: "这个 API 该用 GET 还是 POST？"
[02:41:54.837] bob 收到消息 expectsReply=true
[02:41:54.837] alice ask 投递: delivered=true
[02:41:55.638] bob 回复 alice（800ms 思考延迟后）
[02:41:55.639] alice 收到回复: "这是 bob 的回复：方案A 可行"
[02:41:55.640] bob reply 投递: delivered=true

测试结果：
1. ask 被 bob 收到: ✓
2. ask 解除（收到 reply）: ✓
3. reply 内容: 这是 bob 的回复：方案A 可行
4. 总耗时: 812ms（含 800ms bob 延迟）
```

四个核心机制全部验证：双 client 连同一 broker、ask 投递、reply 投递、reply 配对 ask 解除等待。

### 4.4 测试 4：双无头 pi 进程 broker 可见性 ✅

spawn 两个独立 `pi --mode rpc` 进程（alice/bob），用第三方 observer 查 broker：

```
broker 上的 session:
  - name=bob model=unknown pid=18441
  - name=alice model=unknown pid=18440
  - name=observer model=obs pid=18436

alice(pi 进程) 在 broker 可见: ✓
bob(pi 进程) 在 broker 可见: ✓
两个无头 pi 进程 intercom 通道就绪: ✓ 可互相 ask
```

**这是最贴近 HiAgent 真实场景的测试**：编排内核 spawn 多个 pi 进程后，它们的 intercom 通道自动就绪。

## 五、对设计文档假设的修正

### 5.1 ask 超时（重要修正）

| 设计文档假设 | 实际（v0.6.0） |
|---|---|
| "pi-intercom 默认 10 分钟超时，HiAgent 包装 ask 把超时设为 Infinity" | **v0.6.0 的 broker 没有 ask 超时 GC 机制**（无 askEdges/pruneAskEdges）。ask 阻塞完全在客户端（发送方等 message 事件），broker 不参与超时 |

**对 HiAgent 的影响（更好的消息）**：
- ask **天然可以无限等待**，无需"包装设为 Infinity"
- 客户端 send 的 10 秒超时（`client.ts:162`）是**连接建立超时**（broker 握手），不是 ask 等回复超时，不影响 ask 阻塞
- HiAgent 编排内核实现"ask 不设超时"只需：发送方注册 message 事件监听器等 reply，不主动设超时即可

⚠️ 注意：main 分支源码有 ask 超时 GC（`getAskTimeoutMs` 默认 10 分钟），未来 pi-intercom 升级到该版本后，HiAgent 需通过 config 覆盖超时。当前 v0.6.0 无此问题。

### 5.2 其他假设确认

| 假设 | 状态 |
|---|---|
| broker 用 Unix socket（macOS） | ✅ 证实 |
| 同机多 agent 共享 broker 路由 | ✅ 证实 |
| pi `--tools`/`--skill`/`--name`/`--no-extensions` flag 可用 | ✅ 证实（设计文档资源分配模型成立） |

## 六、LLM 自主调用链路（补测，DeepSeek）

用 DeepSeek API key 补测了完整 LLM 链路（之前未覆盖项）。

### 6.1 单进程：工具可见性 ✅

pi + DeepSeek（`deepseek/deepseek-v4-flash`）+ pi-intercom，LLM 明确列出可见工具：
```
1. read — 读取文件内容
2. bash — 执行 bash 命令
3. edit — 编辑文件（精确文本替换）
4. write — 创建或覆写文件
5. intercom — 跨 pi 会话通信与协调
```

### 6.2 双进程：LLM 自主 ask/reply ✅

两个无头 pi 进程（alice-llm / bob-llm），各自 system prompt 指示用 intercom 工具：

```
[05:53:37] alice 发起 ask "1+1 等于几？"（LLM 自主调 intercom 工具）
[05:53:42] alice 完成回复（5s）
```

| 进程 | 工具调用 | 结果 |
|------|---------|------|
| alice | `intercom` (ask) | `**Reply from bob-llm:** 2` (isError:false) |
| bob | `intercom` (reply) | `Reply sent to alice-llm` (delivered:true, replyTo 指向 alice 的 messageId) |

完整链路跑通：**alice LLM → intercom 工具 → broker 路由 → bob 收到 → bob LLM → intercom 工具 → broker 路由 → alice 收到回复 "2"**。双方 stderr 干净。

### 6.3 关键时序发现

broker daemon 在 30 秒空闲后会自动退出。后续无 pi 进程时 socket 消失。测试时 observer（第三方 client）要在 broker socket 出现后（~4s）再连接。这给 HiAgent 编排内核的实现提示：**不要假设 broker 永久存在**，spawn pi 进程时 pi-intercom 会 auto-spawn broker，但独立的 IntercomMonitor 连接要等 socket ready。

## 七、结论

**pi-intercom + `pi --mode rpc` 无头模式完全兼容，HiAgent MVP 可行，无需回退到 SDK 内嵌。**

验证强度（5 个测试，全部通过）：
- 静态分析：源码级证据，所有 UI 调用点都有 hasUI/mode 守卫
- 运行时：rpc 握手、扩展加载+broker spawn、client 层 ask/reply、双进程 broker 互通
- **LLM 链路（DeepSeek）**：LLM 自主调 intercom 工具完成 ask → reply 端到端跑通

设计文档第十三节"待确认问题 1"**已解决**，可进入编排内核实现阶段。

## 八、测试脚本

测试脚本存于 `/tmp/hiagent-verify/`（一次性 POC，未入库）：
- `rpc-handshake.mjs` — rpc 握手
- `intercom-load.mjs` — 扩展加载 + broker spawn
- `ask-reply-e2e.ts` — ask/reply 端到端（bun 跑）
- `two-pi-broker.ts` — 双 pi 进程 broker 可见性（bun 跑）

## 九、参考

- [pi-intercom 仓库](https://github.com/nicobailon/pi-intercom)
- [Pi RPC 模式官方文档](https://pi.dev/docs/latest/rpc)
- [Pi 包安装机制与 agent 级分配](./pi-packages-install-and-agent-allocation.md)
