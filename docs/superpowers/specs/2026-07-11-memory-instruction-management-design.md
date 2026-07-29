# 记忆与指令文件管理 · 设计文档

> **日期**：2026-07-11
> **状态**：已确认，待实现
> **作者**：brainstorming session

## 1. 概述

为 wa-pi 添加「项目记忆功能」和「指令文件展示」两个能力：

- **记忆管理**：通过集成 pi-hermes-memory 插件，让智能体记住用户过往的聊天记忆。用户可在管理页查看、编辑、删除、归档已保存的记忆。
- **指令文件展示**：展示当前已加载的指令文件（AGENTS.md / CLAUDE.md），只读，支持按全局/项目筛选。

## 2. 决策清单

| # | 决策 | 选择 |
|---|------|------|
| 1 | 职责边界 | pi-hermes-memory 自治运行（自动学习/保存），wa-pi 做管理 UI + 结构化展示（搜索/筛选/分类） |
| 2 | 注入对齐 | 注入完全交给插件，wa-pi 只 CRUD 记忆文件，不碰注入逻辑 |
| 3 | 指令文件 | 只读展示已加载的，不增删改，不接管读取 |
| 4 | 归档语义 | 软删除——wa-pi 维护 sidecar JSON（`~/.wa-pi/memory-archive.json`），不修改插件的文件结构 |
| 5 | 记忆分类 | 只用文件来源 3 分类：记忆（MEMORY.md）/ 用户（USER.md）/ 失败（failures.md） |
| 6 | 记忆作用域 | 全局（`~/.wa-pi/pi-hermes-memory/`）+ 项目（`~/.wa-pi/projects-memory/<project>/`）都展示，徽章区分 |
| 7 | 文件竞争 | 不处理，接受概率风险（后台审查 10 轮一次 vs 用户手动编辑低频，碰撞概率极低） |
| 8 | 记忆控制 | 双开关细粒度：自动学习（reviewEnabled）+ 注入提示（memoryPolicyStyle） |

## 3. UI 设计

### 3.1 页面布局：顶部 Tab + 卡片列表（方案 A）

参考截图风格。侧边栏新增「🧠 记忆」导航入口，点击切到 `memory` view。

```
┌──────────────────────────────────────────────────────────┐
│ 🧠 记忆                       自动学习[ON]  注入提示[ON]  │  ← 标题栏内联开关
├──────────────────────────────────────────────────────────┤
│ 已保存(12) │ 归档(3) │ 指令文件(2)                        │  ← 顶部 Tab
├──────────────────────────────────────────────────────────┤
│ [🔍 搜索记忆...]  [全部][记忆][用户][失败]                │  ← 工具栏（记忆 Tab）
│                                                          │    指令文件 Tab 换成 [全部][项目][全局]
├──────────────────────────────────────────────────────────┤
│  ┌────────────────────────────────┐                      │
│  │ [记忆] ○ 全局                   │                      │
│  │ 项目使用 pnpm 而非 npm...        │                      │  ← 卡片列表（滚动）
│  │ 3天前        编辑  归档          │                      │
│  └────────────────────────────────┘                      │
│  ...                                                     │
└──────────────────────────────────────────────────────────┘
```

### 3.2 编辑交互：行内展开

点击「编辑」→ 卡片原地展开为编辑态：
- 卡片边框变靛蓝 + `box-shadow: 0 0 0 3px accent-soft` 光晕
- 内容区变成 contenteditable 文本框
- 分类标签不可改（来自文件来源，固定）
- 底部出现「取消」「保存」按钮

### 3.3 记忆卡片元素

| 元素 | 来源 |
|------|------|
| 分类标签 | 文件来源：记忆（绿）/ 用户（靛蓝）/ 失败（红） |
| 作用域徽章 | 文件路径推断：`pi-hermes-memory/` → ○ 全局；`projects-memory/<project>/` → ● 项目名 |
| 内容文本 | § 分隔的条目原文 |
| 时间 | 最后修改时间（来自 sidecar，无则不显示） |
| 操作按钮 | 已保存：编辑 / 归档；归档页：恢复 / 彻底删除 |

### 3.4 指令文件 Tab

- 数据源：wa-pi 自己扫描全局（`~/.wa-pi/`）+ 项目（当前 cwd）下的 `AGENTS.md` / `CLAUDE.md`（按优先级取第一个命中的）
- 筛选：全部 / 项目 / 全局，**默认「全部」**
- 每条展示：文件名 + 作用域徽章（全局=靛蓝，项目=绿）+ 路径 + 内容摘要
- 内容摘要：只展示前 ~100 字，末尾省略号截断
- 操作：「打开」按钮（在系统默认编辑器中打开完整文件）
- 不解释合并逻辑（全局+项目同时存在时累加生效，但 UI 不提示）

### 3.5 记忆控制开关（标题栏内联）

两个开关水平排列在标题行右侧：
- **⚙️ 自动学习**：ON = `reviewEnabled: true`（默认），OFF = `reviewEnabled: false`
- **💉 注入提示**：ON = `memoryPolicyStyle: "full"`（默认），OFF = `memoryPolicyStyle: "none"`

### 3.6 空状态

- 记忆为空：🧠 图标 + "还没有记忆" + "智能体会在对话中自动学习并记住你的偏好、纠正和经验。"
- 指令文件为空：📄 图标 + "没有指令文件" + "当前项目根目录下没有 AGENTS.md 或 CLAUDE.md。"

### 3.7 视觉规范

遵循 WaPi Light 设计系统（DESIGN.md）：
- 画布：`canvas` #F5F5F7 渐变
- 卡片：`surface` #FFFFFF + `hairline` 边框 + `rounded.lg` 16px
- 分类标签：药丸形（`rounded.pill`），语义色配浅底
- 编辑态光晕：`box-shadow: 0 0 0 3px accent-soft`
- 开关：36×20px，ON = accent #5B5BD6，OFF = hairline-strong #D1D1D6

## 4. 架构与数据流

```
┌─ 前端 (React + Zustand) ──────────────────────────────────────┐
│                                                               │
│  View: "memory"（App.tsx type View 新增）                     │
│    └─ MemoryPage.tsx  （Tab 状态 + 开关 + 数据加载）           │
│    └─ MemoryCard.tsx  （卡片，含行内编辑态）                   │
│    └─ InstructionItem.tsx（指令文件条目，只读）                │
│    └─ MemoryEmpty.tsx（空状态）                               │
│                                                               │
│  Store: store/memory.ts                                       │
│    └─ memories[], archived[], instructions[], config          │
│    └─ activeTab, categoryFilter, scopeFilter, searchQuery     │
│                                                               │
└──────────────────────────┬────────────────────────────────────┘
                           │ WebSocket (端口 9776)
                           │ 新增 8 个事件:
                           │   memory:list / update / archive / restore / purge
                           │   instruction:list
                           │   memory:config:get / set
┌──────────────────────────┴────────────────────────────────────┐
│  Kernel (Bun + TypeScript)                                    │
│                                                               │
│  新增: memory-store.ts                                        │
│    ├─ list()     → 扫描 pi-hermes-memory 目录                 │
│    │               解析 MEMORY.md/USER.md/failures.md         │
│    │               按 § 分隔成条目                             │
│    ├─ update()   → 按条目 ID 定位，原地替换文本               │
│    ├─ archive()  → 从文件移除 + 写 sidecar                    │
│    ├─ restore()  → 从 sidecar 读回，写回文件                  │
│    ├─ purge()    → 从 sidecar 移除                            │
│    ├─ listInstructions() → 扫描全局 + cwd 的 AGENTS.md        │
│    ├─ getConfig() / setConfig() → 读写 hermes-memory-config   │
│    └─                           .json 的 reviewEnabled /      │
│                                  memoryPolicyStyle            │
│                                                               │
│  修改: ws-server.ts（加 8 个 case）                           │
│  修改: extensions.ts（OPTIONAL_EXTENSIONS 加 pi-hermes-memory）│
│  修改: shared/types.ts（加事件类型 + 数据模型）               │
│  修改: Sidebar.tsx（加「记忆」导航入口）                      │
│  修改: App.tsx（View 类型加 "memory"）                        │
│                                                               │
└───────────────────────────────────────────────────────────────┘
                           │ 文件系统（唯一通信层）
                           ▼
┌─ pi-hermes-memory（插件自治）─────────────────────────────────┐
│  ~/.wa-pi/pi-hermes-memory/                                 │
│    ├─ MEMORY.md    ← wa-pi CRUD + 插件后台审查写入          │
│    ├─ USER.md      ← wa-pi CRUD                             │
│    ├─ failures.md  ← wa-pi CRUD + 插件后台审查写入          │
│    └─ sessions.db  ← 插件自己管（wa-pi 不碰）               │
│                                                               │
│  ~/.wa-pi/projects-memory/<project>/                        │
│    ├─ MEMORY.md    ← 同上                                     │
│    └─ failures.md  ← 同上                                     │
│                                                               │
│  ~/.wa-pi/hermes-memory-config.json                         │
│    └─ reviewEnabled / memoryPolicyStyle ← wa-pi 读写        │
│                                                               │
│  注入 hook（policy-only）→ agent system prompt                │
│  memory_search 工具 → 实时读文件                              │
└───────────────────────────────────────────────────────────────┘
```

**核心原则**：wa-pi 和 pi-hermes-memory 之间没有 API 调用，只有文件系统。wa-pi 写文件 = 修改记忆，插件读文件 = 记忆生效。文件系统是唯一通信层。

## 5. 数据模型

### 5.1 类型定义（shared/types.ts 新增）

```ts
/** 记忆分类：来自文件来源 */
type MemoryCategory = "memory" | "user" | "failure";

/** 记忆作用域：来自文件路径 */
type MemoryScope = "global" | "project";

/** 一条记忆条目 */
interface MemoryEntry {
  id: string;                    // 格式："源文件相对路径:rawIndex"，如 "pi-hermes-memory/MEMORY.md:0"
  text: string;                  // 记忆内容（§ 分隔后的单条文本）
  category: MemoryCategory;      // 来自文件来源
  scope: MemoryScope;            // 来自文件路径
  sourceFile: string;            // 源文件绝对路径
  rawIndex: number;              // 在源文件 § 分隔后的索引（0-based）
  updatedAt?: string;            // 最后修改时间（来自 sidecar，可选）
}

/** 归档的记忆（sidecar 记录） */
interface ArchivedMemory extends MemoryEntry {
  archivedAt: string;            // 归档时间（ISO）
}

/** 指令文件 */
interface InstructionFile {
  path: string;                  // 绝对路径
  name: string;                  // 文件名（AGENTS.md / CLAUDE.md）
  scope: "global" | "project";
  content: string;               // 文件全文（用于预览摘要）
}

/** 记忆配置（开关状态） */
interface MemoryConfig {
  reviewEnabled: boolean;        // 自动学习开关
  memoryPolicyStyle: "full" | "compact" | "none";  // 注入策略
}
```

### 5.2 条目 ID 方案

格式：`源文件相对路径:rawIndex`

示例：
- `pi-hermes-memory/MEMORY.md:0` — 全局 MEMORY.md 的第 1 条
- `pi-hermes-memory/USER.md:1` — 全局 USER.md 的第 2 条
- `projects-memory/wa-pi/failures.md:2` — wa-pi 项目的第 3 条失败

理由：用内容 hash 在编辑后会变，无法定位"改的是哪一条"。文件路径+序号在编辑时稳定不变。

### 5.3 § 解析规则

MEMORY.md / USER.md / failures.md 内部用 `§` 符号分隔条目。解析算法：
1. 读取文件全文
2. 按 `§` 分割成数组
3. 过滤空条目（trim 后为空）
4. 每个非空条目的索引即为 `rawIndex`

### 5.4 归档 sidecar 结构

文件：`~/.wa-pi/memory-archive.json`

```json
{
  "entries": [
    {
      "id": "pi-hermes-memory/MEMORY.md:1",
      "text": "旧的测试框架用 Jest，现已迁移到 bun:test",
      "category": "memory",
      "scope": "global",
      "sourceFile": "C:\\Users\\co\\.wa-pi\\pi-hermes-memory\\MEMORY.md",
      "rawIndex": 1,
      "archivedAt": "2026-07-01T10:30:00Z"
    }
  ]
}
```

## 6. WS 协议

### 6.1 新增客户端事件（WSClientEvent）

```ts
// 记忆 CRUD
{ type: "memory:list" }
{ type: "memory:update"; entryId: string; text: string }
{ type: "memory:archive"; entryId: string }
{ type: "memory:restore"; entryId: string }
{ type: "memory:purge"; entryId: string }

// 指令文件
{ type: "instruction:list" }

// 记忆配置开关
{ type: "memory:config:get" }
{ type: "memory:config:set"; reviewEnabled?: boolean; memoryPolicyStyle?: "full" | "compact" | "none" }
```

### 6.2 新增服务端事件（WSServerEvent）

```ts
{ type: "memory:list"; memories: MemoryEntry[]; archived: ArchivedMemory[] }
{ type: "memory:update"; ok: boolean }
{ type: "memory:archive"; ok: boolean }
{ type: "memory:restore"; ok: boolean }
{ type: "memory:purge"; ok: boolean }
{ type: "instruction:list"; instructions: InstructionFile[] }
{ type: "memory:config"; config: MemoryConfig }

// 广播：CRUD 后刷新前端 store
{ type: "memory:changed" }
```

### 6.3 路由处理（ws-server.ts 新增 case）

参照现有 `extension:list/toggle` 模式（ws-server.ts:523-543）：

| 事件 | 处理 |
|------|------|
| `memory:list` | `memoryStore.list()` → reply memories + archived |
| `memory:update` | `memoryStore.update(id, text)` → reply ok → 广播 `memory:changed` |
| `memory:archive` | `memoryStore.archive(id)` → reply ok → 广播 `memory:changed` |
| `memory:restore` | `memoryStore.restore(id)` → reply ok → 广播 `memory:changed` |
| `memory:purge` | `memoryStore.purge(id)` → reply ok → 广播 `memory:changed` |
| `instruction:list` | `memoryStore.listInstructions()` → reply instructions |
| `memory:config:get` | `memoryStore.getConfig()` → reply config |
| `memory:config:set` | `memoryStore.setConfig(opts)` → `agentManager.markAllDirty()` → 广播 `memory:config` |

> 注：`memory:config:set` 事件处理中调 `agentManager.markAllDirty()`，在 ws-server.ts 的 case 分支里直接调（与 `extension:toggle` 的处理模式一致，ws-server.ts:536），不通过 MemoryStore 注入 agentManager。

## 7. 后端 Service 接口

### 7.1 MemoryStore（新增 memory-store.ts）

参照 `project-store.ts` 模式。

```ts
class MemoryStore {
  constructor(private opts: {
    waPiDir: string;          // ~/.wa-pi
    projectStore: ProjectStore;  // 拿当前项目 cwd
  }) {}

  // —— 记忆 CRUD ——

  async list(): Promise<{
    memories: MemoryEntry[];
    archived: ArchivedMemory[];
  }>

  async update(id: string, text: string): Promise<void>

  async archive(id: string): Promise<void>

  async restore(id: string): Promise<void>

  async purge(id: string): Promise<void>

  // —— 指令文件 ——

  async listInstructions(): Promise<InstructionFile[]>

  // —— 记忆配置开关 ——

  async getConfig(): Promise<MemoryConfig>

  async setConfig(opts: {
    reviewEnabled?: boolean;
    memoryPolicyStyle?: "full" | "compact" | "none";
  }): Promise<void>
}
```

### 7.2 文件扫描路径

| 作用域 | 记忆文件目录 | 对应分类 |
|--------|------------|---------|
| 全局 | `~/.wa-pi/pi-hermes-memory/MEMORY.md` | memory |
| 全局 | `~/.wa-pi/pi-hermes-memory/USER.md` | user |
| 全局 | `~/.wa-pi/pi-hermes-memory/failures.md` | failure |
| 项目 | `~/.wa-pi/projects-memory/<project>/MEMORY.md` | memory |
| 项目 | `~/.wa-pi/projects-memory/<project>/failures.md` | failure |

指令文件扫描：
- 全局：`~/.wa-pi/AGENTS.md` 或 `CLAUDE.md`（取第一个命中）
- 项目：`<cwd>/AGENTS.md` 或 `CLAUDE.md`（取第一个命中）

### 7.3 CRUD 文件操作细节

**update**：readFile → § 分割 → 替换 rawIndex 对应条目 → § 重新拼接 → writeFile（原子覆盖）

**archive**：readFile → § 分割 → 移除 rawIndex 对应条目 → § 重新拼接 → writeFile → 追加到 memory-archive.json

**restore**：从 memory-archive.json 移除该条目 → readFile 源文件 → 追加到末尾（§ 分隔）→ writeFile

**purge**：从 memory-archive.json 移除该条目，不写回源文件

### 7.4 CRUD 后刷新策略

每次 CRUD 操作完成后：
1. reply 操作结果
2. 广播 `memory:changed` 事件
3. 前端收到后重新 `load()` 刷新 store

这样即使底层文件被插件后台审查改了，UI 也能及时反映真实状态，避免用户对着过期数据编辑。

## 8. 前端组件结构

### 8.1 文件清单

```
src/components/
├── memory/                          ← 新增目录
│   ├── MemoryPage.tsx               页面容器：标题栏+开关、Tab 状态、数据加载
│   ├── MemoryCard.tsx               单条记忆卡片（含行内编辑态切换）
│   ├── MemoryEditInline.tsx         行内编辑态：文本框 + 保存/取消
│   ├── InstructionItem.tsx          指令文件条目（只读 + 打开按钮）
│   └── MemoryEmpty.tsx              空状态（记忆为空 / 搜索无结果 / 指令文件为空）
│
src/store/
│   └── memory.ts                    Zustand store
```

### 8.2 Store 接口（store/memory.ts）

```ts
interface MemoryStoreState {
  // 数据
  memories: MemoryEntry[];
  archived: ArchivedMemory[];
  instructions: InstructionFile[];
  config: MemoryConfig | null;

  // UI 状态
  activeTab: "saved" | "archived" | "instructions";
  categoryFilter: "all" | "memory" | "user" | "failure";
  scopeFilter: "all" | "global" | "project";  // 指令文件用，默认 "all"
  searchQuery: string;
  loading: boolean;

  // actions
  load(): Promise<void>;                    // 发 memory:list + instruction:list + memory:config:get
  update(id: string, text: string): Promise<void>;
  archive(id: string): Promise<void>;
  restore(id: string): Promise<void>;
  purge(id: string): Promise<void>;
  setConfig(opts: Partial<MemoryConfig>): Promise<void>;
  setTab(tab): void;
  setCategoryFilter(f): void;
  setScopeFilter(f): void;
  setSearchQuery(q): void;
}
```

### 8.3 MemoryPage 渲染逻辑

```
<MemoryPage>
  {/* 标题栏 + 内联开关 */}
  <header>
    🧠 记忆
    [⚙️ 自动学习 toggle] [💉 注入提示 toggle]
  </header>

  {/* Tab 栏 */}
  <tabs>
    已保存(count) | 归档(count) | 指令文件(count)
  </tabs>

  {/* 工具栏（根据 Tab 切换筛选器） */}
  {activeTab === "saved" || activeTab === "archived" ? (
    <toolbar>
      [搜索框] [全部][记忆][用户][失败]
    </toolbar>
  ) : (
    <toolbar>
      [全部][项目][全局]
    </toolbar>
  )}

  {/* 列表内容 */}
  {activeTab === "saved" && <MemoryCardList entries={filteredMemories} />}
  {activeTab === "archived" && <MemoryCardList entries={archived} mode="archived" />}
  {activeTab === "instructions" && <InstructionList items={filteredInstructions} />}
</MemoryPage>
```

### 8.4 筛选逻辑（前端纯计算）

```ts
// 记忆筛选
const filteredMemories = memories
  .filter(m => categoryFilter === "all" || m.category === categoryFilter)
  .filter(m => !searchQuery || m.text.toLowerCase().includes(searchQuery.toLowerCase()));

// 指令文件筛选
const filteredInstructions = instructions
  .filter(i => scopeFilter === "all" || i.scope === scopeFilter);
```

### 8.5 数据加载时机

- 进入 `memory` view 时调用 `load()`
- 收到 `memory:changed` 广播时重新 `load()`
- 收到 `memory:config` 广播时更新 config

## 9. 插件集成

### 9.1 注册 pi-hermes-memory 为可选插件

在 `extensions.ts` 的 `OPTIONAL_EXTENSIONS` 追加：

```ts
{
  id: "pi-hermes-memory",
  package: "pi-hermes-memory",
  displayName: "记忆",
  description: "持久化记忆：跨会话记住偏好、纠正和经验",
  defaultEnabled: true,
}
```

这样 pi-hermes-memory 与 pi-lens 一样通过 ExtensionManager 管理（首启播种、settings.json.extensions toggle）。

### 9.2 配置文件读写

pi-hermes-memory 的配置文件：`~/.wa-pi/hermes-memory-config.json`

`getConfig()` 读取并提取 `reviewEnabled`（默认 true）和 `memoryPolicyStyle`（默认 "full"）。

`setConfig()` 合并写入，不覆盖用户的其他配置项。

### 9.3 注入链路（不修改）

```
wa-pi AgentManager._createSession
  → DefaultResourceLoader（systemPromptOverride 提供 wa-pi 默认提示词）
    → AGENTS.md/CLAUDE.md 从 cwd 自动扫描（SDK 负责）
  → pi-hermes-memory extension hook
    → 注入 <memory-policy> 策略文本（policy-only 模式）
    → agent 调 memory_search 时实时读文件
```

wa-pi 不碰这条链路。记忆开关通过写配置文件控制插件行为，而非在 wa-pi 层拦截。

## 10. 错误处理

| 场景 | 处理 |
|------|------|
| pi-hermes-memory 未安装/未启用 | 记忆列表为空，显示空状态 + 提示「需要启用记忆插件」 |
| MEMORY.md 文件不存在 | 跳过该来源，不报错（正常状态，插件首启前文件可能不存在） |
| § 解析失败 | 按整文件作为单条条目返回（降级） |
| sidecar JSON 解析失败 | 当作空归档列表处理 + 日志警告 |
| hermes-memory-config.json 不存在 | 返回默认值（reviewEnabled: true, memoryPolicyStyle: "full"） |
| 文件写入失败 | reply ok: false + toast 错误提示 |
| 更新记忆时 rawIndex 越界 | reply ok: false + 错误「条目不存在，可能已被插件修改，请刷新列表」 |

## 11. 不在本次范围内

- 从 pi-hermes-memory 的 sessions.db 读取原生 category 细分（约定/洞察/工具等）
- 会话历史搜索（session_search）
- 技能管理（skill_manage）
- 全文搜索引擎（只用前端文本模糊匹配）
- 记忆手动新增（只支持编辑已有记忆，不主动创建；新记忆由插件后台审查生成）
- 文件写入锁（接受竞争概率风险）

## 12. 验收标准

遵循 AGENTS.md 的四层测试原则：

1. **单元测试（bun:test）**：MemoryStore 的 § 解析、CRUD 操作、config 读写、指令文件扫描，全部用临时目录隔离
2. **组件测试（Vitest + testing-library）**：MemoryPage 的 Tab 切换、筛选、搜索、空状态渲染、行内编辑交互
3. **API 测试（curl/WS）**：8 个新 WS 事件的成功路径 + 错误路径
4. **E2E（Playwright）**：进入记忆页 → 查看记忆列表 → 编辑一条记忆 → 归档 → 恢复 → 切换指令文件 Tab → 筛选全局/项目
