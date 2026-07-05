# HiAgent 设计文档

> 基于 Pi Coding Agent 的本地多 agent 编排管理系统
>
> 日期：2026-07-05
> 状态：设计中

## 一、项目概述

### 1.1 目标

构建一个本地桌面客户端，让用户以**对等角色协作**的方式运行多个 AI agent。核心场景：产品、PM、研发、测试四个 agent 在同一项目里动态相互委派任务 —— 产品做需求时遇到技术问题 ask 研发，研发调研回复后产品继续；产品完成需求后委派给 PM 安排实现。

### 1.2 核心特征

- **本地客户端运行**：Tauri 原生窗口，双击启动，无需服务器部署
- **底层 Bun**：编排内核是 Bun sidecar 进程；Pi 本身就是 Bun 二进制，全栈单运行时
- **基于 Pi Coding Agent**：每个 agent 是一个独立 Pi 进程，通过 `pi --mode rpc` 协议控制
- **动态双向委派**：agent 间用 pi-intercom 的 ask/send/reply 对等通信，不是预定义 DAG

### 1.3 用户价值

Pi 生态已有成熟编排后端（pi-subagents / pi-dynamic-workflows / pi-task / pi-crew）和通信（pi-intercom），但缺少：
1. 统一的 GUI 来管理多个 agent 会话
2. 可视化的协作关系与实时状态
3. 细粒度的资源（工具/技能）分配 —— Pi 的 `pi` 字段是全有或全无

HiAgent 填补这个空白：**做一个编排管理层 + GUI，复用已存在的编排后端，不重造引擎**。

### 1.4 非目标

明确不做的事，避免范围蔓延：

- **不做新编排引擎**：不自研 DAG 调度器、不自研 workflow 执行器。编排后端复用 pi-intercom（动态委派）和可选的 pi-subagents（子任务隔离）。
- **不做云服务**：纯本地，不涉及账号、同步、远程访问。手机远程监控（pi-task 的 Web Push）不在 MVP 范围。
- **不做 IDE 集成**：不是 VSCode 插件，不替代编辑器。是独立的桌面应用。
- **不做模型服务**：不内置模型代理，直接用 Pi 的 ModelRegistry 接入用户的 API key。

## 二、技术调研结论

详细调研记录（Pi SDK / 扩展体系 / pi-intercom / pi-subagents / pi-dynamic-workflows / pi-task / pi-crew / pi-mcp-adapter / pi-package-webui / glimpseui / gentle-pi / bigpowers / Bun 桌面框架）在本次会话的子 agent 报告中，待整理到 `docs/research/`。关键结论：

| 维度 | 结论 |
|------|------|
| Pi SDK | `createAgentSession` 可编程嵌入，但 GUI 控制用 `pi --mode rpc` JSON-RPC 更合适 |
| Pi 运行时 | Pi 原生发行包内含 Bun 二进制，全栈 Bun 是自然组合 |
| 编排后端 | pi-intercom（对等通信，ask 阻塞语义）匹配动态委派场景 |
| MCP 桥接 | pi-mcp-adapter 已把 MCP 工具转成 Pi 工具，无需自研 |
| 桌面框架 | Tauri + Bun sidecar 最优；pi-package-webui 已验证 `pi --mode rpc` 驱动 GUI |

## 三、系统架构

### 3.1 分层架构

```
┌─────────────────────────────────────────────────┐
│ ① Tauri 原生窗口（Rust 壳 + WebView2/WKWebView）  │
│   前端：React + Zustand + React Flow             │
│   Rust 后端：窗口管理 + Bun sidecar 生命周期     │
└────────────────────┬────────────────────────────┘
                     │ WebSocket (localhost:9776)
┌────────────────────┴────────────────────────────┐
│ ② Bun 编排内核（sidecar 进程）                    │
│   AgentManager / PiRpcClient / IntercomMonitor   │
│   StateAggregator / ConfigStore / PackageManager │
└────────────────────┬────────────────────────────┘
                     │ spawn + stdio JSONL
┌────────────────────┴────────────────────────────┐
│ ③ Pi Agent 集群（N 个独立 Bun 子进程）            │
│   每个：pi --mode rpc + pi-intercom 扩展         │
└────────────────────┬────────────────────────────┘
                     │ pi-intercom broker (IPC)
┌────────────────────┴────────────────────────────┐
│ ④ 持久化（~/.pi/ + 项目 .pi/ + hiagent-config）   │
└─────────────────────────────────────────────────┘
```

### 3.2 关键技术决策

#### 决策 1：Bun sidecar 而非 Tauri 内嵌

编排内核作为独立 Bun 进程运行，Tauri 只负责窗口壳子 + 启停 Bun。

**理由**：
- 避免 Rust ↔ Bun 的 IPC 复杂性
- Bun 进程崩溃不影响窗口；用户不丢失正在查看的状态
- Bun 原生 WebSocket（`Bun.serve({ websocket })`）比 Node SSE 更简洁

#### 决策 2：pi --mode rpc 而非 SDK 内嵌

每个 agent 是独立 `pi --mode rpc` 子进程，宿主通过 stdio 的 JSONL JSON-RPC 双向通信。

**理由**：
- 进程级隔离：单个 agent 崩溃不影响其他
- 与 Pi 官方多 agent 模式（pi-subagents）一致
- pi-package-webui 已验证此协议完整可控（prompt/abort/model/bash/compact/session 等 RPC 命令）

**RPC 命令清单**（客户端 API surface 基线）：
```
prompt / steer / follow_up / abort / bash / new_session /
set_model / set_thinking_level / compact / cycle_model /
get_state / get_messages / get_available_models / get_session_stats
```

#### 决策 3：pi-intercom 作编排总线

4 个 agent 对等通信，用 pi-intercom 的三个原语：
- **`ask`**：阻塞委派（"产品问研发，等调研回来"）—— 发送并 await 回复
- **`send`**：异步通知（"PM 委派研发"）—— fire-and-forget
- **`reply`**：回复（自动指向最近的 ask）

**理由**：动态双向委派需要的是对等运行时通信，不是预定义 DAG。pi-intercom 的 `ask` 阻塞语义精确匹配场景。

## 四、核心机制设计

### 4.1 ask 不设超时

**用户决策**：产品可以无限等研发。这是特性，不是 bug。

**技术真相**：
- ask 是一次 tool call，等待期间 LLM 不调用，**消耗 0 token / 0 费用**
- 只是 tool 在 await，上下文冻结在内存
- pi-intercom 默认 10 分钟超时（防呆），HiAgent 编排内核包装 ask 把超时设为 `Infinity`

**结束 ask 的合法路径**：
1. 研发通过 intercom reply 回复（正常流程）
2. 用户手动替答（编排内核合成一个 reply）
3. 用户手动取消这次 ask
4. 产品或研发进程被关闭

### 4.2 FIFO 串行队列

**用户决策**：研发被多人 ask 时，按到达顺序处理，一次一个。maxConcurrency=1。

**实现**：
- IntercomMonitor 跟踪每个 agent 的 pending ask 队列
- 画布/sidebar 显示队列状态（`#1 产品(处理中)` `#2 PM(已等 1m12s)`）
- 不暴露 maxConcurrency 配置项（固定 =1）

### 4.3 用户可介入（可选）

无超时意味着用户必须有手段结束/加速，但这是**可选干预**，永远挂在那等也是合法状态。

阻塞中的 ask 显示三个按钮：
- **🙋 我来回答**：用户直接替被问 agent 输入 → 编排内核转成 intercom reply
- **⚡ 催一下**：弹输入框 → 用户打字 → 作为高优先级 steer 插给被问 agent（不打断当前 turn，下一个 turn 优先看）
- **✕ 取消**：取消这次 ask，让发起方继续

## 五、数据模型

### 5.1 Agent 定义（Markdown + frontmatter）

每个 agent = 一个 `.md` 文件，存于 `~/.pi/agent/agents/<name>.md`：

```yaml
---
name: dev
displayName: 研发
avatar: ⚙️                          # emoji 或图片路径
avatarColor: "#fab387-#f38ba8"      # 渐变色
description: 后端研发，负责技术调研、架构设计、代码实现
model: anthropic/claude-sonnet-4
thinking: high
systemPromptMode: replace           # replace | append
inheritProjectContext: true
inheritSkills: false
tools: read, bash, edit, write, grep, find, ls, web_search, fetch_url
skills: architecture-review, debug-methodically, write-tests-first
# HiAgent 扩展字段
mcpServers: []                      # 启用的 MCP server 名单
partners:                           # 委派关系（= 画布连线）
  askTo: [product, test]
  askFrom: [product, pm, test]
---
你是一名资深后端工程师，专注于技术调研和高质量代码实现...
```

**字段说明**：
- 标准 Pi 字段（name/description/model/thinking/tools/skills 等）由 Pi 原生处理
- HiAgent 扩展字段（displayName/avatar/mcpServers/partners）由编排内核解析

### 5.2 资源三层模型（agent 级分配）

**关键差异**：Pi 原生的资源过滤是"包级"的（settings.json 里控制某包加载哪些资源，加载后对所有 agent 共享）。HiAgent 把分配粒度下沉到"agent 级" —— 每个 agent 独立配置自己的工具/技能/MCP。技术细节见 `docs/research/pi-packages-install-and-agent-allocation.md`。

```
插件市场（资源池）
├── 🔒 内置核心（不可删除）
│   ├── pi-intercom        ← 通信桥
│   └── pi-mcp-adapter     ← MCP 桥接器（不可取消）
└── 📦 已安装（可删除）
    ├── pi-web-access      ← 提供工具：web_search, fetch_url, pdf_extract
    ├── bigpowers          ← 提供 73 个技能
    └── superpowers-zh     ← 提供 12 个技能

        ↓ 装了之后，去 Agent 配置分配

Agent 配置（分配入口）— 每个 agent 独立
└── 能力 tab
    ├── 📁 内置工具       (read/bash/edit...)     ← 可勾选
    ├── 🌐 插件工具       (web_search/fetch_url)  ← 可勾选（产品✓ 研发✓ PM✗ 测试✗）
    └── 🔌 MCP 工具       (chrome-devtools/figma) ← 可勾选（按 MCP server 分组）
```

**为什么可行**：Pi 的 `--tools` flag 是 allowlist 语义。包加载的资源进入"进程可见集"，`--tools` 进一步过滤成"agent 实际能调用的"。HiAgent 不改 Pi 加载逻辑，只在 spawn 时按 agent 配置合成 `--tools` / `--skill` 参数。

### 5.3 核心基础设施不显示

pi-intercom 和 pi-mcp-adapter 是后台桥接器：
- 它们提供的能力（intercom/contact_supervisor 工具）始终启用
- 在 Agent 配置的"能力" tab 里**不显示**这个分组（用户改不了）
- 只在插件市场显示为 🔒 内置核心

## 六、UI 设计

### 6.1 主交互范式：对话优先

**不是画布优先**。日常使用是对话视图，画布是辅助视图。

**流程**：
1. **启动页**：居中布局，4 个角色卡片（产品/PM/研发/测试）可视化选择，选中后输入框显示该角色图标，直接打字发送即进入会话
2. **会话中（Codex 式左右结构）**：
   - **左 sidebar**：角色列表（当前高亮）+ 会话历史 + 底部 intercom 状态条
   - **右对话区**：顶部会话标题 + 消息流 + 底部输入框
   - **委派内联显示**：产品 ask 研发作为对话流里的一条特殊消息，带干预按钮
3. **编排画布（可选视图）**：对话区右上角"编排画布"按钮切换

### 6.2 视图清单

| 视图 | 触发方式 | 用途 |
|------|---------|------|
| 启动页 | 应用启动 / 新会话 | 选角色 + 开始 |
| 会话视图（左右） | 发送第一条消息 | 日常对话主界面 |
| 编排画布 | 对话区右上角按钮 | 全局协作关系可视化 |
| Intercom 时间线 | 底部状态条点击 | 完整 agent 间通信历史 |
| Agent 配置 | sidebar 角色右键 / 编辑 | 提示词/能力/技能/合作伙伴 |
| 插件市场 | 顶栏"插件"按钮 | 装/卸包 |

### 6.3 编排画布（辅助视图）

画布是"约束+监控"，不是"程序执行"：
- **节点**：4 个 agent，圆形，显示头像/名称/状态/thinking token
- **连线**：灰色虚线 = 可通信关系（来自 agent 的 partners 字段）
- **活跃 ask**：橙色动画虚线 + 气泡显示 ask 内容 + 已等待时长
- **状态颜色**：蓝边框=thinking / 橙边框=阻塞等待 / 灰边框=idle

**关键**：在画布上拖线 = 在 Agent 配置的"合作伙伴"里加 agent 名；在配置里勾选 = 画布上出现线。两个视图，一份数据。

### 6.4 Intercom 时间线

三色编码：
- 🟠 橙 = ask（阻塞等待中，带计时）
- 🔵 蓝 = send（异步通知）
- 🟢 绿 = reply（回复，缩进嵌套在对应 ask 下）

按时间分组（刚刚/10分钟前/1小时前），点击消息展开右侧详情：方向图示、内容、元信息（已等待/超时/队列位置）、触发上下文、三个干预动作。

## 七、组件职责

### 7.1 Bun 编排内核（端口 9776）

| 组件 | 职责 |
|------|------|
| **AgentManager** | 管理 N 个 Pi 进程生命周期（spawn/kill/restart） |
| **PiRpcClient** | spawn `pi --mode rpc`，JSONL 双向通信，pending request Map |
| **IntercomMonitor** | 监听 broker，跟踪每个 agent 的 ask 队列与状态 |
| **StateAggregator** | 快照+增量模式（借鉴 pi-task），推送前端 |
| **ConfigStore** | 读写 agent 定义、技能/工具分配、合作伙伴关系 |
| **PackageManager** | 调用 `pi install npm:xxx` / `pi remove`，同步 settings.json |

### 7.2 前端（React + Tauri WebView）

| 模块 | 职责 |
|------|------|
| 启动页 | 角色选择 + 输入框 |
| 会话视图 | Codex 式左右布局，消息流，委派内联显示 |
| 编排画布 | React Flow，agent 节点 + 连线，实时状态 |
| 时间线 | intercom 消息列表 + 详情面板 |
| Agent 配置 | 表单 ↔ Markdown 双向同步，能力/技能/合作伙伴 tab |
| 插件市场 | 包列表 + 装/卸 |

### 7.3 Tauri Rust 壳

- 窗口管理（标题栏、系统托盘、尺寸记忆）
- Bun sidecar 进程管控（启动、健康检查、关闭时优雅退出）
- 前端 ↔ Bun 的 IPC 桥（如果不用 WebSocket 直连）
- **WebviewWindow 管理**（产物预览的独立窗口）

### 7.4 产物预览（Artifact Preview）

agent 生成的 HTML/web 产物，在对话区点击 → 内嵌浏览器打开查看。

**注意区分**：这不是 `pi-agent-browser-native`（那个是给 agent 用的浏览器，输出截图/快照给 agent 看）。产物预览是给**用户**用的内嵌浏览器，方向相反。

#### 实现方案：A + C 混合

| 方案 | 用途 | 实现 |
|------|------|------|
| **A. Bun 静态服务器**（日常预览） | 对话区分屏预览 | Bun 内核起静态文件服务器（端口 9777），serve 项目目录。点击预览 → 右侧 iframe 加载 `http://localhost:9777/prototypes/login.html` |
| **C. 独立窗口**（大屏预览） | 全屏查看 | 点击 ⤢ 按钮 → Tauri `new WebviewWindow()` 弹独立原生窗口 |

**为什么用 Bun 静态服务器而非 file://**：
- 支持 localhost 场景（用户的 dev server 预览，如 `localhost:3000`）
- 支持 SPA 路由、API 请求
- 避免 file:// 的 CORS 限制

#### 产物卡片（对话流内）

agent 生成文件后，对话流里出现可点击的产物卡片：
- 图标 + 文件名 + 类型 + 大小 + 生成时间
- 缩略图预览（HTML 渲染缩略图）
- "▶ 预览" 按钮 + "在新窗口打开" + "查看代码"

#### 产物类型识别

| 类型 | 处理方式 |
|------|---------|
| `.html` `.htm` `.svg` | 内嵌浏览器直接渲染 |
| `.png` `.jpg` `.gif` `.webp` | 图片查看 |
| `.pdf` | PDF viewer |
| `.md` | Bun 转 HTML 再 serve |
| dev server URL（`localhost:3000`） | iframe 加载 |
| `.ts` `.js` `.py` `.json` `.css` 等 | Monaco 编辑器查看代码 |

#### 数据流

```
agent 用 write 工具生成 login.html
  → Pi tool_result 事件含文件路径
  → 前端识别可预览类型 → 渲染产物卡片
  → 用户点击"预览"
  → 前端通知 Bun: {type:"preview", path:"/project/prototypes/login.html"}
  → Bun 静态服务器已 serve /project → 返回 URL
  → 前端右侧分屏 iframe 加载 localhost:9777/prototypes/login.html
  → （可选）点 ⤢ → Tauri new WebviewWindow 全屏
```

## 八、数据流

### 8.1 启动到对话

```
用户双击 HiAgent
  → Tauri 启动 → spawn Bun sidecar（端口 9776）
  → Bun 读 ~/.pi/agent/agents/*.md → 返回角色列表
  → 前端显示启动页（4 个角色卡片）
  → 用户选"产品"+ 输入"设计实时通知功能" + 发送
  → 前端 WS 发 {type:"prompt", role:"product", text:"..."}
  → Bun AgentManager spawn pi --mode rpc（产品 agent）
  → PiRpcClient 发 {type:"prompt", message:"..."}
  → Pi 流式回传 message_update 事件
  → StateAggregator 推给前端 → 对话区流式渲染
```

### 8.2 委派（ask）

```
产品 LLM 决定调用 intercom ask
  → Pi tool_call 事件 → PiRpcClient 转发
  → IntercomMonitor 识别 ask → 记入研发队列（#1）
  → StateAggregator 推 {type:"ask", from:"product", to:"dev", ...}
  → 前端产品会话显示橙色 ask 消息 + 干预按钮
  → （同时）研发 Pi 收到 intercom 消息 → 进入 thinking
  → 研发回复 → intercom reply → 产品的 ask tool 返回
  → 产品继续 LLM turn
```

### 8.3 装包到分配（agent 级）

```
① 装包：插件市场 "+ 安装" → PackageManager 调 pi install npm:pi-web-access
   → 写入 ~/.pi/agent/settings.json packages 列表
   → pi-web-access 的工具进入"可用资源池"
② 分配：Agent 配置 → 能力 tab → 勾选 web_search（只给研发，不给 PM）
   → ConfigStore 写入 dev.md 的 tools 字段：read,bash,...,web_search
   → ConfigStore 不改 pm.md（PM 的 tools 里没有 web_search）
③ 运行：spawn 研发 pi 时
   → pi --mode rpc --tools read,bash,edit,...,web_search
   → spawn PM pi 时
   → pi --mode rpc --tools read,grep（没有 web_search）
④ 结果：研发能调 web_search，PM 调不了（即使包已全局加载）
```

**双向追溯**：HiAgent 维护资源→agent 的反向索引，支持"web_search 被谁用了？产品✓ 研发✓ PM✗ 测试✗"这类查询。

## 九、技术栈

| 层 | 技术 |
|----|------|
| 桌面壳 | Tauri 2.x（Rust） |
| 编排内核 | Bun + TypeScript |
| Pi 集成 | `pi --mode rpc` + pi-intercom + pi-mcp-adapter |
| 前端框架 | React 19 + TypeScript |
| 状态管理 | Zustand |
| 画布 | React Flow |
| 编辑器 | Monaco Editor（系统提示词编辑） |
| 样式 | Tailwind CSS |
| 通信 | WebSocket（前端↔Bun） + stdio JSONL（Bun↔Pi） |
| 持久化 | 文件系统（~/.pi/ + hiagent-config.json） |

## 十、MVP 范围

### 10.1 MVP 必须包含

1. **启动页**：4 角色卡片选择 + 输入框
2. **会话视图**：Codex 式左右，单角色对话，流式渲染
3. **Pi 集成**：spawn `pi --mode rpc`，prompt/abort 命令
4. **pi-intercom 集成**：ask/send/reply 事件捕获
5. **委派内联显示**：对话流里的 ask 消息 + 干预按钮
6. **Agent 配置**：基本信息 + 系统提示词 + 能力 tab（工具勾选）
7. **编排画布**：4 节点 + 连线 + 实时状态
8. **无超时 ask**：编排内核包装，超时 = Infinity

### 10.2 MVP 暂不包含（后续迭代）

- 产物预览（内嵌浏览器，见 7.4）—— 第二迭代优先级
- 技能细粒度启用/禁用（先用 Pi 原生全量加载）
- 插件市场 UI（先用 `pi install` 命令行）
- Intercom 时间线全屏视图（先用底部状态条）
- MCP server 配置 UI（先编辑 `.mcp.json`）
- 会话历史搜索
- 多项目切换

## 十一、风险与对策

| 风险 | 对策 |
|------|------|
| pi-intercom 在 `pi --mode rpc` 无头模式下未验证 | MVP 第一周做兼容性验证；不行则改用 SDK 内嵌 |
| Bun sidecar 在 Tauri 2 的进程管理 | 用 Tauri 的 sidecar API；fallback 用 `Bun.spawn` detached |
| Pi RPC 协议变更 | 锁定 Pi 版本，编排内核做协议版本协商 |
| 多 agent 并发资源占用 | MVP 固定 4 角色；后续按需 spawn |

## 十二、参考实现

| 项目 | 借鉴点 |
|------|--------|
| pi-package-webui | `pi --mode rpc` 完整驱动 GUI 的实现，RPC 命令清单 |
| pi-task | 远程 Web View 的快照+增量状态同步模式 |
| pi-subagents | spawn 子进程 + JSONL 事件流的进程模型 |
| glimpseui | 跨平台原生 WebView 窗口的实现参考 |
| pi-intercom | ask/send/reply 通信原语（直接复用） |
| pi-mcp-adapter | MCP → Pi 工具桥接（直接复用） |

## 十三、待确认问题

以下三项需要在实现阶段最早验证，决定 MVP 可行性：

1. **pi-intercom + `pi --mode rpc` 兼容性**（最高优先级）：pi-intercom 的 broker 用 Unix socket/命名管道通信，理论上与 Pi 运行模式无关。但需要在 MVP 第一周实测：spawn 一个 `pi --mode rpc` 进程加载 pi-intercom 扩展，验证 ask/send/reply 在无头模式下正常工作。如果不兼容，回退方案是用 SDK 内嵌（`createAgentSession` + 监听事件模拟 intercom 语义）。
2. **头像存储**：emoji 直接存 agent.md 的 avatar 字段（如 `avatar: ⚙️`）；自定义图片建议用文件路径（`~/.pi/agent/avatars/<name>.png`），避免 base64 膨胀配置文件。MVP 先只支持 emoji。
3. **多项目**：MVP 固定单项目（启动时选 cwd，运行中不可切换）。后续在启动页加项目选择器，每个项目独立的 agent 配置与会话历史。

---

## 附录：UI Mockup 索引

设计过程中产出的 8 张 mockup，存于 `.superpowers/brainstorm/`：

1. `01-architecture.html` — 整体分层架构
2. `02-main-ui.html` — 主界面（早期画布优先版，已被 09 取代）
3. `03-no-timeout.html` — 无超时 ask 机制
4. `04b-agent-config-v2.html` — Agent 配置（左右布局 + 头像 + 合作伙伴）
5. `06-resource-flow.html` — 资源管理（插件市场 vs agent 分配）
6. `07b-capabilities-tab-v2.html` — 能力 tab（汇总顶部，三类工具）
7. `08-intercom-timeline.html` — Intercom 时间线
8. `09-conversation-flow.html` — 对话流程（启动页 + Codex 式会话）
