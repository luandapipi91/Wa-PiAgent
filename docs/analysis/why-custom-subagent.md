# 为什么 WaPi 要重新实现子代理功能，而非用 subagent 内置插件？

> 分析日期：2026-07-28

---

## 一、背景：WaPi 经历了两次架构跃迁

要理解"为什么不用内置插件"，必须先理解 WaPi 的整体架构演进路线：

### 1.1 阶段零：Pi SDK 内嵌架构（早期）

WaPi 最初是一个典型的 Pi SDK 应用——kernel 直接 `import` `@earendil-works/pi-coding-agent` 的 API（如 `createAgentSession`），在进程内管理 agent 生命周期。子代理功能依赖两个社区包：

| 包名 | 角色 |
|------|------|
| `@gotgenes/pi-subagents` | 内置 subagent 类型定义（general-purpose / Explore / Plan）+ 子代理生命周期管理（SubagentManager） |
| `pi-open-agents` | 子代理工具注册 + 子进程执行器（runSubagent） |

这个时期的子代理调用链：

```
LLM 调用 subagent 工具
  → pi-subagents AgentTool.execute()
    → pi-subagents SubagentManager.spawnAndWait()
      → pi-open-agents runSubagent()
        → spawn 一个 pi --mode rpc 子进程
```

### 1.2 阶段一：RPC 子进程架构迁移（2026-07-23）

CHANGELOG 记录了一次根本性的架构重构：

> kernel 不再 import `@earendil-works/pi-coding-agent` 的 API，改为每个会话 spawn 一个 `pi --mode rpc` 子进程并以 JSONL 协议驱动。

这标志着 WaPi 从"SDK 嵌入模式"切换到"RPC 外挂模式"——kernel 不再运行在 Pi 进程内部，而是以一个**外部编排器**的身份存在。

### 1.3 阶段二：子代理执行后端切换（更早）

在 RPC 迁移之前，WaPi 已经做了一次子代理后端的切换：

> 子智能体执行后端从 @gotgenes/pi-subagents 切换到 pi-open-agents：获得 per-agent skills/tools 白名单配置能力 + 子智能体执行过程可见性（onProgress 回调）。

---

## 二、核心原因：RPC 架构下内置插件根本用不了

RPC 迁移后，kernel 与 Pi 进程的关系变成这样：

```
┌──────────────────────────────────────┐
│  WaPi Kernel（Node/Bun 进程）      │
│  ┌────────────────────────────────┐  │
│  │ AgentManager                   │  │
│  │  ├─ RpcClient ←──JSONL──→     │  │
│  │  ├─ BridgeExtension（HTTP）    │  │
│  │  ├─ SubagentRunner（spawn）    │  │
│  │  └─ SubagentTelemetry         │  │
│  └────────────────────────────────┘  │
│          │              ▲             │
│     spawn│              │HTTP回调     │
│          ▼              │             │
│  ┌────────────────────────────────┐  │
│  │  Pi RPC 子进程（每个会话一个）  │  │
│  │  ├─ wa-pi-bridge.ts 扩展     │  │
│  │  │   ├─ delegate → HTTP回调    │──┘
│  │  │   └─ fleet    → HTTP回调    │
│  │  └─ （sub agent 工具被显式屏蔽）│  │
│  └────────────────────────────────┘  │
└──────────────────────────────────────┘
```

**关键点：`pi-subagents` 和 `pi-open-agents` 都是 Pi SDK 扩展，它们设计为在 Pi 进程内部运行。** RPC 架构下，kernel 在 Pi 进程**外部**，这些扩展的工具执行逻辑（如 `SubagentManager.spawnAndWait()`）无法被 kernel 拦截和控制。

具体而言：

1. **工具执行位置不匹配**：内置 subagent 工具的 `execute()` 在 Pi 进程内运行，spawn 子进程也由 Pi 进程管理。WaPi 需要工具执行回调到 kernel（通过 HTTP bridge），由 kernel 统一管理 spawn 生命周期。

2. **进度事件无法转发**：内置工具使用 Pi 的 TUI 渲染系统（`Container`、`Text`、`Markdown` 等）展示进度——WaPi 完全不使用 Pi TUI，它有自己的 Web 前端 + SSE 事件管道。需要自己实现 `SubagentProgressEvent` → WS/SSE → 前端的完整链路。

3. **工具名称和语义不同**：内置工具注册为 `subagent`，WaPi 需要的是 `delegate`（单任务）+ `fleet`（并行派发）两个独立工具，且需要接入关系网（askTo）访问控制。

---

## 三、逐项对比：内置插件 vs 自实现

| 维度 | pi-subagents / pi-open-agents | WaPi 自实现 |
|------|------------------------------|---------------|
| **工具名** | `subagent` | `delegate` + `fleet` |
| **执行位置** | Pi 进程内部（SDK 扩展） | Kernel 进程（通过 HTTP bridge 回调） |
| **子进程管理** | SubagentManager（Pi 进程内） | RpcClient（kernel 直接 spawn `pi --mode rpc --no-session`） |
| **进度反馈** | Pi TUI（Container/Text/Markdown） | SSE 事件流 → 前端 React 组件（ProcessCard/DelegateCard） |
| **访问控制** | allowedAgents 列表（被动） | askTo 关系网（主动构建 allowlist） |
| **并发控制** | ConcurrencyLimiter（Pi 内部） | MAX_SUBAGENT_CONCURRENCY=6（kernel 侧） |
| **内置 agent 定义** | 代码硬编码（default-agents.ts） | `~/.wa-pi/agents/*.md`（用户可编辑覆盖） |
| **用户自定义** | 不可覆盖内置类型 | 编辑 .md 文件即可自定义 systemPrompt |
| **模型/思考覆盖** | 不支持 | `~/.wa-pi/subagent-overrides.json` |
| **遥测** | 无 | SubagentTelemetry（token 用量 + 压缩率 + 成本，落 JSONL） |
| **委派引导** | 无 | DelegationHints（whenToDelegate/whenNotTo/benefit，从 .md frontmatter 提取） |
| **并行派发** | 无（需多次调用 subagent） | fleet 工具（并发 ≤6，结果按序聚合） |
| **错误处理** | 抛异常 | 收敛为 `{ text, isError: true }`（绝不 throw，保护 Pi 进程） |
| **工具白名单** | 继承父 agent | 按类型区分（readOnly 类型只有 5 个只读工具） |

---

## 四、为什么不能"桥接"内置插件？

可能会问：既然 kernel 已经通过 bridge 扩展把 `delegate` 工具注册进了 Pi 进程，为什么不把 bridge 的另一端接到 pi-subagents 的 `SubagentManager` 上？

答案：**架构上做得到，但价值为零，还会引入双份复杂度。**

1. **pi-subagents 的 SubagentManager 耦合了 Pi SDK 内部状态**——它需要 `ParentSnapshot`（从 SDK 的 `ExtensionContext` 提取）、`AgentTypeRegistry`（从 Pi 的 agent 目录加载）、`SubagentSession`（Pi SDK 的 Session 封装）。RPC 模式下 kernel 没有这些对象。

2. **即使强行适配**，kernel 仍需自己实现：HTTP bridge 协议、进程崩溃恢复、SSE 事件转发、前端进度渲染、telemetry 收集。这些已经占了自实现 80% 的代码量——pi-subagents 能提供的只有 SubagentManager 的进程管理逻辑（约 300 行），而 WaPi 的 `subagent-runner.ts` 也才约 220 行。

3. **引入依赖反而降低可控性**：pi-subagents 的内部实现变更（如子进程参数调整、事件格式变化）会直接 break WaPi，而 WaPi 无法控制其发版节奏。

---

## 五、自实现带来了哪些独特价值？

### 5.1 委派关系网（askTo）

这是 WaPi 最核心的差异化能力。每个智能体可以配置 `partners.askTo` 声明"我能调起谁"。LLM 调用 `delegate` 时，kernel 在 canInvoke 中校验目标是否在白名单内（内置 subagent 类型始终可用）。

```
Agent A (前端开发者)  askTo → [Agent B (后端架构师), Agent C (代码审查员)]
Agent D (产品经理)    askTo → []  (不委派任何人)
```

内置 subagent 工具的 `allowedAgents` 是全局被动过滤，不支持这种按角色的关系网。

### 5.2 委派引导（DelegationHints）

每个智能体在 `delegationHints` 中声明自己的使用指南，这些提示词被动态注入到 `Available Subagents` 段中：

```yaml
delegationHints:
  whenToDelegate: 复杂的多步骤任务、需要写操作的自包含任务
  whenNotTo: 单点查找或简单单行修改
  benefit: 继承调用者全部工具，在隔离上下文里完成多步任务后返回聚焦结果
```

内置插件完全没有这个机制——它只在工具描述里给一个笼统的 Guideline。

### 5.3 Fleet 并行派发

`fleet` 工具允许 LLM 一次性派发多个并行子代理：

```
fleet([
  { agent: "Explore", task: "搜索认证模块" },
  { agent: "Explore", task: "搜索数据库层" },
  { agent: "前端开发者", task: "检查登录页组件" }
])
```

内置 subagent 工具需要 LLM 发起多次独立调用（每次一个），语义上不如 fleet 清晰，且无法保证并行执行。

### 5.4 遥测闭环

WaPi 的 `SubagentTelemetry` 对每次派发做量化分析：

- **压缩率**：子代理 output tokens / 返回值估计 tokens（越低蒸馏越狠）
- **节省估算**：如果不派发，这些中间工具调用会消耗多少父上下文 token
- **成功率**：派发中真正产出有用结果的比例

这些数据写入 `~/.wa-pi/subagent-telemetry.jsonl`，可以用于后续优化委派策略。内置插件完全没有这个维度。

### 5.5 用户可自定义内置 Agent

用户可以编辑 `~/.wa-pi/agents/Explore.md` 来修改 Explore 子代理的系统提示词，下次派发自动生效。内置插件的 agent 定义是代码硬编码的，修改需要 fork 包。

---

## 六、代码量对比

| 模块 | WaPi 自实现 | 对应内置插件 |
|------|---------------|-------------|
| 子代理进程执行 | `subagent-runner.ts` (~220行) | pi-open-agents `executor.ts` (~300行) |
| 委派工具 + Fleet | `delegate-tool.ts` (~350行) | pi-subagents `agent-tool.ts` (~250行) |
| 内置 Agent 定义 | `builtin-agents.ts` (~120行) | pi-subagents `default-agents.ts` |
| Agent 信息管理 | `subagent-info.ts` (~110行) | pi-open-agents `loader.ts` |
| 遥测 | `subagent-telemetry.ts` (~130行) | 无 |
| Bridge 扩展生成 | `bridge-extension.ts` (~300行) | 无（RPC 架构特有） |
| **小计（核心）** | **~930行** | **~550行** |

多出的约 380 行主要分布在 bridge 扩展和遥测上，这两块是 RPC 架构的固有开销和 WaPi 的独特价值，不构成冗余。

---

## 七、结论

**WaPi 重新实现子代理功能不是"重复造轮子"，而是 RPC 架构迁移后的必然选择，同时收获了远超内置插件的差异化能力。**

核心逻辑链：

```
RPC 架构迁移（kernel 脱离 Pi 进程）
  → 内置 subagent 工具无法被 kernel 拦截和控制
    → 必须通过 HTTP bridge 模式自建 delegate/fleet 工具
      → 顺便获得：关系网访问控制、委派引导、fleet 并行、遥测闭环、用户自定义 Agent 定义
```

如果 WaPi 还在 Pi SDK 嵌入架构下，继续使用 pi-subagents + pi-open-agents 是合理的。但一旦决定了 RPC 外挂架构（这个决定本身又是为了获得——自定义提示词组装、工具白名单控制、进程崩溃恢复、前端 UI 深度集成等能力），自实现子代理就成为唯一可行的路径。

内置插件是一个"在 Pi 进程内部工作的子代理系统"，而 WaPi 需要一个"在 Pi 进程外部编排的子代理系统"——两者虽然功能相似，但运行环境和控制模型完全不同。
