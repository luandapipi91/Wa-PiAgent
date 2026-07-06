# Sidebar 重构 + 多项目支持 设计文档

> 基于 HiAgent 设计文档（2026-07-05）的 sidebar 与会话归属重构
>
> 日期：2026-07-06
> 状态：已与用户对齐核心决策，待写实施计划
> 上游设计：`docs/superpowers/specs/2026-07-05-hiagent-design.md`（原 MVP 计划单项目，本次扩展为多项目）

## 一、目标与范围

### 1.1 目标

把现有"按 agentName 单维度组织会话"的扁平结构，重构为**项目 → 会话**两级模型。用户可以建多个项目（各自独立 cwd），每个项目下放多个会话，每个会话绑定一个主理 agent。Sidebar 重组为四个区块，新建会话改为"主区切换面板"模式。

### 1.2 核心决策（已与用户确认）

| 决策点 | 选择 |
|---|---|
| 范围 | **完整多项目支持**：前端 UI + kernel 持久化 + 独立 cwd + 独立会话历史 |
| 会话与 agent 关系 | 一个会话 = 一个主理 agent；会话内可见该 agent 发起/收到的所有 intercom 委派事件（多 agent 协作内联可见） |
| 委派可见性 | **同一会话内联**：ask 完整生命周期（发出 → 被问 agent 思考 → reply）都内联在当前会话里，被问 agent 不需要独立会话存在 |
| "我的智能体"区块语义 | **全局 agent 配置入口**：点击进 AgentConfig 弹窗，配置全局共享，所有项目复用同一套 agent |
| 项目隔离边界 | **独立 cwd + 独立会话历史**；agent 配置全局共享（不按项目隔离） |
| 新建会话入口 | **两条路径**：项目行右侧 ＋ 在该项目下新建；顶部"新建会话"全局按钮（默认选最近项目） |
| 新建会话 UI | **主区切换为"新建会话面板"**（不是独立启动页）。面板里**输入框上方**有 `📁 项目目录 ▾` 和 `🤖 agent ▾` 两个下拉并排（不是大卡片横排） |
| intercom 状态条 | **方案 C：移到会话视图 header**。会话标题旁加橙色徽标，只反映当前会话的 intercom 状态，不跨会话 |

### 1.3 非目标

- 不做项目级 agent 配置隔离（agent 配置始终全局共享）
- 不做跨项目 intercom（项目 A 的 agent 不跟项目 B 的 agent 通信）
- 不做云同步、远程访问（保持纯本地）
- 不替换现有 Pi 集成（仍用 `pi --mode rpc` + pi-intercom）

## 二、数据模型

### 2.1 三层实体

```
Agent（全局，存 ~/.pi/agent/agents/*.md，本次不动）
  ├─ 研发 ⚙️
  ├─ 产品 📋
  ├─ PM 📅
  └─ 测试 🧪

Project（用户级，存 ~/.hiagent/projects.json）
  ├─ id, name, cwd, createdAt

Session（项目内，元数据在 projects.json，内容在 ~/.hiagent/sessions/<id>.json）
  ├─ id, projectId, primaryAgent, title, createdAt, lastActivity
  ├─ messages: ChatMessage[]         ← 主线消息流
  └─ intercomEvents: AskItem[]       ← 主理 agent 发起或被 ask 时的委派事件
```

### 2.2 类型定义

```typescript
// packages/shared/src/types.ts 新增

interface ProjectEntity {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
}

interface SessionEntity {
  id: string;
  projectId: string;
  primaryAgent: string;    // 主理 agent name（"dev" / "product" / ...）
  title: string;           // 首条消息截断，或用户命名
  createdAt: number;
  lastActivity: number;
}

// ChatMessage 不变（id/role/text/timestamp）
// AskItem 加 sessionId 字段
interface AskItem {
  messageId: string;
  sessionId: string;       // ← 新增：归属哪个会话
  from: string;
  to: string;
  text: string;
  startedAt: number;
  resolved?: boolean;
}
```

### 2.3 AgentState 维度变化

现在 `agents.ts` 的 state 按 agentName 单维度。多项目后，同一研发 agent 在项目 A 和项目 B 是**两个独立 pi 进程**，状态独立。state 改为按 `(projectId, agentName)` 维度组织：

```typescript
// 旧
states: Record<string /* agentName */, AgentState>

// 新
states: Record<string /* `${projectId}:${agentName}` */, AgentState>
```

**Sidebar 显示规则**：agent 状态点按**全局聚合**——只要这个 agent 在任意项目里处于 thinking/blocked，状态点就反映该状态。因为 agent 配置全局共享，用户关心的是"这个角色现在忙不忙"，而非"在哪个项目里忙"。优先级：blocked > thinking > idle。

## 三、Sidebar UI 结构

### 3.1 布局

```
┌─────────────────────────────┐
│ ➕ 新建会话                  │  ← 全局按钮，点击主区切到新建会话面板（项目默认选最近）
│                              │
│ 👥 我的智能体                │  ← 分区标题
│   ⚙️ 研发   ●idle            │  ← 点击进 AgentConfig 弹窗（不切会话）
│   📋 产品   ●thinking        │
│   📅 PM     ●blocked         │  ← 状态点全局聚合（跨项目）
│   🧪 测试                     │
│                              │
│ ─── 项目管理 ───              │  ← 分隔
│                              │
│ ▼ 项目 A          ＋ ⚙️       │  ← 折叠/展开 + 项目内新建 + 项目设置
│   ⚙️ 会话1·研发   2m前        │  ← 主理 agent emoji + 标题 + 相对时间
│   🧪 会话2·测试   1h前        │  ← 选中态蓝左条（沿用现有样式）
│                              │
│ ▶ 项目 B          ＋          │  ← 折叠态
│                              │
└─────────────────────────────┘
（无底部 intercom 状态条，按方案 C 移到会话 header）
```

### 3.2 组件拆分

现有 `Sidebar.tsx` 是单个大文件，重构为多个职责单一的组件：

| 组件 | 职责 |
|---|---|
| `Sidebar.tsx` | 容器，编排各区，沿用 260px 宽和 `#181825` 背景 |
| `NewSessionButton.tsx` | 顶部"新建会话"按钮，点击触发主区切换到新建会话面板 |
| `AgentListSection.tsx` | "我的智能体"区，渲染全局 agent 列表，点击进 AgentConfig |
| `ProjectList.tsx` | "项目管理"区容器，渲染项目列表，含新建项目入口 |
| `ProjectItem.tsx` | 单个项目行：折叠/展开切换 + ＋ 按钮（项目内新建）+ 项目设置 + 渲染该项目下会话子列表 |
| `SessionRow.tsx` | 会话项（已存在，调整 props：加 projectId、sessionId，显示主理 agent emoji + 标题 + 时间） |

### 3.3 会话项显示规则

`{主理agent emoji} {会话标题} · {相对时间}`

- 标题取首条用户消息截断（前 20 字），或用户手动命名
- 相对时间：`2m` / `1h` / `昨天` / `7/5`
- 选中态：`border-left: 2px solid #89b4fa` + `background: rgba(137,180,250,0.15)`（沿用现有 SessionRow 样式）

### 3.4 项目行操作

- **折叠/展开**：点击项目名切换，箭头 ▶/▼
- **＋ 项目内新建**：点击 → 主区切到新建会话面板，项目下拉预选当前项目
- **⚙️ 项目设置**：点击弹出项目设置（重命名、改 cwd、删除项目）—— 删除需二次确认

## 四、新建会话面板

### 4.1 触发方式

两种入口都触发同一逻辑（主区切换为新建会话面板）：

1. **顶部"新建会话"全局按钮**：项目下拉默认选最近活跃项目
2. **项目行右侧 ＋**：项目下拉预选该项目

### 4.2 面板结构

主区切换为"新建会话面板"（不再是独立的 LaunchScreen 路由）：

```
┌─ 主区 header ─────────────────────────────┐
│ 新建会话 · 项目 A                          │
├───────────────────────────────────────────┤
│                                            │
│            开始新会话                       │
│      选好项目目录和角色，直接打字发送         │
│                                            │
│  ┌──────────────────────────────────────┐  │
│  │ 📁 项目 A  ~/work/proj-a ▾  ⚙️ 研发 ▾ │  │ ← 输入框上方下拉并排（关键）
│  ├──────────────────────────────────────┤  │
│  │  给研发发消息...                       │  │ ← 输入区
│  ├──────────────────────────────────────┤  │
│  │  📎 附件   🎨 claude-sonnet-4   发送 →│  │
│  └──────────────────────────────────────┘  │
│                                            │
│  💡 项目目录可在此切换；agent 选谁谁是主理人  │
└───────────────────────────────────────────┘
```

**关键点**：
- 项目/agent 是**输入框上方的紧凑下拉**，不是大卡片横排（与原 LaunchScreen 的角色卡片横排不同）
- 项目下拉含 `📁 项目名  ~/path ▾`，可选择已有项目或"新建项目..."
- agent 下拉含 4 个角色（emoji + 名称），全局共享
- 输入框、附件、模型、发送按钮沿用现有 Composer 样式

### 4.3 流程

```
sidebar 点 ＋ / 顶部新建会话按钮
  → 主区切到"新建会话面板"（项目下拉预选）
  → 用户在面板里选/改项目、选 agent、打字
  → 点发送（或回车）
  → 前端 WS 发 {type:"agent:prompt", projectId, sessionId(新生成), agentName, text}
  → kernel AgentManager 用 (projectId, agentName) 作 key spawn pi（cwd = project.cwd）
  → 主区切到正常会话视图
```

### 4.4 中断与回退

- 在新建会话面板里**未发送**时，点 sidebar 其他会话 → 直接切走，不保留草稿（首条消息必须发送才会建会话，未发送不持久化）
- 在新建会话面板里已打字但未发送 → 切走时丢弃文字（不弹确认，避免打扰；草稿持久化是范围外）
- 新建会话面板发送失败（WS 断开等）→ 文字保留在输入框，错误提示，用户可重试

### 4.5 主区状态机

主区有三种态，由 `currentView` 决定：

```
┌──────────────┐   首次启动无项目    ┌──────────────┐
│ empty        │ ─────────────────→ │ project-setup │
│ (首次/无项目) │                    │ (引导建项目)   │
└──────────────┘                    └──────┬───────┘
       │                                    │ 建完项目
       │ 有项目                              ↓
       ↓                              ┌──────────────┐
┌──────────────┐  点新建/项目 ＋      │ new-session  │
│ session      │ ←─────────────────  │ (新建会话面板) │
│ (会话视图)    │ ──────────────────→ └──────────────┘
└──────────────┘  发送/切会话          ↑
       ↑                                  │ 发送成功
       └──────────────────────────────────┘
```

## 五、会话视图改造

### 5.1 header 加 intercom 状态徽标（方案 C）

```
┌─ 会话 header ─────────────────────────────┐
│ ⚙️ 会话1·研发   ● 研发→产品 · ask · 23s   │  ← 橙色徽标（当前会话 intercom 状态）
│   研发 · claude-sonnet-4 · thinking        │
│                          编排画布 / ⋯       │
└───────────────────────────────────────────┘
```

- 徽标只反映**当前会话**内的 intercom ask（不跨会话聚合）
- 活跃 ask 时显示：`● {from}→{to} · ask · {计时}`，橙色 `#fab387`
- 无活跃 ask 时不显示徽标
- 点击徽标滚动到对话流中对应的委派卡片

### 5.2 数据源变化

| 组件 | 现状 | 改造后 |
|---|---|---|
| MessageList | 按 `currentAgent` 取 messages | 按 `currentSessionId` 取 messages |
| AskCard | 全局 asks 列表过滤 | 按 `currentSessionId` 取 intercomEvents |
| Composer | 发送时带 agentName | 发送时带 projectId + sessionId + agentName |

## 六、Kernel 改动

### 6.1 AgentManager 双 key 改造

现在 `AgentManager.agents.get("dev")` 单维度。改为按 `(projectId, agentName)` spawn —— 同一研发 agent 在项目 A 和项目 B 是两个独立 pi 进程，各自 cwd 不同：

```typescript
// 旧
agents: Map<string /* agentName */, PiRpcClient>

// 新
agents: Map<string /* `${projectId}:${agentName}` */, PiRpcClient>
```

spawn 时 `cwd` 从 `project.cwd` 取，注入 pi 进程的工作目录。

### 6.2 持久化新增

```
~/.hiagent/
  ├─ projects.json              ← 项目元数据列表（含每个项目的 sessions 元数据）
  └─ sessions/
      ├─ <sessionId>.json       ← 单个会话的 messages + intercomEvents
      └─ ...
```

- `projects.json` 结构：`{ projects: ProjectEntity[], sessions: SessionEntity[] }`（sessions 平铺但带 projectId，便于查询）
- 每个会话内容独立文件，避免单文件膨胀
- Agent 配置仍走 `~/.pi/agent/agents/*.md`（不动）

### 6.3 WS 协议扩展

所有 agent 相关事件加 `projectId` 和 `sessionId` 字段，前端按这两个维度路由消息到正确会话：

```diff
- { type: "agent:prompt", agentName: "dev", text: "..." }
+ { type: "agent:prompt", projectId: "p1", sessionId: "s1", agentName: "dev", text: "..." }

- { type: "agent:message", agentName: "dev", message: {...} }
+ { type: "agent:message", projectId: "p1", sessionId: "s1", agentName: "dev", message: {...} }
```

intercom 事件同样加 sessionId 归属。

新增 WS 事件：
- `projects:list` — 返回所有项目和会话元数据（启动时全量同步）
- `project:create` / `project:update` / `project:delete`
- `session:create` / `session:delete` / `session:rename`

## 七、前端 Store 改造

### 7.1 Store 对照

| store | 现状 | 改造后 |
|---|---|---|
| `session.ts` | messages 按 agentName 聚合；sessions 平铺列表；currentAgent | messages 按 sessionId 聚合；sessions 按 projectId 分组；新增 currentSessionId、currentProjectId |
| `agents.ts` | states 按 agentName 单维度 | states 按 `(projectId, agentName)` 维度；新增 selector `getAgentGlobalState(name)` 跨项目聚合 |
| `intercom.ts` | asks 全局列表 | asks 按 sessionId 聚合 |
| **新增** `projects.ts` | — | 项目列表 CRUD、currentProjectId、新建项目表单状态 |

### 7.2 现有组件影响清单

| 组件 | 改动 |
|---|---|
| `App.tsx` | 路由从"有 currentAgent 显示 SessionView 否则 LaunchScreen"改为三态：空（首次无项目，引导建项目）/ 新建会话面板 / 会话视图 |
| `LaunchScreen.tsx` | 改造为"新建会话面板"组件（不再是独立路由页面，是主区的一种态） |
| `SessionView.tsx` | header 加项目目录显示 + intercom 徽标；按 sessionId 取数据 |
| `Sidebar.tsx` | 拆分为 NewSessionButton / AgentListSection / ProjectList / ProjectItem / SessionRow |
| `MessageList.tsx` | 数据源从 agentName 改为 sessionId |
| `AskCard.tsx` | 数据源从全局 asks 改为 sessionId 过滤 |
| `Composer.tsx` | 新建会话态时在输入框上方渲染项目+agent 下拉 |
| `AgentConfig.tsx` | 不变（仍是全局 agent 配置入口） |

## 八、迁移策略

现有用户数据无项目概念。两种情况：

### 8.1 老用户首次启动（已有 agent 配置和会话）

- 自动建一个"默认项目"（cwd 取现有 pi 的默认工作目录，通常是 `~/.pi/agent/` 或当前目录）
- 把现有所有会话（按 agentName 组织的）归入默认项目，每个会话保留原 agentName 作 primaryAgent
- 生成 sessionId（uuid），把原 messages 迁到 `~/.hiagent/sessions/<id>.json`
- 提示用户"已为你创建默认项目，可在设置里改名或调整 cwd"

### 8.2 新用户首次启动（无任何数据）

- sidebar 空（项目管理区显示"＋ 新建你的第一个项目"引导）
- 主区显示新建会话面板，项目下拉为空 → 引导先建项目（弹项目创建表单：名称 + 选目录）
- 建完项目后自动回到新建会话面板，预选该项目

## 九、范围外（后续迭代）

- 项目级 agent 配置覆盖（项目 A 的研发用不同提示词）
- 跨项目 intercom
- 会话/项目搜索
- 项目导出/导入
- 会话标题自动总结（现在用首条消息截断）

## 十、参考

- 上游设计：`docs/superpowers/specs/2026-07-05-hiagent-design.md`（6.1 sidebar 原型、11.2 多项目列为后续）
- UI 配色：上游设计 6.0 节 Catppuccin Mocha
- 现有前端结构：`packages/frontend/src/components/` + `packages/frontend/src/store/`
- Brainstorming mockup：`.superpowers/brainstorm/`（sidebar 状态条三方案对比、新建会话面板原型）
