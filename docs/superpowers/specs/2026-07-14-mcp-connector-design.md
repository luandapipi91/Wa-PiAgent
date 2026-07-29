# MCP 连接器 — 设计文档

> 日期：2026-07-14
> 状态：设计完成，待实现

## 1. 概述

在 WaPi 设置页中新增「MCP 连接器」模块，提供可视化的 MCP (Model Context Protocol) 服务器配置管理。底层运行时委托给 pi-mcp-adapter，WaPi 只做配置文件的读写管理 + 通过临时 Pi session 调用 adapter 命令执行连接测试和授权操作。

### 1.1 目标

- 在设置页新增 MCP 连接器 Tab，支持全局和项目两个作用域管理 MCP 服务器
- 支持手动添加、编辑、删除 MCP 服务器配置
- 支持连接测试、查看工具列表、清除授权
- 自动读取项目 `.mcp.json` 文件
- 底层配置格式兼容 pi-mcp-adapter 的 `.mcp.json` 规范

### 1.2 非目标

- 不实现 MCP 客户端运行时（由 pi-mcp-adapter 负责）
- 不支持 MCP 工具的对话内调用（adapter 的 `mcp()` proxy tool 已支持）
- 不修改 pi-mcp-adapter 的配置文件优先级逻辑

## 2. 配置存储

### 2.1 文件映射

| 作用域 | 文件路径 |
|--------|----------|
| 全局 | `~/.wa-pi/mcp.json` |
| 项目 | `<项目cwd>/.mcp.json` |

### 2.2 文件格式

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"],
      "lifecycle": "lazy"
    },
    "figma": {
      "url": "http://localhost:3845/mcp",
      "auth": "oauth"
    }
  },
  "settings": {
    "idleTimeout": 10
  }
}
```

## 3. 数据模型

### 3.1 核心类型

```typescript
// ===== MCP 服务器配置 =====

interface McpServerConfig {
  name: string;               // 唯一标识（对应 .mcp.json 中 mcpServers 的 key）
  command?: string;           // stdio transport — 可执行文件路径
  args?: string[];            // 命令行参数
  env?: Record<string, string>;
  cwd?: string;               // 服务进程工作目录
  url?: string;               // HTTP transport — 与 command 二选一
  headers?: Record<string, string>;
  auth?: "bearer" | "oauth";
  bearerToken?: string;
  oauth?: McpOAuthConfig;
  lifecycle?: "lazy" | "eager" | "keep-alive";
  idleTimeout?: number;
  requestTimeoutMs?: number;
  directTools?: boolean | string[];
  excludeTools?: string[];
  exposeResources?: boolean;
  debug?: boolean;
}

interface McpOAuthConfig {
  grantType?: "authorization_code" | "client_credentials";
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  redirectUri?: string;
}

// ===== 运行时信息 =====

interface McpToolSummary {
  name: string;
  description?: string;
  parameters?: { name: string; type: string; description?: string; required?: boolean }[];
}

type McpServerStatus = "disconnected" | "connected" | "needs_auth" | "error";
```

## 4. WS 协议

### 4.1 事件定义

```typescript
// 前端 → 内核
interface McpListEvent       { type: "mcp:list";       projectId?: string; }
interface McpSaveEvent       { type: "mcp:save";       projectId?: string; config: McpServerConfig; originalName?: string; }
interface McpDeleteEvent     { type: "mcp:delete";     projectId?: string; serverName: string; }
interface McpTestEvent       { type: "mcp:test";       projectId?: string; serverName: string; }
interface McpListToolsEvent  { type: "mcp:listTools";  serverName: string; }
interface McpClearAuthEvent  { type: "mcp:clearAuth";  projectId?: string; serverName: string; }

// 内核 → 前端
interface McpListResult      { type: "mcp:list";       projectId?: string; servers: McpServerConfig[]; }
interface McpChangedEvent    { type: "mcp:changed";    projectId?: string; servers: McpServerConfig[]; }
interface McpTestResult      { type: "mcp:testResult"; serverName: string; success: boolean; error?: string; }
interface McpToolsResult     { type: "mcp:tools";      serverName: string; tools: McpToolSummary[]; }
```

### 4.2 操作流程

| 操作 | 内核行为 |
|------|---------|
| `mcp:list` | 读取对应 `.mcp.json` 文件，返回解析后的 servers 数组 |
| `mcp:save` | 写入/更新 `mcpServers[name]`，写回 JSON 文件，广播 `mcp:changed`。若 `originalName` 存在且与新 name 不同，先删除旧 key 再写入新 key（改名） |
| `mcp:delete` | 删除 `mcpServers[name]` key，写回 JSON 文件，广播 `mcp:changed` |
| `mcp:test` | 启动临时 Pi session（cwd=项目目录），执行 `/mcp reconnect <name>`，等待 agent_end 后返回成功/失败 |
| `mcp:listTools` | 读取 `~/.wa-pi/mcp-cache.json`（pi-mcp-adapter 自动维护），返回该服务器的工具列表 |
| `mcp:clearAuth` | 启动临时 Pi session，执行 `/mcp logout <name>`，清除 OAuth token 并断开连接 |

## 5. 内核设计

### 5.1 McpStore

新增 `packages/kernel/src/mcp-store.ts`：

```
class McpStore {
  constructor(opts: { waPiDir: string; projectStore: ProjectStore })

  // 配置 CRUD
  async list(projectId?: string): Promise<McpServerConfig[]>
  async save(config: McpServerConfig, projectId?: string): Promise<void>
  async delete(serverName: string, projectId?: string): Promise<void>

  // 运行时操作（通过临时 Pi session）
  async testConnection(serverName: string, projectId?: string): Promise<{ok: boolean; error?: string}>
  async clearAuth(serverName: string, projectId?: string): Promise<void>

  // 缓存读取
  async listTools(serverName: string): Promise<McpToolSummary[]>

  // 内部
  private resolveConfigPath(projectId?: string): string
  private readConfig(path: string): McpConfigFile
  private writeConfig(path: string, data: McpConfigFile): Promise<void>
}
```

### 5.2 关键实现细节

**配置读写**：

- 参考 `memory-store.ts` 的文件操作模式
- 全局路径：`join(WA_PI_DIR, "mcp.json")`
- 项目路径：`join(projectCwd, ".mcp.json")`
- 文件不存在时返回空配置，不报错
- 保存时如文件所在目录不存在则自动创建

**连接测试**：

1. 用 `SessionManager.inMemory()` 创建临时 Pi session（不写会话文件）
2. cwd 指向目标项目目录（确保 `.mcp.json` 可见）
3. 执行 `session.prompt("/mcp reconnect <serverName>")`
4. 订阅 agent_end 事件，根据最终消息判断连接是否成功
5. 连接成功 → 返回 `{ok: true}`；失败 → 返回 `{ok: false, error: "..."}`
6. 超时保护（30s），超时视为失败
7. 无论结果，临时 session 立即 dispose

**清除授权**：

1. 同上创建临时 session
2. 执行 `/mcp logout <serverName>`
3. 等待完成，dispose session

**工具列表读取**：

1. 读取 `~/.wa-pi/mcp-cache.json`
2. 解析 `cache[serverName]` 下的工具定义
3. 提取 name + description + parameters
4. 缓存不存在 → 返回空数组（UI 提示"暂无可用的工具缓存，请先执行连接测试"）

### 5.3 ws-server.ts 变更

在 `handle()` 方法中新增 6 个 case，完全参照 memory 的模式：

```
case "mcp:list"  → mcpStore.list → reply
case "mcp:save"  → mcpStore.save → list → broadcast mcp:changed
case "mcp:delete" → mcpStore.delete → list → broadcast mcp:changed
case "mcp:test"  → mcpStore.testConnection → reply mcp:testResult
case "mcp:listTools" → mcpStore.listTools → reply mcp:tools
case "mcp:clearAuth" → mcpStore.clearAuth → reply ok
```

### 5.4 index.ts 变更

在 `startKernel()` 中新增 McpStore 实例化，注入到 WSServer opts。

## 6. 前端设计

### 6.1 文件清单

| 文件 | 说明 |
|------|------|
| `store/mcp.ts` | MCP Zustand store（状态、actions、WS 通信） |
| `components/mcp/McpPage.tsx` | MCP 连接器主页面（作用域切换 + 搜索 + 列表 + 添加表单） |
| `components/mcp/McpCard.tsx` | 单个 MCP 服务器卡片（状态展示 + 操作按钮） |
| `components/mcp/McpToolsModal.tsx` | 工具列表弹窗 |
| `components/mcp/McpForm.tsx` | 新增/编辑 MCP 服务器表单 |
| `components/settings/McpSection.tsx` | 设置页包装组件（一行代码，渲染 McpPage） |

需要修改已有文件：

- `store/settings.ts` — SettingsSection 类型新增 `"mcp"`
- `components/SettingsModal.tsx` — 左侧导航新增「🔌 MCP 连接器」条目 + 右侧渲染 McpSection

### 6.2 状态管理

```typescript
// store/mcp.ts — Zustand store
interface McpState {
  servers: McpServerConfig[];
  selectedProjectId: string | null;   // null=全局作用域
  searchQuery: string;
  loading: boolean;

  // actions
  load(projectId?: string): void;
  setServers(data: McpListResult | McpChangedEvent): void;
  save(config: McpServerConfig, projectId?: string): void;
  delete(serverName: string, projectId?: string): void;
  testConnection(serverName: string, projectId?: string): void;
  listTools(serverName: string): void;
  clearAuth(serverName: string, projectId?: string): void;
  setSelectedProjectId(id: string | null): void;
  setSearchQuery(q: string): void;
}
```

### 6.3 McpPage 布局

```
┌──────────────────────────────────────────────────┐
│ 🔌 MCP 连接器                                     │  ← 标题
├──────────────────────────────────────────────────┤
│ [🌐 全局 ▾]  [🔍 搜索...]  [+ 手动添加]           │  ← 工具栏
├──────────────────────────────────────────────────┤
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │ ● chrome-devtools          已连接 🟢       │  │
│  │   npx -y chrome-devtools-mcp@latest        │  │
│  │   [查看工具] [清除授权] [编辑] [删除]       │  │
│  │  [连接测试] ← 只在非 connected 时显示      │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │ ● figma                 OAuth 需授权 🟡    │  │
│  │   http://localhost:3845/mcp                │  │
│  │   [授权] [查看工具] [编辑] [删除]           │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │ ● linear                    未连接 🔴      │  │
│  │   npx -y @modelcontextprotocol/server-...  │  │
│  │   [连接测试] [查看工具] [编辑] [删除]       │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
└──────────────────────────────────────────────────┘
```

### 6.4 服务器状态

服务器在 UI 中的状态由客户端维护：

- 初始加载时所有服务器状态为 `disconnected`（adapter 采用 lazy 模式，不会预连接）
- `mcp:test` 成功后 → `connected`
- `mcp:test` 失败 → `error`（显示错误信息）
- 配置了 `auth: "oauth"` 但 adapter 提示需要授权 → `needs_auth`
- 「清除授权」后 → 重置为 `disconnected`

状态不持久化到 `.mcp.json`，仅在当前会话前端内存中维护。每次打开设置页面时重新加载。

### 6.5 McpCard 按钮逻辑

| 按钮 | 显示条件 | 行为 |
|------|---------|------|
| 连接测试 | 非 connected 状态时显示 | WS → mcp:test，显示 loading 态，结果 toast 提示 |
| 查看工具 | 始终显示 | 读 mcp-cache.json，弹出 McpToolsModal 展示工具列表 |
| 授权 | needs_auth 状态时显示 | WS → 启动临时 session 执行 OAuth 流程 |
| 清除授权 | 有 auth 配置时显示（非 needs_auth） | WS → mcp:clearAuth，清空 token |
| 编辑 | 始终显示 | 展开行内编辑表单或弹出 McpForm |
| 删除 | 始终显示 | 弹出 ConfirmDialog，确认后 WS → mcp:delete |

### 6.6 McpToolsModal 布局

```
┌─ 🔧 chrome-devtools 工具列表 ────────────────────┐
│  [🔍 搜索工具...]                           [✕]   │
├──────────────────────────────────────────────────┤
│                                                  │
│  take_screenshot                                 │
│  Take a screenshot of the page or element.       │
│  ┌─ 参数 ────────────────────────────────────┐   │
│  │ format    enum: png|jpeg|webp  默认: png   │   │
│  │ fullPage  boolean               默认: false │   │
│  └───────────────────────────────────────────┘   │
│                                                  │
│  take_snapshot                                   │
│  Capture accessibility snapshot of the page.     │
│  ┌─ 参数 ────────────────────────────────────┐   │
│  │ 无参数                                    │   │
│  └───────────────────────────────────────────┘   │
│                                                  │
│  共 12 个工具                                     │
└──────────────────────────────────────────────────┘
```

空态：缓存不存在时显示「暂无可用的工具缓存，请先执行连接测试」。

### 6.7 手动添加表单

点击「+ 手动添加」展开内联表单：

```
┌─ 新增 MCP 服务器 ────────────────────────────────┐
│ 名称: [____________________]                     │
│ 传输类型: [stdio ▾] [HTTP ▾]                     │
│                                                  │
│  — stdio 模式 —                                  │
│  Command: [________________]                    │
│  Args:    [________________] [+ 添加参数]        │
│                                                  │
│  — HTTP 模式 —                                   │
│  URL:     [________________]                    │
│                                                  │
│  生命周期: [lazy ▾]                              │
│  超时(ms): [________]                            │
│                                                  │
│  [取消]  [保存]                                  │
└──────────────────────────────────────────────────┘
```

保存后 WS → mcp:save，内核写入 `.mcp.json`，刷新列表。

### 6.8 项目作用域切换

跟 MemoryPage 的 `MemoryScopeDropdown` 完全相同的模式：

- 下拉菜单展示「🌐 全局」+ 所有项目列表（来自 `projectsStore`）
- 选择全局 → projectId=null → 读写 `~/.wa-pi/mcp.json`
- 选择项目A → projectId=项目A.id → 读写 `<项目A cwd>/.mcp.json`
- 切换时自动重新加载对应配置文件的内容

### 6.9 OAuth 授权流程

```
用户点击「授权」按钮
  │
  ▼
WaPi 内核启动临时 Pi session (cwd=项目目录)
执行 /mcp reconnect <name>
  │
  ▼
pi-mcp-adapter 检测该服务器需要 OAuth
  → adapter 自动打开系统默认浏览器
  → 浏览器跳转到 MCP 服务器的授权端点
  │
  ▼
用户在浏览器完成授权
  → 浏览器重定向到 http://localhost:<port>/callback?code=...
  → pi-mcp-adapter 在 localhost 端口捕获回调
  → 用 code 换取 access token
  → token 存储到 ~/.wa-pi/auth.json
  │
  ▼
Pi session 返回连接成功
  → WaPi 收到测试结果
  → UI 更新状态为 🟢 connected
```

注意：WaPi 不参与中间的浏览器跳转，只负责发起和等待结果。超时 60s。

## 7. 测试设计

遵循项目 AGENTS.md 要求的 4 层测试金字塔。

### 7.1 单元测试（bun:test）

**shared/mcp.ts**：
- WS 事件类型定义的结构完整性：确保 McpListEvent、McpSaveEvent、McpDeleteEvent 等类型在编译时通过。
- 纯函数测试（如有工具函数如 resolveConfigPath 等）。

**kernel/mcp-store.ts**：
- `resolveConfigPath()` — 全局/项目路径解析正确性
- `readConfig()` — 文件不存在返回空配置；正常文件解析返回正确结构
- `writeConfig()` — 写入后读取验证一致性；目录不存在时自动创建
- `list()` — 返回解析后的 servers 数组
- `save()` — 新增server 写入正确；编辑 server（含改名）写入正确
- `delete()` — 删除 server 后文件不包含该 key
- `listTools()` — 缓存文件存在时正确解析；缓存不存在返回空数组

### 7.2 组件测试（Vitest + @testing-library/react）

**McpCard.tsx**：
- 渲染 server 名称、描述行、状态指示器 🟢/🟡/🔴
- connected 状态不显示「连接测试」按钮
- needs_auth 状态显示「授权」按钮
- 各按钮点击触发对应回调

**McpPage.tsx**：
- 作用域下拉切换：选择项目后触发 load 回调
- 搜索输入过滤列表
- 「+ 手动添加」按钮展开/折叠表单
- 空列表显示空态提示

**McpToolsModal.tsx**：
- 渲染工具名称和描述列表
- 参数信息正确展示
- 搜索过滤工具
- 缓存不存在时显示空态提示

**McpForm.tsx**：
- stdio 模式显示 command/args 字段
- HTTP 模式显示 url 字段
- 切换传输类型时表单联动
- 保存按钮触发 onSubmit 回调

**SettingsModal.tsx**：
- 左侧导航包含「🔌 MCP 连接器」条目
- 点击后右侧渲染 McpSection 内容

### 7.3 集成测试（curl + 运行中服务）

需要启动 WaPi 服务后执行：

- `mcp:list`（全局）— 返回全局 mcp.json 中的服务器列表
- `mcp:list`（项目）— 返回项目 .mcp.json 中的服务器列表
- `mcp:save` — 新增服务器后 list 验证存在；编辑后验证更新
- `mcp:delete` — 删除后 list 验证不存在
- `mcp:listTools` — 缓存存在时返回工具列表；缓存不存在返回空
- `mcp:test` — 对可用服务器返回 ok；不可用服务器返回 error
- `mcp:clearAuth` — 清除后验证配置中 auth 相关字段被清空
- 错误路径：projectId 无效、serverName 不存在等

### 7.4 E2E 测试（Playwright）

完整业务流程：

1. **进入 MCP 连接器页面**：打开设置 → 点击左侧「🔌 MCP 连接器」→ 显示 MCP 管理页面
2. **全局作用域添加服务器**：
   - 保持全局作用域选中
   - 点击「+ 手动添加」→ 表单出现
   - 填写名称、选择 stdio、填写 command → 保存
   - 列表中出现新卡片
3. **项目作用域切换**：
   - 切换作用域下拉到某个项目
   - 列表变为该项目的服务器列表（可能为空）
   - 手动添加一条项目级别的服务器 → 显示在列表中
4. **连接测试**：
   - 点击某服务器卡的「连接测试」
   - 显示 loading 态
   - 完成后 toast 提示成功/失败
5. **查看工具**：
   - 点击「查看工具」→ Modal 弹出
   - 工具列表包含名称和描述
   - 搜索过滤可用
   - 关闭 Modal
6. **编辑服务器**：
   - 点击「编辑」→ 表单展开（预填当前配置）
   - 修改某个字段 → 保存
   - 卡片显示更新后的配置
7. **删除服务器**：
   - 点击「删除」→ ConfirmDialog 弹出
   - 确认 → 卡片从列表消失
8. **空态展示**：在无服务器列表的状态下验证空态提示文案

测试结束后清理测试数据和截图文件。

### 7.5 覆盖率目标

- 每个新增/修改文件覆盖率 ≥ 80%
- kernel/mcp-store.ts 核心逻辑要求 ≥ 90%
- 所有 WS 协议的事件处理路径至少覆盖成功路径 + 一个错误路径

## 8. 错误处理

| 场景 | 处理方式 |
|------|---------|
| `.mcp.json` 文件不存在 | 返回空 servers 数组，不报错 |
| `.mcp.json` JSON 解析失败 | 返回错误信息，通知前端展示 |
| 连接测试超时（30s） | 返回 `{ok: false, error: "连接超时"}` |
| 临时 Pi session 创建失败 | 返回 `{ok: false, error: "Pi 启动失败: ..."}` |
| pi-mcp-adapter 未安装 | 返回 `{ok: false, error: "pi-mcp-adapter 未安装"}` |
| 缓存文件不存在 | 返回空 tools 数组，UI 提示需要先连接测试 |
| 保存时目录不存在 | 自动创建父目录 |
| 保存时写入失败 | 返回错误，前端 toast 提示 |
| OAuth 授权超时（60s） | 返回 `{ok: false, error: "授权超时，请重试"}` |

## 9. 风险与假设

| 风险 | 缓解 |
|------|------|
| pi-mcp-adapter 未安装 | 连接测试/授权前检查 adapter 是否可用，不可用时给出安装指引 |
| 临时 Pi session 与主 session 资源冲突 | 使用 `SessionManager.inMemory()` 隔离，完成后立即 dispose |
| `.mcp.json` 手动编辑后格式损坏 | 读文件时做 JSON 校验，解析失败返回明确错误而非静默 |
| OAuth 流程依赖系统浏览器和 localhost 端口 | 仅桌面 Electron 环境使用，无 headless 场景 |

## 10. 文件变更总览

| 包 | 新增 | 修改 |
|----|------|------|
| shared | `src/mcp.ts` | `src/index.ts`（+导出），`src/types.ts`（+MCP事件到WS联合类型） |
| kernel | `src/mcp-store.ts` | `src/index.ts`（+初始化），`src/ws-server.ts`（+6个case） |
| frontend | `store/mcp.ts`，`McpPage.tsx`，`McpCard.tsx`，`McpToolsModal.tsx`，`McpForm.tsx`，`McpSection.tsx` | `store/settings.ts`（+section），`SettingsModal.tsx`（+导航+MCP内容区） |
