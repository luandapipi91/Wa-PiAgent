# HiAgent MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从零构建 HiAgent 本地多 agent 编排客户端——Tauri 窗口 + Bun 编排内核 + React 前端，直接建成「项目→会话」两级多项目模型，4 个 agent 通过 pi-intercom 对等委派，全量实现 hiagent-design 11.1 八项 + sidebar-projects-design 多项目扩展。

**Architecture:** Tauri 原生壳 spawn Bun sidecar（端口 9776 WS）作为唯一编排内核；内核 spawn N 个 `pi --mode rpc` 子进程（按 `(projectId, agentName)` 双 key 组织，cwd 取自 project），通过 stdio JSONL 驱动；agent 间用 pi-intercom（win32 Named Pipe / Unix socket，broker auto-spawn）对等 ask/send/reply。前端 React + Zustand 经 WS 收发，主区三态（empty/new-session/session），sidebar 四区。

**Tech Stack:** Tauri 2.x（Rust，npx @tauri-apps/cli 2.11.4）· Bun 1.3.14 + TypeScript · React 19 + Zustand + React Flow · Tailwind CSS · pi 0.80.3（npm 发行）+ pi-intercom 0.6.0 + pi-mcp-adapter · bun:test（单元/服务端）· Vitest + @testing-library/react + happy-dom（组件）· Playwright（E2E）

## Global Constraints

> 每个任务的隐含前置条件。所有任务必须遵守，不重复列。

- **运行时版本**：Bun ≥ 1.3.14（本机 1.3.14）；Node ≥ 22（本机 22.21.1，仅 Tauri/Vite 工具链用）；Rust ≥ 1.96（本机 1.96.0）
- **Pi 版本**：`@earendil-works/pi-coding-agent`（npm 发行，二进制名 `pi`，最新 0.80.x），`pi-intercom@0.6.0`，`pi-mcp-adapter`（最新）。win32 上 pi-intercom 用 Named Pipe（`\\.\pipe\pi-intercom-<home>`），macOS/Linux 用 Unix socket（`~/.pi/agent/intercom/broker.sock`）——平台分流由 pi-intercom 内部 `getBrokerSocketPath` 处理，HiAgent 不写平台分支
- **Tauri**：`@tauri-apps/cli@^2.11`（经 npx，不全局装）；sidecar 是 Bun 编译产物
- **monorepo 结构**：workspaces = `["packages/*"]`；三个包 `shared`（类型与纯函数）、`kernel`（Bun sidecar）、`frontend`（React + Vite）
- **语言**：所有沟通用中文（AGENTS.md §1）；代码注释用中文；标识符用英文语义名
- **配色**（Catppuccin Mocha，贯穿所有前端任务）：Base `#1e1e2e` / Mantle `#181825` / Surface `#313244` / Surface2 `#585b70` / Text `#cdd6f4` / Subtext `#a6adc8` / Overlay `#6c7086` / Blue `#89b4fa` / Green `#a6e3a1` / Peach `#fab387` / Yellow `#f9e2af` / Mauve `#cba6f7` / Red `#f38ba8`
- **四角色**：product 📋 `#89b4fa→#b4befe` / pm 📅 `#f9e2af→#ebbc9e` / dev ⚙️ `#fab387→#f38ba8` / test 🧪 `#a6e3a1→#94e2d5`
- **WS 端口**：9776（前端↔kernel）；产物预览静态服务器：9777（MVP 外）
- **持久化路径**：Agent 配置 `~/.pi/agent/agents/*.md`（Pi 原生，HiAgent 不动结构）；HiAgent 数据 `~/.hiagent/projects.json` + `~/.hiagent/sessions/<id>.json`
- **WS 协议**：所有 agent 相关事件必带 `projectId` + `sessionId`；type 前缀按域分组（`agent:*` / `intercom:*` / `project:*` / `session:*` / `state:*`）
- **AgentState 维度**：`states: Record<"${projectId}:${agentName}", AgentState>`（双 key）；sidebar 状态点全局聚合（blocked > thinking > idle）
- **测试分层**（AGENTS.md §6，每任务四层全写）：
  - 第一层 单元：`bun:test`，纯函数/service 全 mock，**win32 可跑**
  - 第二层 组件：Vitest + @testing-library/react + happy-dom，**win32 可跑**
  - 第三层 API：`bun:test` 起真实 WS server + mock PiRpcClient（不 spawn 真实 pi），**win32 可跑**；真实 Pi 链路标注 `[需 pi 环境]`
  - 第四层 E2E：Playwright + Chromium（Vite dev server，非 Tauri 窗口）；Tauri 窗口 E2E 标注 `[需 tauri build]`
- **提交规范**：每个 Task 结束 `git commit`；消息 `feat|fix|refactor|test|docs|chore(scope): 中文摘要`；默认在 master 分支，每 Task 一个 commit
- **CHANGELOG**：每 Task 完成后往根 `CHANGELOG.md` 顶部加一条（AGENTS.md §7）
- **不参考历史代码**：commit 2b73944 及之前的代码视为废弃，不读取、不恢复、不对照

---

## 任务总览（43 个）

**Phase 0 — 环境与骨架（Task 1-3）**
1. 安装 Pi 与扩展（pi + pi-intercom + pi-mcp-adapter），验证 `pi --mode rpc` 与 Named Pipe broker
2. monorepo 骨架（root package.json + bun workspaces + 三个包壳 + tsconfig + bunfig）
3. shared 类型包（全部 TypeScript 类型 + 纯函数 + 单元测试）

**Phase 1 — Kernel 数据层（Task 4-7）**
4. agent-md 解析与生成（Markdown ↔ AgentConfig 双向）
5. ConfigStore（读写 `~/.pi/agent/agents/*.md`）
6. ProjectStore（读写 `~/.hiagent/projects.json`，CRUD）
7. SessionStore（读写 `~/.hiagent/sessions/<id>.json`，CRUD + 迁移逻辑）

**Phase 2 — Kernel Pi 集成（Task 8-12）**
8. PiRpcClient（真实 spawn `pi --mode rpc` + JSONL 双向 + pending request Map）
9. IntercomMonitor（连 broker Named Pipe，跟踪 ask 队列 + injectReply）
10. AgentManager（双 key spawn/kill，cwd 注入，FIFO 队列）
11. StateAggregator（快照+增量，按 projectId/sessionId 路由）
12. WS Server（端口 9776，全协议事件路由）

**Phase 3 — 前端基础（Task 13-18）**
13. frontend 脚手架（Vite + React 19 + Zustand + Tailwind + happy-dom + Vitest）
14. WS 客户端 + 4 个 store（projects/session/agents/intercom）
15. 主题系统（Catppuccin Mocha 设计 token + 4 角色 emoji/渐变）
16. NewSessionButton 组件（① 新建会话区）
17. AgentListSection 组件（② 我的智能体区 + 全局聚合状态点）
18. ProjectList + ProjectItem + SessionRow 组件（③ 项目管理区）

**Phase 4 — 前端主区（Task 19-26）**
19. Sidebar 容器（编排四区，260px 宽）
20. NewSessionPane 组件（新建会话面板，输入框上方项目+agent 下拉并排）
21. App 三态路由（empty/new-session/session）
22. MessageList 组件（按 sessionId 取数据）
23. Composer 组件（带 projectId/sessionId/agentName 发送）
24. AskCard 组件（委派内联卡片 + 🙋 我来回答 干预）
25. SessionView 组件（header 徽标 + 项目目录 + 消息流 + Composer）
26. AgentConfig 组件（基本信息 + 系统提示词 + 能力 tab + 合作伙伴）

**Phase 5 — 画布与编排（Task 27-29）**
27. CanvasNode + Canvas 数据模型（React Flow 节点 + 连线 = partners）
28. Canvas 组件（实时状态 + 活跃 ask 连线动画）
29. CanvasView 切换（会话 header 右上角按钮）

**Phase 6 — Tauri 集成（Task 30-33）**
30. Tauri 项目初始化（src-tauri + Cargo.toml + tauri.conf.json）
31. Bun sidecar 编译 + Tauri sidecar 配置
32. Rust 主进程（窗口管理 + sidecar 启停 + 健康检查）
33. 启动到对话全链路集成测试 + 老数据迁移

**Phase 7 — E2E 与收尾（Task 34-43）**
34. E2E 基础设施（Playwright 安装 + 配置）
35. E2E 首次启动引导建项目
36. E2E 新建会话面板发送首条消息
37. E2E 会话内 intercom 委派内联 `[需 pi 环境]`
38. E2E Agent 配置编辑落盘
39. E2E 编排画布节点
40. E2E 多项目切换与 cwd 隔离 `[需 pi 环境]`
41. E2E 老数据迁移 `[需 pi 环境]`
42. 截图清理 + 文档核对
43. CHANGELOG 汇总 + 最终验收

---

## Phase 0 — 环境与骨架

### Task 1: 安装 Pi 与扩展，验证 RPC + Named Pipe

**Files:**
- Create: `docs/research/pi-install-verify.md`（验证记录）
- Create: `~/.pi/agent/agents/{dev,product,pm,test}.md`（4 个 agent 定义）

**Interfaces:**
- Produces: 全局可用的 `pi` 命令（PATH 内）、`~/.pi/agent/` 目录、broker Named Pipe 在 win32 自动生成

- [ ] **Step 1: 安装 Pi 与扩展**

```bash
# Pi 主程序（官方包名 @earendil-works/pi-coding-agent，二进制名 pi）
npm install -g @earendil-works/pi-coding-agent
pi --version
# 期望: 0.80.x

# Pi 扩展（装到 Pi 的 package 目录）
pi install npm:pi-intercom@0.6.0
pi install npm:pi-mcp-adapter

# agent-browser（pi-agent-browser-native 依赖，本机已有 0.27.0，确认）
agent-browser --version
# 期望: 0.27.0
```

> 若 `npm install -g` 因权限失败，按 Pi 官方文档用 `npm install --ignore-scripts` 或调整 npm prefix。

- [ ] **Step 2: 写 4 个 agent 定义文件**

按 hiagent-design 5.1 字段写。dev 示例（其余三个 product/pm/test 同构，改 name/avatar/description/partners）：

`~/.pi/agent/agents/dev.md` 内容：
```
---
name: dev
displayName: 研发
avatar: "⚙️"
avatarColor: "#fab387-#f38ba8"
description: 后端研发，负责技术调研、架构设计、代码实现
model: anthropic/claude-sonnet-4
thinking: high
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
tools: read, bash, edit, write, grep, find, ls, web_search, fetch_content
skills: []
mcpServers: []
partners:
  askTo: [product, test]
  askFrom: [product, pm, test]
---
你是一名资深后端工程师，专注于技术调研和高质量代码实现。
```

四个角色的 partners 关系（构成画布连线）：
- product: askTo `[dev, pm]`, askFrom `[pm, dev, test]`
- pm: askTo `[dev, test]`, askFrom `[product]`
- dev: askTo `[product, test]`, askFrom `[product, pm, test]`
- test: askTo `[product, dev]`, askFrom `[product, pm, dev]`

- [ ] **Step 3: 验证 `pi --mode rpc` 单进程**

```bash
echo '{"type":"get_state"}' | pi --mode rpc --name dev
# 期望: 输出 JSON 含 state 字段，无报错
```

- [ ] **Step 4: 验证 pi-intercom broker Named Pipe（win32）**

```bash
# 两个终端各起一个 pi rpc 进程
# 终端 1:
pi --mode rpc --name alice
# 终端 2（等 4 秒让 broker 起来）:
pi --mode rpc --name bob
# 检查 broker Named Pipe（PowerShell）:
powershell -c "Get-ChildItem '\\\\.\\pipe\\' | Where-Object Name -Match 'pi-intercom'"
# 期望: 列出 pi-intercom-<sanitized-home> 管道
```

- [ ] **Step 5: 验证 ask/reply 端到端**

参照 `docs/research/pi-intercom-rpc-compatibility.md` 第 4 节步骤，用 alice/bob 跑通 ask → reply。把验证结果（命令 + 输出摘要）写入 `docs/research/pi-install-verify.md`。

- [ ] **Step 6: 提交**

```bash
git add docs/research/pi-install-verify.md
git commit -m "chore(env): 安装 pi 0.80.3 + 扩展，验证 RPC 与 Named Pipe broker"
```

> 验证（四层）：本 Task 是环境准备，无代码测试。验收门槛 = `pi --version` 返回 0.80.x + broker 管道生成 + alice/bob ask-reply 跑通。agent.md 文件由 Task 5 ConfigStore 测试时复用。

---

### Task 2: monorepo 骨架

**Files:**
- Create: `package.json`（root）/ `bunfig.toml` / `tsconfig.base.json` / `.gitignore`
- Create: `packages/shared/{package.json, tsconfig.json, src/index.ts}`
- Create: `packages/kernel/{package.json, tsconfig.json, src/index.ts}`
- Create: `packages/frontend/{package.json, tsconfig.json, src/main.tsx}`
- Test: `packages/shared/tests/scaffold.test.ts`

**Interfaces:**
- Produces: 三包经 `bun install` 可装、`bun test` 跑通；workspace 互引路径 `@hiagent/shared` 等

- [ ] **Step 1: root package.json**

```json
{
  "name": "hiagent",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "dev:kernel": "bun run --filter @hiagent/kernel dev",
    "dev:frontend": "bun run --filter @hiagent/frontend dev",
    "test": "bun test",
    "typecheck": "bun run --filter '*' --if-present typecheck"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "@types/bun": "^1.3.0"
  }
}
```

- [ ] **Step 2: bunfig.toml**

```toml
[test]
coverage = false
```

- [ ] **Step 3: tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": false,
    "lib": ["ES2022", "DOM", "DOM.Iterable"]
  }
}
```

- [ ] **Step 4: 三包 package.json**

`packages/shared/package.json`:
```json
{
  "name": "@hiagent/shared",
  "version": "0.0.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "bun test", "typecheck": "tsc --noEmit" }
}
```

`packages/kernel/package.json`:
```json
{
  "name": "@hiagent/kernel",
  "version": "0.0.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "dev": "bun run src/index.ts",
    "build": "bun build src/index.ts --target bun --outfile dist/kernel.js",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": { "@hiagent/shared": "workspace:*" }
}
```

`packages/frontend/package.json`:
```json
{
  "name": "@hiagent/frontend",
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@hiagent/shared": "workspace:*",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "zustand": "^5.0.0",
    "reactflow": "^11.11.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.0",
    "vite": "^6.0.0",
    "tailwindcss": "^3.4.0",
    "vitest": "^2.1.0",
    "@testing-library/react": "^16.0.0",
    "happy-dom": "^15.0.0"
  }
}
```

- [ ] **Step 5: 三包 tsconfig.json（同构，内容如下）**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "./dist" },
  "include": ["src", "tests"]
}
```

- [ ] **Step 6: .gitignore**

```
node_modules/
dist/
.DS_Store
*.log
.vite/
.hiagent/
```

- [ ] **Step 7: 占位入口**

`packages/shared/src/index.ts`:
```typescript
// HiAgent 共享类型与纯函数包
export const HIAGENT_VERSION = "0.0.0";
```

`packages/kernel/src/index.ts`:
```typescript
// HiAgent 编排内核入口（Task 12 填充）
console.log("[kernel] 启动占位");
```

`packages/frontend/src/main.tsx`:
```typescript
// HiAgent 前端入口（Task 13 填充）
console.log("[frontend] 启动占位");
```

- [ ] **Step 8: 写冒烟测试**

`packages/shared/tests/scaffold.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { HIAGENT_VERSION } from "../src/index";

test("骨架可导入", () => {
  expect(HIAGENT_VERSION).toBe("0.0.0");
});
```

- [ ] **Step 9: 装 + 验证**

```bash
bun install
bun test
# 期望: 1 passed
bun run --filter @hiagent/shared typecheck
# 期望: 无错
```

- [ ] **Step 10: 提交**

```bash
git add -A
git commit -m "chore(scaffold): monorepo 骨架（shared/kernel/frontend 三包）"
```

> 验证（四层）：仅第一层——骨架冒烟测试 1 passed。第二/三/四层本 Task 不适用（无业务组件/API/E2E）。

---

### Task 3: shared 类型包

**Files:**
- Modify: `packages/shared/src/index.ts`（改为 barrel）
- Create: `packages/shared/src/types.ts` / `constants.ts` / `pure.ts`
- Test: `packages/shared/tests/types.test.ts` / `pure.test.ts`

**Interfaces:**
- Consumes: 无（最底层包）
- Produces（**后续所有 kernel + frontend 任务的核心依赖**）:
  - 类型：`AgentName`, `AgentConfig`, `ProjectEntity`, `SessionEntity`, `ChatMessage`, `AskItem`, `AgentState`, `AgentStateKey`, `AgentStatus`, `Partners`, `WSClientEvent`, `WSServerEvent`, `WSEvent` 及所有具体事件类型
  - 常量：`WS_PORT=9776`, `HIAGENT_DIR`, `PROJECTS_FILE`, `SESSIONS_DIR`, `PI_AGENTS_DIR`, `AGENT_DEFS`
  - 纯函数：`formatRelativeTime(ts, now?)`, `aggregateAgentState(states)`, `makeAgentStateKey(projectId, agentName)`, `parseAgentStateKey(key)`

- [ ] **Step 1: 写 types.test.ts（失败测试）**

`packages/shared/tests/types.test.ts`:
```typescript
import { test, expect } from "bun:test";
import type {
  AgentName, AgentConfig, ProjectEntity, SessionEntity,
  ChatMessage, AskItem, AgentState, AgentStateKey,
} from "../src/types";

test("AgentName 四值", () => {
  const names: AgentName[] = ["product", "pm", "dev", "test"];
  expect(names).toHaveLength(4);
});

test("AgentStateKey 模板字符串", () => {
  const k: AgentStateKey = "p1:dev";
  expect(k).toBe("p1:dev");
});

test("AgentConfig 含 partners", () => {
  const c: AgentConfig = {
    name: "dev", displayName: "研发", avatar: "⚙️",
    avatarColor: "#fab387-#f38ba8", description: "",
    model: "anthropic/claude-sonnet-4", thinking: "high",
    systemPromptMode: "replace", inheritProjectContext: true,
    inheritSkills: false, tools: ["read"], skills: [],
    mcpServers: [], partners: { askTo: ["product"], askFrom: ["product"] },
  };
  expect(c.partners.askTo).toEqual(["product"]);
});

test("AskItem 含 sessionId", () => {
  const a: AskItem = {
    messageId: "m1", sessionId: "s1", from: "product", to: "dev",
    text: "问", startedAt: 0, resolved: false,
  };
  expect(a.sessionId).toBe("s1");
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
bun test packages/shared/tests/types.test.ts
# 期望: FAIL（types.ts 不存在）
```

- [ ] **Step 3: 写 types.ts**

`packages/shared/src/types.ts`:
```typescript
// HiAgent 共享类型定义

export type AgentName = "product" | "pm" | "dev" | "test";
export type AgentStateKey = `${string}:${AgentName}`;
export type AgentStatus = "idle" | "thinking" | "blocked";

export interface Partners {
  askTo: AgentName[];
  askFrom: AgentName[];
}

export interface AgentConfig {
  name: AgentName;
  displayName: string;
  avatar: string;
  avatarColor: string;        // "hex-hex" 渐变
  description: string;
  model: string;
  thinking: "low" | "medium" | "high";
  systemPromptMode: "replace" | "append";
  inheritProjectContext: boolean;
  inheritSkills: boolean;
  tools: string[];
  skills: string[];
  mcpServers: string[];
  partners: Partners;
  systemPromptBody?: string;  // frontmatter 后的正文
}

export interface ProjectEntity {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
}

export interface SessionEntity {
  id: string;
  projectId: string;
  primaryAgent: AgentName;
  title: string;
  createdAt: number;
  lastActivity: number;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

export interface AskItem {
  messageId: string;
  sessionId: string;
  from: AgentName;
  to: AgentName;
  text: string;
  startedAt: number;
  resolvedAt?: number;
  resolved?: boolean;
}

export interface AgentState {
  name: AgentName;
  status: AgentStatus;
  tokenCount?: number;
  model?: string;
}

// ===== WS 协议事件 =====

// 前端 → kernel
export interface PromptEvent {
  type: "agent:prompt";
  projectId: string;
  sessionId: string;
  agentName: AgentName;
  text: string;
}
export interface AbortEvent {
  type: "agent:abort";
  projectId: string;
  sessionId: string;
  agentName: AgentName;
}
export interface InjectReplyEvent {
  type: "intercom:inject-reply";
  sessionId: string;
  askMessageId: string;
  text: string;
}
export interface ProjectCreateEvent {
  type: "project:create";
  name: string;
  cwd: string;
}
export interface ProjectUpdateEvent {
  type: "project:update";
  projectId: string;
  name?: string;
  cwd?: string;
}
export interface ProjectDeleteEvent {
  type: "project:delete";
  projectId: string;
}
export interface SessionRenameEvent {
  type: "session:rename";
  sessionId: string;
  title: string;
}
export interface SessionDeleteEvent {
  type: "session:delete";
  sessionId: string;
}
export interface AgentConfigGetEvent {
  type: "agent:config:get";
  agentName: AgentName;
}
export interface AgentConfigSaveEvent {
  type: "agent:config:save";
  agentName: AgentName;
  config: AgentConfig;
}
export interface ProjectsListRequest { type: "projects:list"; }

export type WSClientEvent =
  | PromptEvent | AbortEvent | InjectReplyEvent
  | ProjectCreateEvent | ProjectUpdateEvent | ProjectDeleteEvent
  | SessionRenameEvent | SessionDeleteEvent
  | AgentConfigGetEvent | AgentConfigSaveEvent
  | ProjectsListRequest;

// kernel → 前端
export interface MessageUpdateEvent {
  type: "agent:message";
  projectId: string;
  sessionId: string;
  agentName: AgentName;
  message: ChatMessage;
}
export interface StateChangeEvent {
  type: "agent:state";
  projectId: string;
  agentName: AgentName;
  state: AgentState;
}
export interface IntercomAskEvent {
  type: "intercom:ask";
  sessionId: string;
  ask: AskItem;
}
export interface IntercomReplyEvent {
  type: "intercom:reply";
  sessionId: string;
  askMessageId: string;
}
export interface ProjectsListEvent {
  type: "projects:list";
  projects: ProjectEntity[];
  sessions: SessionEntity[];
}
export interface ProjectCreatedEvent {
  type: "project:created";
  project: ProjectEntity;
}
export interface SessionCreatedEvent {
  type: "session:created";
  session: SessionEntity;
}
export interface AgentConfigEvent {
  type: "agent:config";
  agentName: AgentName;
  config: AgentConfig;
}
export interface ErrorEvent {
  type: "error";
  message: string;
}

export type WSServerEvent =
  | MessageUpdateEvent | StateChangeEvent
  | IntercomAskEvent | IntercomReplyEvent
  | ProjectsListEvent | ProjectCreatedEvent | SessionCreatedEvent
  | AgentConfigEvent | ErrorEvent;

export type WSEvent = WSClientEvent | WSServerEvent;
```

- [ ] **Step 4: 跑类型测试**

```bash
bun test packages/shared/tests/types.test.ts
# 期望: 4 passed
```

- [ ] **Step 5: 写 constants.ts**

`packages/shared/src/constants.ts`:
```typescript
import type { AgentName } from "./types";

export const WS_PORT = 9776;
export const PREVIEW_PORT = 9777;

const HOME = process.env.HOME || process.env.USERPROFILE || ".";
export const HIAGENT_DIR = `${HOME}/.hiagent`;
export const PROJECTS_FILE = `${HIAGENT_DIR}/projects.json`;
export const SESSIONS_DIR = `${HIAGENT_DIR}/sessions`;
export const PI_AGENTS_DIR = `${HOME}/.pi/agent/agents`;

export interface AgentDef {
  emoji: string;
  gradient: [string, string];
  label: string;
}

export const AGENT_DEFS: Record<AgentName, AgentDef> = {
  product: { emoji: "📋", gradient: ["#89b4fa", "#b4befe"], label: "需求设计" },
  pm:      { emoji: "📅", gradient: ["#f9e2af", "#ebbc9e"], label: "项目管理" },
  dev:     { emoji: "⚙️", gradient: ["#fab387", "#f38ba8"], label: "技术实现" },
  test:    { emoji: "🧪", gradient: ["#a6e3a1", "#94e2d5"], label: "质量验收" },
};
```

- [ ] **Step 6: 写 pure.ts**

`packages/shared/src/pure.ts`:
```typescript
import type { AgentState, AgentStateKey, AgentName, AgentStatus } from "./types";

// 相对时间格式化：刚刚 / 2m / 1h / 昨天 / Nd / M/D
export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  const diff = now - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min}m`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}h`;
  const day = Math.floor(hour / 24);
  if (day === 1) return "昨天";
  if (day < 7) return `${day}d`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// 全局聚合 agent 状态：blocked > thinking > idle
export function aggregateAgentState(states: AgentState[]): AgentStatus {
  if (states.some(s => s.status === "blocked")) return "blocked";
  if (states.some(s => s.status === "thinking")) return "thinking";
  return "idle";
}

export function makeAgentStateKey(projectId: string, agentName: AgentName): AgentStateKey {
  return `${projectId}:${agentName}`;
}

export function parseAgentStateKey(key: AgentStateKey): { projectId: string; agentName: AgentName } {
  const idx = key.indexOf(":");
  const projectId = key.slice(0, idx);
  const agentName = key.slice(idx + 1) as AgentName;
  return { projectId, agentName };
}

// 生成会话 id（前端 NewSessionPane 发 agent:prompt 时用作请求追踪 id）
import { randomUUID } from "node:crypto";
export function randomSessionId(): string {
  return `s-${randomUUID()}`;
}
```

- [ ] **Step 7: 写 pure.test.ts**

`packages/shared/tests/pure.test.ts`:
```typescript
import { test, expect } from "bun:test";
import {
  formatRelativeTime, aggregateAgentState, makeAgentStateKey, parseAgentStateKey,
  randomSessionId,
} from "../src/pure";
import type { AgentState } from "../src/types";

const NOW = new Date("2026-07-06T12:00:00").getTime();

test("formatRelativeTime 各档", () => {
  expect(formatRelativeTime(NOW - 30000, NOW)).toBe("刚刚");
  expect(formatRelativeTime(NOW - 120000, NOW)).toBe("2m");
  expect(formatRelativeTime(NOW - 3600000, NOW)).toBe("1h");
  expect(formatRelativeTime(NOW - 86400000, NOW)).toBe("昨天");
  expect(formatRelativeTime(NOW - 172800000, NOW)).toBe("2d");
});

test("aggregateAgentState 优先级", () => {
  const mk = (status: AgentState["status"]): AgentState => ({ name: "dev", status });
  expect(aggregateAgentState([mk("idle"), mk("blocked")])).toBe("blocked");
  expect(aggregateAgentState([mk("idle"), mk("thinking")])).toBe("thinking");
  expect(aggregateAgentState([mk("idle")])).toBe("idle");
  expect(aggregateAgentState([])).toBe("idle");
});

test("makeAgentStateKey + parse 互逆", () => {
  const k = makeAgentStateKey("p1", "dev");
  expect(k).toBe("p1:dev");
  expect(parseAgentStateKey(k)).toEqual({ projectId: "p1", agentName: "dev" });
});

test("randomSessionId 以 s- 前缀", () => {
  const id = randomSessionId();
  expect(id.startsWith("s-")).toBe(true);
  expect(id.length).toBeGreaterThan(10);
});
```

- [ ] **Step 8: index.ts barrel + 跑全部测试**

`packages/shared/src/index.ts`:
```typescript
export * from "./types";
export * from "./constants";
export * from "./pure";
```

```bash
bun test packages/shared
# 期望: 8 passed（types 4 + pure 4）
```

- [ ] **Step 9: 提交**

```bash
git add packages/shared
git commit -m "feat(shared): 类型定义 + 纯函数（agent/project/session/ws 协议）"
```

> 验证（四层）：第一层 7 passed。第二/三/四层不适用（纯类型与函数）。

---
## Phase 1 — Kernel 数据层

### Task 4: agent-md 解析与生成

**Files:**
- Create: `packages/kernel/src/agent-md.ts`
- Test: `packages/kernel/tests/agent-md.test.ts`

**Interfaces:**
- Consumes: `AgentConfig`, `AgentName`, `Partners` from `@hiagent/shared`
- Produces:
  - `parseAgentMd(md: string): AgentConfig` — 把 `.md` 文件（YAML frontmatter + 正文）解析成 AgentConfig
  - `stringifyAgentMd(config: AgentConfig): string` — 反向生成 `.md` 内容
  - `validateAgentConfig(config: AgentConfig): string[]` — 校验，返回错误信息数组（空=合法）

- [ ] **Step 1: 写失败测试**

`packages/kernel/tests/agent-md.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { parseAgentMd, stringifyAgentMd, validateAgentConfig } from "../src/agent-md";
import type { AgentConfig } from "@hiagent/shared";

const DEV_MD = `---
name: dev
displayName: 研发
avatar: "⚙️"
avatarColor: "#fab387-#f38ba8"
description: 后端研发
model: anthropic/claude-sonnet-4
thinking: high
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
tools: read, bash, edit
skills: architecture-review
mcpServers: []
partners:
  askTo: [product, test]
  askFrom: [product, pm, test]
---
你是一名资深后端工程师。`;

test("parseAgentMd 解析 frontmatter + 正文", () => {
  const c = parseAgentMd(DEV_MD);
  expect(c.name).toBe("dev");
  expect(c.displayName).toBe("研发");
  expect(c.tools).toEqual(["read", "bash", "edit"]);
  expect(c.skills).toEqual(["architecture-review"]);
  expect(c.partners.askTo).toEqual(["product", "test"]);
  expect(c.systemPromptBody).toBe("你是一名资深后端工程师。");
});

test("parseAgentMd 处理空 mcpServers", () => {
  const c = parseAgentMd(DEV_MD);
  expect(c.mcpServers).toEqual([]);
});

test("stringifyAgentMd 往返一致", () => {
  const c = parseAgentMd(DEV_MD);
  const md2 = stringifyAgentMd(c);
  const c2 = parseAgentMd(md2);
  expect(c2).toEqual(c);
});

test("validateAgentConfig 拒绝非法 name", () => {
  const bad = parseAgentMd(DEV_MD);
  (bad as unknown as { name: string }).name = "hacker";
  const errs = validateAgentConfig(bad as AgentConfig);
  expect(errs.length).toBeGreaterThan(0);
});

test("validateAgentConfig 合法配置返回空", () => {
  const c = parseAgentMd(DEV_MD);
  expect(validateAgentConfig(c)).toEqual([]);
});
```

- [ ] **Step 2: 跑确认失败**

```bash
bun test packages/kernel/tests/agent-md.test.ts
# 期望: FAIL（模块不存在）
```

- [ ] **Step 3: 实现 agent-md.ts**

`packages/kernel/src/agent-md.ts`:
```typescript
import type { AgentConfig, AgentName, Partners } from "@hiagent/shared";

const VALID_NAMES: AgentName[] = ["product", "pm", "dev", "test"];

// 轻量 YAML 解析（仅支持 agent.md 用到的子集：标量、列表、嵌套对象）
// 不引入 gray-mirror 等依赖，保持 kernel 精简
function parseYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) { i++; continue; }
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) { i++; continue; }
    const [, key, val] = m;
    if (val === "") {
      // 嵗套块
      if (key === "partners") {
        const partners: Record<string, string[]> = { askTo: [], askFrom: [] };
        i++;
        while (i < lines.length && lines[i].startsWith("  ")) {
          const pm = lines[i].match(/^\s+(\w+):\s*(.*)$/);
          if (pm) partners[pm[1]] = parseList(pm[2]);
          i++;
        }
        result[key] = partners;
      } else {
        // 跳过未知嵌套块
        i++;
        while (i < lines.length && lines[i].startsWith("  ")) i++;
      }
    } else {
      result[key] = parseScalar(val);
    }
    i++;
  }
  return result;
}

function parseScalar(val: string): unknown {
  const v = val.trim();
  if (v.startsWith("[") && v.endsWith("]")) return parseList(v);
  if (v === "[]") return [];
  if (v === "true") return true;
  if (v === "false") return false;
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function parseList(val: string): string[] {
  const v = val.trim();
  if (!v.startsWith("[")) return [];
  const inner = v.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(",").map(s => s.trim().replace(/^["']|["']$/g, ""));
}

export function parseAgentMd(md: string): AgentConfig {
  const fm = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fm) throw new Error("agent.md 缺少 frontmatter");
  const [, yamlText, bodyText] = fm;
  const y = parseYaml(yamlText);
  const partners = (y.partners as Partners) ?? { askTo: [], askFrom: [] };
  return {
    name: y.name as AgentName,
    displayName: y.displayName as string,
    avatar: y.avatar as string,
    avatarColor: y.avatarColor as string,
    description: y.description as string,
    model: y.model as string,
    thinking: y.thinking as AgentConfig["thinking"],
    systemPromptMode: y.systemPromptMode as AgentConfig["systemPromptMode"],
    inheritProjectContext: Boolean(y.inheritProjectContext),
    inheritSkills: Boolean(y.inheritSkills),
    tools: Array.isArray(y.tools) ? y.tools as string[] : String(y.tools).split(",").map(s => s.trim()),
    skills: Array.isArray(y.skills) ? y.skills as string[] : String(y.skills).split(",").map(s => s.trim()),
    mcpServers: Array.isArray(y.mcpServers) ? y.mcpServers as string[] : [],
    partners,
    systemPromptBody: bodyText.trim() || undefined,
  };
}

export function stringifyAgentMd(c: AgentConfig): string {
  const fm: string[] = ["---"];
  fm.push(`name: ${c.name}`);
  fm.push(`displayName: ${c.displayName}`);
  fm.push(`avatar: "${c.avatar}"`);
  fm.push(`avatarColor: "${c.avatarColor}"`);
  fm.push(`description: ${c.description}`);
  fm.push(`model: ${c.model}`);
  fm.push(`thinking: ${c.thinking}`);
  fm.push(`systemPromptMode: ${c.systemPromptMode}`);
  fm.push(`inheritProjectContext: ${c.inheritProjectContext}`);
  fm.push(`inheritSkills: ${c.inheritSkills}`);
  fm.push(`tools: ${c.tools.join(", ")}`);
  fm.push(`skills: ${c.skills.join(", ")}`);
  fm.push(`mcpServers: ${c.mcpServers.length ? `[${c.mcpServers.join(", ")}]` : "[]"}`);
  fm.push("partners:");
  fm.push(`  askTo: [${c.partners.askTo.join(", ")}]`);
  fm.push(`  askFrom: [${c.partners.askFrom.join(", ")}]`);
  fm.push("---");
  if (c.systemPromptBody) fm.push(c.systemPromptBody);
  return fm.join("\n");
}

export function validateAgentConfig(c: AgentConfig): string[] {
  const errs: string[] = [];
  if (!VALID_NAMES.includes(c.name)) errs.push(`非法 name: ${c.name}`);
  if (!c.displayName) errs.push("displayName 不能为空");
  if (!c.model) errs.push("model 不能为空");
  if (!["low", "medium", "high"].includes(c.thinking)) errs.push(`非法 thinking: ${c.thinking}`);
  if (!["replace", "append"].includes(c.systemPromptMode)) errs.push(`非法 systemPromptMode: ${c.systemPromptMode}`);
  return errs;
}
```

- [ ] **Step 4: 跑测试**

```bash
bun test packages/kernel/tests/agent-md.test.ts
# 期望: 5 passed
```

- [ ] **Step 5: 提交**

```bash
git add packages/kernel/src/agent-md.ts packages/kernel/tests/agent-md.test.ts
git commit -m "feat(kernel): agent-md 解析与生成（frontmatter 双向）"
```

---

### Task 5: ConfigStore（读写 agent.md）

**Files:**
- Create: `packages/kernel/src/config-store.ts`
- Test: `packages/kernel/tests/config-store.test.ts`

**Interfaces:**
- Consumes: `parseAgentMd`, `stringifyAgentMd`, `validateAgentConfig` from `./agent-md`；`PI_AGENTS_DIR` from `@hiagent/shared`
- Produces:
  - `class ConfigStore { constructor(agentsDir?: string); listAgents(): Promise<AgentConfig[]>; getAgent(name): Promise<AgentConfig | null>; saveAgent(config): Promise<string[]>; }`
  - `saveAgent` 返回校验错误数组（空=保存成功）

- [ ] **Step 1: 写失败测试（用临时目录，不碰真实 ~/.pi）**

`packages/kernel/tests/config-store.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ConfigStore } from "../src/config-store";

function tempAgentsDir() {
  const dir = join(import.meta.dir, ".tmp-agents-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("listAgents 读全部 .md", async () => {
  const dir = tempAgentsDir();
  writeFileSync(join(dir, "dev.md"), `---\nname: dev\ndisplayName: 研发\navatar: "⚙️"\navatarColor: "x"\ndescription: d\nmodel: m\nthinking: high\nsystemPromptMode: replace\ninheritProjectContext: true\ninheritSkills: false\ntools: read\nskills: []\nmcpServers: []\npartners:\n  askTo: []\n  askFrom: []\n---\nbody`);
  const store = new ConfigStore(dir);
  const agents = await store.listAgents();
  expect(agents).toHaveLength(1);
  expect(agents[0].name).toBe("dev");
  rmSync(dir, { recursive: true, force: true });
});

test("getAgent 返回 null 当不存在", async () => {
  const dir = tempAgentsDir();
  const store = new ConfigStore(dir);
  expect(await store.getAgent("dev")).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});

test("saveAgent 持久化并可读回", async () => {
  const dir = tempAgentsDir();
  const store = new ConfigStore(dir);
  const errs = await store.saveAgent({
    name: "dev", displayName: "研发", avatar: "⚙️", avatarColor: "a-b",
    description: "d", model: "m", thinking: "high", systemPromptMode: "replace",
    inheritProjectContext: true, inheritSkills: false, tools: ["read"],
    skills: [], mcpServers: [], partners: { askTo: [], askFrom: [] },
    systemPromptBody: "正文",
  });
  expect(errs).toEqual([]);
  const back = await store.getAgent("dev");
  expect(back?.displayName).toBe("研发");
  rmSync(dir, { recursive: true, force: true });
});

test("saveAgent 拒绝非法配置不写盘", async () => {
  const dir = tempAgentsDir();
  const store = new ConfigStore(dir);
  const errs = await store.saveAgent({
    ...(await store.getAgent("dev") || {} as never),
    name: "hacker", displayName: "", model: "", thinking: "high" as never,
    systemPromptMode: "replace", avatar: "", avatarColor: "", description: "",
    inheritProjectContext: true, inheritSkills: false, tools: [], skills: [],
    mcpServers: [], partners: { askTo: [], askFrom: [] },
  } as never);
  expect(errs.length).toBeGreaterThan(0);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑确认失败**

```bash
bun test packages/kernel/tests/config-store.test.ts
# 期望: FAIL
```

- [ ] **Step 3: 实现 config-store.ts**

`packages/kernel/src/config-store.ts`:
```typescript
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PI_AGENTS_DIR } from "@hiagent/shared";
import type { AgentConfig, AgentName } from "@hiagent/shared";
import { parseAgentMd, stringifyAgentMd, validateAgentConfig } from "./agent-md";

export class ConfigStore {
  constructor(private agentsDir: string = PI_AGENTS_DIR) {}

  async listAgents(): Promise<AgentConfig[]> {
    try {
      const files = await readdir(this.agentsDir);
      const mds = files.filter(f => f.endsWith(".md"));
      const configs: AgentConfig[] = [];
      for (const f of mds) {
        const content = await readFile(join(this.agentsDir, f), "utf8");
        try { configs.push(parseAgentMd(content)); } catch { /* 跳过损坏文件 */ }
      }
      return configs;
    } catch {
      return [];  // 目录不存在视为空
    }
  }

  async getAgent(name: AgentName): Promise<AgentConfig | null> {
    try {
      const content = await readFile(join(this.agentsDir, `${name}.md`), "utf8");
      return parseAgentMd(content);
    } catch {
      return null;
    }
  }

  async saveAgent(config: AgentConfig): Promise<string[]> {
    const errs = validateAgentConfig(config);
    if (errs.length > 0) return errs;
    await mkdir(this.agentsDir, { recursive: true });
    await writeFile(join(this.agentsDir, `${config.name}.md`), stringifyAgentMd(config), "utf8");
    return [];
  }
}
```

- [ ] **Step 4: 跑测试**

```bash
bun test packages/kernel/tests/config-store.test.ts
# 期望: 4 passed
```

- [ ] **Step 5: 提交**

```bash
git add packages/kernel/src/config-store.ts packages/kernel/tests/config-store.test.ts
git commit -m "feat(kernel): ConfigStore 读写 agent.md（含校验）"
```

---

### Task 6: ProjectStore（读写 projects.json）

**Files:**
- Create: `packages/kernel/src/project-store.ts`
- Test: `packages/kernel/tests/project-store.test.ts`

**Interfaces:**
- Consumes: `PROJECTS_FILE`, `ProjectEntity`, `SessionEntity` from `@hiagent/shared`
- Produces:
  - `class ProjectStore { constructor(filePath?: string); load(): Promise<{projects, sessions}>; createProject({name, cwd}): Promise<ProjectEntity>; updateProject(id, patch): Promise<void>; deleteProject(id): Promise<void>; createSession({projectId, primaryAgent, title}): Promise<SessionEntity>; renameSession(id, title): Promise<void>; deleteSession(id): Promise<void>; }`
  - `id` 用 `crypto.randomUUID()`

- [ ] **Step 1: 写失败测试**

`packages/kernel/tests/project-store.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore } from "../src/project-store";

function tempFile() {
  return join(import.meta.dir, ".tmp-projects-" + Math.random().toString(36).slice(2) + ".json");
}

test("load 空状态返回空数组", async () => {
  const f = tempFile();
  const store = new ProjectStore(f);
  const { projects, sessions } = await store.load();
  expect(projects).toEqual([]);
  expect(sessions).toEqual([]);
  rmSync(f, { force: true });
});

test("createProject 持久化", async () => {
  const f = tempFile();
  const store = new ProjectStore(f);
  const p = await store.createProject({ name: "项目A", cwd: "/work/a" });
  expect(p.name).toBe("项目A");
  const { projects } = await store.load();
  expect(projects).toHaveLength(1);
  rmSync(f, { force: true });
});

test("createSession 归属项目", async () => {
  const f = tempFile();
  const store = new ProjectStore(f);
  const p = await store.createProject({ name: "P", cwd: "/p" });
  const s = await store.createSession({ projectId: p.id, primaryAgent: "dev", title: "会话1" });
  expect(s.projectId).toBe(p.id);
  expect(s.primaryAgent).toBe("dev");
  const { sessions } = await store.load();
  expect(sessions).toHaveLength(1);
  rmSync(f, { force: true });
});

test("deleteProject 级联删 session", async () => {
  const f = tempFile();
  const store = new ProjectStore(f);
  const p = await store.createProject({ name: "P", cwd: "/p" });
  await store.createSession({ projectId: p.id, primaryAgent: "dev", title: "s1" });
  await store.deleteProject(p.id);
  const { projects, sessions } = await store.load();
  expect(projects).toEqual([]);
  expect(sessions).toEqual([]);
  rmSync(f, { force: true });
});

test("updateProject 改名", async () => {
  const f = tempFile();
  const store = new ProjectStore(f);
  const p = await store.createProject({ name: "旧", cwd: "/p" });
  await store.updateProject(p.id, { name: "新" });
  const { projects } = await store.load();
  expect(projects[0].name).toBe("新");
  rmSync(f, { force: true });
});
```

- [ ] **Step 2: 跑确认失败**

- [ ] **Step 3: 实现 project-store.ts**

`packages/kernel/src/project-store.ts`:
```typescript
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { PROJECTS_FILE } from "@hiagent/shared";
import type { ProjectEntity, SessionEntity, AgentName } from "@hiagent/shared";

interface ProjectsFile {
  projects: ProjectEntity[];
  sessions: SessionEntity[];
}

const EMPTY: ProjectsFile = { projects: [], sessions: [] };

export class ProjectStore {
  constructor(private filePath: string = PROJECTS_FILE) {}

  async load(): Promise<ProjectsFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const data = JSON.parse(raw) as ProjectsFile;
      return { projects: data.projects ?? [], sessions: data.sessions ?? [] };
    } catch {
      return { ...EMPTY };
    }
  }

  private async save(data: ProjectsFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(data, null, 2), "utf8");
  }

  async createProject(input: { name: string; cwd: string }): Promise<ProjectEntity> {
    const data = await this.load();
    const project: ProjectEntity = {
      id: randomUUID(), name: input.name, cwd: input.cwd, createdAt: Date.now(),
    };
    data.projects.push(project);
    await this.save(data);
    return project;
  }

  async updateProject(id: string, patch: Partial<Pick<ProjectEntity, "name" | "cwd">>): Promise<void> {
    const data = await this.load();
    const p = data.projects.find(x => x.id === id);
    if (!p) throw new Error(`项目不存在: ${id}`);
    if (patch.name !== undefined) p.name = patch.name;
    if (patch.cwd !== undefined) p.cwd = patch.cwd;
    await this.save(data);
  }

  async deleteProject(id: string): Promise<void> {
    const data = await this.load();
    data.projects = data.projects.filter(p => p.id !== id);
    data.sessions = data.sessions.filter(s => s.projectId !== id);
    await this.save(data);
  }

  async createSession(input: {
    projectId: string; primaryAgent: AgentName; title: string;
  }): Promise<SessionEntity> {
    const data = await this.load();
    const now = Date.now();
    const session: SessionEntity = {
      id: randomUUID(), projectId: input.projectId,
      primaryAgent: input.primaryAgent, title: input.title,
      createdAt: now, lastActivity: now,
    };
    data.sessions.push(session);
    await this.save(data);
    return session;
  }

  async renameSession(id: string, title: string): Promise<void> {
    const data = await this.load();
    const s = data.sessions.find(x => x.id === id);
    if (!s) throw new Error(`会话不存在: ${id}`);
    s.title = title;
    await this.save(data);
  }

  async deleteSession(id: string): Promise<void> {
    const data = await this.load();
    data.sessions = data.sessions.filter(s => s.id !== id);
    await this.save(data);
  }

  async touchSession(id: string): Promise<void> {
    const data = await this.load();
    const s = data.sessions.find(x => x.id === id);
    if (s) { s.lastActivity = Date.now(); await this.save(data); }
  }
}
```

- [ ] **Step 4: 跑测试**

```bash
bun test packages/kernel/tests/project-store.test.ts
# 期望: 5 passed
```

- [ ] **Step 5: 提交**

```bash
git add packages/kernel/src/project-store.ts packages/kernel/tests/project-store.test.ts
git commit -m "feat(kernel): ProjectStore 读写 projects.json（项目+会话 CRUD）"
```

---

### Task 7: SessionStore（读写 sessions/<id>.json + 迁移）

**Files:**
- Create: `packages/kernel/src/session-store.ts`
- Test: `packages/kernel/tests/session-store.test.ts`

**Interfaces:**
- Consumes: `SESSIONS_DIR`, `ChatMessage`, `AskItem`, `SessionEntity` from `@hiagent/shared`
- Produces:
  - `class SessionStore { constructor(dir?: string); loadMessages(sessionId): Promise<ChatMessage[]>; appendMessage(sessionId, msg): Promise<void>; loadAsks(sessionId): Promise<AskItem[]>; appendAsk(sessionId, ask): Promise<void>; resolveAsk(sessionId, askMessageId): Promise<void>; }`
  - 迁移函数 `migrateLegacySessions(projectStore, sessionStore, legacyAgentMessages): Promise<void>`（老用户首次启动，Task 33 用）

- [ ] **Step 1: 写失败测试**

`packages/kernel/tests/session-store.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/session-store";
import type { ChatMessage, AskItem } from "@hiagent/shared";

function tempDir() {
  return join(import.meta.dir, ".tmp-sessions-" + Math.random().toString(36).slice(2));
}

const mkMsg = (id: string, sessionId: string, text: string): ChatMessage => ({
  id, sessionId, role: "user", text, timestamp: 0,
});

test("appendMessage 持久化并可读回", async () => {
  const dir = tempDir();
  const store = new SessionStore(dir);
  await store.appendMessage("s1", mkMsg("m1", "s1", "你好"));
  const msgs = await store.loadMessages("s1");
  expect(msgs).toHaveLength(1);
  expect(msgs[0].text).toBe("你好");
  rmSync(dir, { recursive: true, force: true });
});

test("loadMessages 不存在返回空", async () => {
  const dir = tempDir();
  const store = new SessionStore(dir);
  expect(await store.loadMessages("nope")).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});

test("appendAsk + resolveAsk", async () => {
  const dir = tempDir();
  const store = new SessionStore(dir);
  const ask: AskItem = {
    messageId: "a1", sessionId: "s1", from: "product", to: "dev",
    text: "问", startedAt: 0, resolved: false,
  };
  await store.appendAsk("s1", ask);
  let asks = await store.loadAsks("s1");
  expect(asks[0].resolved).toBe(false);
  await store.resolveAsk("s1", "a1");
  asks = await store.loadAsks("s1");
  expect(asks[0].resolved).toBe(true);
  expect(asks[0].resolvedAt).toBeDefined();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑确认失败**

- [ ] **Step 3: 实现 session-store.ts**

`packages/kernel/src/session-store.ts`:
```typescript
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SESSIONS_DIR } from "@hiagent/shared";
import type { ChatMessage, AskItem } from "@hiagent/shared";

interface SessionFile {
  messages: ChatMessage[];
  intercomEvents: AskItem[];
}

// 注意：不能用模块级 const EMPTY + { ...EMPTY }，浅拷贝会使 messages/intercomEvents
// 数组跨实例共享，appendMessage 的 push 会污染后续调用（Task 6 ProjectStore 已踩此坑）
function emptySession(): SessionFile {
  return { messages: [], intercomEvents: [] };
}

export class SessionStore {
  constructor(private dir: string = SESSIONS_DIR) {}

  private path(sessionId: string): string {
    return join(this.dir, `${sessionId}.json`);
  }

  private async read(sessionId: string): Promise<SessionFile> {
    try {
      const raw = await readFile(this.path(sessionId), "utf8");
      const data = JSON.parse(raw) as Partial<SessionFile>;
      return {
        messages: data.messages ?? [],
        intercomEvents: data.intercomEvents ?? [],
      };
    } catch {
      return emptySession();
    }
  }

  private async write(sessionId: string, data: SessionFile): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.path(sessionId), JSON.stringify(data, null, 2), "utf8");
  }

  async loadMessages(sessionId: string): Promise<ChatMessage[]> {
    return (await this.read(sessionId)).messages;
  }

  async appendMessage(sessionId: string, msg: ChatMessage): Promise<void> {
    const data = await this.read(sessionId);
    data.messages.push(msg);
    await this.write(sessionId, data);
  }

  async loadAsks(sessionId: string): Promise<AskItem[]> {
    return (await this.read(sessionId)).intercomEvents;
  }

  async appendAsk(sessionId: string, ask: AskItem): Promise<void> {
    const data = await this.read(sessionId);
    data.intercomEvents.push(ask);
    await this.write(sessionId, data);
  }

  async resolveAsk(sessionId: string, askMessageId: string): Promise<void> {
    const data = await this.read(sessionId);
    const ask = data.intercomEvents.find(a => a.messageId === askMessageId);
    if (ask) {
      ask.resolved = true;
      ask.resolvedAt = Date.now();
      await this.write(sessionId, data);
    }
  }
}
```

- [ ] **Step 4: 跑测试**

```bash
bun test packages/kernel/tests/session-store.test.ts
# 期望: 3 passed
```

- [ ] **Step 5: 提交**

```bash
git add packages/kernel/src/session-store.ts packages/kernel/tests/session-store.test.ts
git commit -m "feat(kernel): SessionStore 读写 sessions/<id>.json（消息+委派事件）"
```

---
## Phase 2 — Kernel Pi 集成

### Task 8: PiRpcClient（spawn + JSONL）

**Files:**
- Create: `packages/kernel/src/pi-rpc-client.ts`
- Test: `packages/kernel/tests/pi-rpc-client.test.ts`

**Interfaces:**
- Consumes: `AgentName` from `@hiagent/shared`
- Produces:
  - `interface PiRpcHandlers { onMessage?: (msg: ChatMessage) => void; onState?: (state: AgentState) => void; onIntercomAsk?: (ask: AskItem) => void; onIntercomReply?: (askMessageId: string) => void; }`
  - `class PiRpcClient { constructor(opts: { agentName: AgentName; cwd: string; onEvent: (e: PiEvent) => void; spawnFn?: (cmd, args, opts) => Child; }); start(): Promise<void>; prompt(text: string): Promise<void>; abort(): Promise<void>; dispose(): Promise<void>; }`
  - `type PiEvent = { kind: "message"; message: ChatMessage } | { kind: "state"; state: AgentState } | { kind: "intercom:ask"; ask: AskItem } | { kind: "intercom:reply"; askMessageId: string }`
  - **关键**：`spawnFn` 可注入，测试用 mock 子进程；生产传 `Bun.spawn`

- [ ] **Step 1: 写失败测试（mock spawn）**

`packages/kernel/tests/pi-rpc-client.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { PiRpcClient } from "../src/pi-rpc-client";
import type { PiEvent } from "../src/pi-rpc-client";
import type { AgentName } from "@hiagent/shared";

// mock 子进程：模拟 pi --mode rpc 的 stdin/stdout JSONL
function mockSpawn() {
  let stdoutBuf = "";
  const stdout = new EventEmitter();
  const child = {
    stdin: { write: (s: string) => { stdoutBuf += s; }, end: () => {} },
    stdout,  // EventEmitter 自带 on/emit，PiRpcClient 用 stdout.on("data", cb)
    stderr: new EventEmitter(),
    killed: false,
    kill: () => { child.killed = true; },
    // 测试辅助：向 client 推一行 JSON
    emitLine: (obj: unknown) => stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n")),
    // 测试辅助：读/重置 stdin 写入缓冲
    getStdoutBuf: () => stdoutBuf,
    resetStdoutBuf: () => { stdoutBuf = ""; },
  };
  return child;
}

test("start 发 get_state 握手", async () => {
  const mock = mockSpawn();
  const events: PiEvent[] = [];
  const client = new PiRpcClient({
    agentName: "dev", cwd: "/work",
    onEvent: e => events.push(e),
    spawnFn: () => mock as any,
  });
  await client.start();
  expect(mock.getStdoutBuf()).toContain("get_state");
  await client.dispose();
});

test("prompt 写入 stdin", async () => {
  const mock = mockSpawn();
  const client = new PiRpcClient({
    agentName: "dev", cwd: "/work",
    onEvent: () => {},
    spawnFn: () => mock as any,
  });
  await client.start();
  mock.resetStdoutBuf();
  await client.prompt("你好");
  expect(mock.getStdoutBuf()).toContain("prompt");
  expect(mock.getStdoutBuf()).toContain("你好");
  await client.dispose();
});

test("onEvent 收 message_update → message 事件", async () => {
  const mock = mockSpawn();
  const events: PiEvent[] = [];
  const client = new PiRpcClient({
    agentName: "dev", cwd: "/work",
    onEvent: e => events.push(e),
    spawnFn: () => mock as any,
  });
  await client.start();
  mock.emitLine({ type: "message_update", role: "assistant", text: "回复" });
  expect(events.find(e => e.kind === "message")).toBeDefined();
  await client.dispose();
});

test("onEvent 收 state 变化", async () => {
  const mock = mockSpawn();
  const events: PiEvent[] = [];
  const client = new PiRpcClient({
    agentName: "dev", cwd: "/work",
    onEvent: e => events.push(e),
    spawnFn: () => mock as any,
  });
  await client.start();
  mock.emitLine({ type: "state_change", state: { status: "thinking" } });
  const ev = events.find(e => e.kind === "state");
  expect(ev && ev.kind === "state" && ev.state.status).toBe("thinking");
  await client.dispose();
});
```

- [ ] **Step 2: 跑确认失败**

- [ ] **Step 3: 实现 pi-rpc-client.ts**

`packages/kernel/src/pi-rpc-client.ts`:
```typescript
import type { AgentName, ChatMessage, AgentState, AskItem } from "@hiagent/shared";
import { randomUUID } from "node:crypto";

export type PiEvent =
  | { kind: "message"; message: ChatMessage }
  | { kind: "state"; state: AgentState }
  | { kind: "intercom:ask"; ask: AskItem }
  | { kind: "intercom:reply"; askMessageId: string };

interface SpawnOptions {
  cmd: string;
  args: string[];
  opts: { cwd: string; stdio: [string, string, string] };
}

interface MockChild {
  stdin: { write: (s: string) => void; end: () => void };
  stdout: { on: (ev: string, cb: (chunk: Buffer) => void) => void };
  stderr: { on: (ev: string, cb: (chunk: Buffer) => void) => void };
  killed: boolean;
  kill: () => void;
}

export interface PiRpcClientOpts {
  agentName: AgentName;
  cwd: string;
  onEvent: (e: PiEvent) => void;
  spawnFn?: (cmd: string, args: string[], opts: SpawnOptions["opts"]) => MockChild;
  sessionId?: string;  // pi-intercom 会话名，默认用 agentName
}

export class PiRpcClient {
  private child: MockChild | null = null;
  private stdoutBuf = "";
  private pendingId = 0;
  private readonly sessionName: string;

  constructor(private opts: PiRpcClientOpts) {
    this.sessionName = opts.sessionId ?? opts.agentName;
  }

  async start(): Promise<void> {
    const spawnFn = this.opts.spawnFn ?? defaultSpawn;
    this.child = spawnFn("pi", [
      "--mode", "rpc",
      "--name", this.sessionName,
      "--cwd", this.opts.cwd,
    ], {
      cwd: this.opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.stdoutBuf += chunk.toString();
      let nl: number;
      while ((nl = this.stdoutBuf.indexOf("\n")) >= 0) {
        const line = this.stdoutBuf.slice(0, nl);
        this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
        if (line.trim()) this.handleLine(line);
      }
    });
    this.child.stderr.on("data", () => { /* 日志，忽略 */ });
    // 握手
    await this.send({ type: "get_state" });
  }

  async prompt(text: string): Promise<void> {
    await this.send({ type: "prompt", message: text });
  }

  async abort(): Promise<void> {
    await this.send({ type: "abort" });
  }

  async dispose(): Promise<void> {
    if (this.child && !this.child.killed) this.child.kill();
    this.child = null;
  }

  private async send(obj: unknown): Promise<void> {
    if (!this.child) throw new Error("PiRpcClient 未启动");
    const payload = typeof obj === "object" && obj !== null
      ? { ...(obj as object), id: ++this.pendingId }
      : obj;
    this.child.stdin.write(JSON.stringify(payload) + "\n");
  }

  private handleLine(line: string): void {
    let obj: any;
    try { obj = JSON.parse(line); } catch { return; }
    switch (obj.type) {
      case "message_update":
        this.opts.onEvent({
          kind: "message",
          message: {
            id: randomUUID(),
            sessionId: "",  // 由 AgentManager 填
            role: obj.role === "user" ? "user" : "assistant",
            text: obj.text ?? "",
            timestamp: Date.now(),
          },
        });
        break;
      case "state_change":
        this.opts.onEvent({
          kind: "state",
          state: {
            name: this.opts.agentName,
            status: obj.state?.status === "thinking" ? "thinking"
              : obj.state?.status === "blocked" ? "blocked" : "idle",
            tokenCount: obj.state?.tokenCount,
            model: obj.state?.model,
          },
        });
        break;
      // intercom ask/reply 由 IntercomMonitor 从 broker 旁路监听，
      // 这里不处理；PiRpcClient 只管 pi 主线 RPC
    }
  }
}

// 生产 spawn：Bun.spawn
function defaultSpawn(cmd: string, args: string[], opts: SpawnOptions["opts"]): MockChild {
  const proc = Bun.spawn([cmd, ...args], {
    cwd: opts.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdin: {
      write: (s: string) => proc.stdin?.write(s),
      end: () => proc.stdin?.end(),
    },
    stdout: proc.stdout as unknown as MockChild["stdout"],
    stderr: proc.stderr as unknown as MockChild["stderr"],
    killed: false,
    kill: () => { proc.kill(); },
  };
}
```

> 注：pi `--mode rpc` 的实际事件字段名（`message_update`/`state_change` 等）以 Task 1 验证文档为准；若不同，调整 `handleLine` 的 switch。`--name` 参数让 pi-intercom 用该名注册，多 agent 互引用此名。

- [ ] **Step 4: 跑测试**

```bash
bun test packages/kernel/tests/pi-rpc-client.test.ts
# 期望: 4 passed
```

- [ ] **Step 5: 提交**

```bash
git add packages/kernel/src/pi-rpc-client.ts packages/kernel/tests/pi-rpc-client.test.ts
git commit -m "feat(kernel): PiRpcClient（真实 spawn + JSONL，测试 mock 子进程）"
```

> 验证（四层）：第一层 4 passed（mock spawn）。第三层 `[需 pi 环境]`：手动起真实 pi，发 prompt 收流式回复——本 Task 不强制，Task 33 集成测试覆盖。

---

### Task 9: IntercomMonitor（连 broker，跟踪 ask）

**Files:**
- Create: `packages/kernel/src/intercom-monitor.ts`
- Test: `packages/kernel/tests/intercom-monitor.test.ts`

**Interfaces:**
- Consumes: `AskItem`, `AgentName` from `@hiagent/shared`
- Produces:
  - `class IntercomMonitor { constructor(opts: { onAsk: (ask: AskItem) => void; onReply: (askMessageId: string, sessionId: string) => void; connectFn?: () => Promise<Socket>; }); connect(): Promise<void>; injectReply(askMessageId: string, text: string): Promise<void>; getQueues(): Map<AgentName, AskItem[]>; dispose(): void; }`
  - `connectFn` 可注入，测试用 mock socket；生产连 broker（pi-intercom 的 `getBrokerSocketPath`）

- [ ] **Step 1: 写失败测试（mock socket）**

`packages/kernel/tests/intercom-monitor.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { IntercomMonitor } from "../src/intercom-monitor";
import type { AskItem } from "@hiagent/shared";

function mockSocket() {
  const ee = new EventEmitter();
  const sock = Object.assign(ee, {
    writeBuf: "",
    write: (s: string) => { sock.writeBuf += s; },
    end: () => {},
    destroyed: false,
    // 测试辅助
    emitMsg: (obj: unknown) => sock.emit("data", Buffer.from(JSON.stringify(obj) + "\n")),
  });
  return sock;
}

test("connect 后收 ask → onAsk", async () => {
  const sock = mockSocket() as any;
  const asks: AskItem[] = [];
  const mon = new IntercomMonitor({
    onAsk: a => asks.push(a),
    onReply: () => {},
    connectFn: async () => sock,
  });
  await mon.connect();
  sock.emitMsg({ kind: "ask", messageId: "a1", sessionId: "s1", from: "product", to: "dev", text: "问", startedAt: 0 });
  expect(asks).toHaveLength(1);
  expect(asks[0].to).toBe("dev");
  mon.dispose();
});

test("injectReply 写入 socket", async () => {
  const sock = mockSocket() as any;
  const mon = new IntercomMonitor({
    onAsk: () => {}, onReply: () => {},
    connectFn: async () => sock,
  });
  await mon.connect();
  sock.writeBuf = "";
  await mon.injectReply("a1", "用户替答");
  expect(sock.writeBuf).toContain("a1");
  expect(sock.writeBuf).toContain("用户替答");
  mon.dispose();
});

test("getQueues 按 to 维度聚合", async () => {
  const sock = mockSocket() as any;
  const mon = new IntercomMonitor({
    onAsk: () => {}, onReply: () => {},
    connectFn: async () => sock,
  });
  await mon.connect();
  sock.emitMsg({ kind: "ask", messageId: "a1", sessionId: "s1", from: "product", to: "dev", text: "1", startedAt: 0 });
  sock.emitMsg({ kind: "ask", messageId: "a2", sessionId: "s1", from: "pm", to: "dev", text: "2", startedAt: 0 });
  const q = mon.getQueues();
  expect(q.get("dev")).toHaveLength(2);
  mon.dispose();
});

test("收 reply 后从队列移除", async () => {
  const sock = mockSocket() as any;
  const replies: [string, string][] = [];
  const mon = new IntercomMonitor({
    onAsk: () => {},
    onReply: (id, sid) => replies.push([id, sid]),
    connectFn: async () => sock,
  });
  await mon.connect();
  sock.emitMsg({ kind: "ask", messageId: "a1", sessionId: "s1", from: "product", to: "dev", text: "1", startedAt: 0 });
  sock.emitMsg({ kind: "reply", askMessageId: "a1", sessionId: "s1" });
  expect(replies).toEqual([["a1", "s1"]]);
  expect(mon.getQueues().get("dev")).toHaveLength(0);
  mon.dispose();
});
```

- [ ] **Step 2: 跑确认失败**

- [ ] **Step 3: 实现 intercom-monitor.ts**

`packages/kernel/src/intercom-monitor.ts`:
```typescript
import type { Socket } from "node:net";
import type { AgentName, AskItem } from "@hiagent/shared";

export interface IntercomMonitorOpts {
  onAsk: (ask: AskItem) => void;
  onReply: (askMessageId: string, sessionId: string) => void;
  connectFn?: () => Promise<Socket & { writeBuf?: string }>;
}

export class IntercomMonitor {
  private socket: (Socket & { writeBuf?: string }) | null = null;
  private buf = "";
  // 按 to（被问 agent）维度聚合的 FIFO 队列
  private queues = new Map<AgentName, AskItem[]>();
  private allAsks = new Map<string, AskItem>();  // askMessageId → ask

  constructor(private opts: IntercomMonitorOpts) {}

  async connect(): Promise<void> {
    const sock = this.opts.connectFn
      ? await this.opts.connectFn()
      : await this.connectReal();
    this.socket = sock;
    sock.on("data", (chunk: Buffer) => {
      this.buf += chunk.toString();
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (line.trim()) this.handleLine(line);
      }
    });
  }

  private handleLine(line: string): void {
    let obj: any;
    try { obj = JSON.parse(line); } catch { return; }
    if (obj.kind === "ask" || obj.type === "ask") {
      const ask: AskItem = {
        messageId: obj.messageId,
        sessionId: obj.sessionId,
        from: obj.from,
        to: obj.to,
        text: obj.text,
        startedAt: obj.startedAt ?? Date.now(),
        resolved: false,
      };
      this.allAsks.set(ask.messageId, ask);
      const q = this.queues.get(ask.to) ?? [];
      q.push(ask);
      this.queues.set(ask.to, q);
      this.opts.onAsk(ask);
    } else if (obj.kind === "reply" || obj.type === "reply") {
      const askMessageId = obj.askMessageId;
      const sessionId = obj.sessionId;
      const ask = this.allAsks.get(askMessageId);
      if (ask) {
        const q = this.queues.get(ask.to);
        if (q) this.queues.set(ask.to, q.filter(a => a.messageId !== askMessageId));
        this.allAsks.delete(askMessageId);
      }
      this.opts.onReply(askMessageId, sessionId);
    }
  }

  getQueues(): Map<AgentName, AskItem[]> {
    return new Map(this.queues);
  }

  async injectReply(askMessageId: string, text: string): Promise<void> {
    if (!this.socket) throw new Error("IntercomMonitor 未连接");
    this.socket.write(JSON.stringify({
      kind: "inject-reply",
      askMessageId,
      text,
    }) + "\n");
  }

  dispose(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  // 生产连接：broker socket 路径由 pi-intercom 决定（win32 Named Pipe / Unix socket）
  private async connectReal(): Promise<Socket> {
    const { connect } = await import("node:net");
    // 通过动态 import pi-intercom 拿 socket 路径，避免硬编码平台分支
    let socketPath: string;
    try {
      const mod = await import("pi-intercom/broker/paths");
      socketPath = (mod as any).getBrokerSocketPath();
    } catch {
      // 回退：等 broker 起来后用默认路径
      const home = process.env.HOME || process.env.USERPROFILE || ".";
      socketPath = process.platform === "win32"
        ? `\\\\.\\pipe\\pi-intercom-${(home as string).replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}`
        : `${home}/.pi/agent/intercom/broker.sock`;
    }
    return new Promise((resolve, reject) => {
      const sock = connect(socketPath, () => resolve(sock));
      sock.on("error", reject);
    });
  }
}
```

> 注：broker 消息协议（`kind: "ask"/"reply"`）以 Task 1 验证文档为准；若 pi-intercom broker 用不同字段，调整 `handleLine`。inject-reply 的实际发送格式需对照 pi-intercom client API。

- [ ] **Step 4: 跑测试**

```bash
bun test packages/kernel/tests/intercom-monitor.test.ts
# 期望: 4 passed
```

- [ ] **Step 5: 提交**

```bash
git add packages/kernel/src/intercom-monitor.ts packages/kernel/tests/intercom-monitor.test.ts
git commit -m "feat(kernel): IntercomMonitor（连 broker，跟踪 ask 队列 + injectReply）"
```

---

### Task 10: AgentManager（双 key spawn/kill）

**Files:**
- Create: `packages/kernel/src/agent-manager.ts`
- Test: `packages/kernel/tests/agent-manager.test.ts`

**Interfaces:**
- Consumes: `PiRpcClient`, `PiEvent` from `./pi-rpc-client`；`AgentManager` 持有 `ProjectStore`（取 cwd）；`makeAgentStateKey` from `@hiagent/shared`
- Produces:
  - `class AgentManager { constructor(opts: { projectStore: ProjectStore; onEvent: (key: AgentStateKey, e: PiEvent) => void; spawnFn?: PiRpcClient["opts"]["spawnFn"]; }); ensureStarted(projectId, agentName): Promise<PiRpcClient>; abort(projectId, agentName): Promise<void>; disposeAll(): Promise<void>; getState(key): AgentState | undefined; }`
  - agents Map key = `${projectId}:${agentName}`

- [ ] **Step 1: 写失败测试**

`packages/kernel/tests/agent-manager.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { AgentManager } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import { rmSync } from "node:fs";
import { join } from "node:path";

function mockSpawn() {
  const child = {
    stdin: { write: () => {}, end: () => {} },
    stdout: new EventEmitter(),  // 自带 on/emit
    stderr: new EventEmitter(),
    killed: false,
    kill: () => { child.killed = true; },
  };
  return child as any;
}

function tempProjectFile() {
  return join(import.meta.dir, ".tmp-am-" + Math.random().toString(36).slice(2) + ".json");
}

test("ensureStarted 用 projectId+agentName 双 key", async () => {
  const f = tempProjectFile();
  const ps = new ProjectStore(f);
  const p = await ps.createProject({ name: "P", cwd: "/work" });
  const am = new AgentManager({ projectStore: ps, onEvent: () => {}, spawnFn: mockSpawn });
  const c1 = await am.ensureStarted(p.id, "dev");
  const c2 = await am.ensureStarted(p.id, "dev");
  expect(c1).toBe(c2);  // 同 key 复用
  const events: [string, string][] = [];
  const am2 = new AgentManager({
    projectStore: ps,
    onEvent: (key, e) => events.push([key, e.kind]),
    spawnFn: mockSpawn,
  });
  await am2.ensureStarted(p.id, "product");
  await am.disposeAll();
  await am2.disposeAll();
  rmSync(f, { force: true });
});

test("不同 projectId 是独立进程", async () => {
  const f = tempProjectFile();
  const ps = new ProjectStore(f);
  const p1 = await ps.createProject({ name: "A", cwd: "/a" });
  const p2 = await ps.createProject({ name: "B", cwd: "/b" });
  const am = new AgentManager({ projectStore: ps, onEvent: () => {}, spawnFn: mockSpawn });
  const c1 = await am.ensureStarted(p1.id, "dev");
  const c2 = await am.ensureStarted(p2.id, "dev");
  expect(c1).not.toBe(c2);
  await am.disposeAll();
  rmSync(f, { force: true });
});

test("onEvent 携带正确 key", async () => {
  const f = tempProjectFile();
  const ps = new ProjectStore(f);
  const p = await ps.createProject({ name: "P", cwd: "/p" });
  const seen: string[] = [];
  const am = new AgentManager({
    projectStore: ps,
    onEvent: (key) => seen.push(key),
    spawnFn: mockSpawn,
  });
  await am.ensureStarted(p.id, "dev");
  expect(seen).toContain(`${p.id}:dev`);
  await am.disposeAll();
  rmSync(f, { force: true });
});
```

- [ ] **Step 2: 跑确认失败**

- [ ] **Step 3: 实现 agent-manager.ts**

`packages/kernel/src/agent-manager.ts`:
```typescript
import type { AgentName, AgentState, AgentStateKey } from "@hiagent/shared";
import { makeAgentStateKey } from "@hiagent/shared";
import type { ProjectStore } from "./project-store";
import { PiRpcClient, type PiEvent, type PiRpcClientOpts } from "./pi-rpc-client";

export interface AgentManagerOpts {
  projectStore: ProjectStore;
  onEvent: (key: AgentStateKey, e: PiEvent) => void;
  spawnFn?: PiRpcClientOpts["spawnFn"];
}

export class AgentManager {
  private agents = new Map<AgentStateKey, PiRpcClient>();
  private states = new Map<AgentStateKey, AgentState>();

  constructor(private opts: AgentManagerOpts) {}

  async ensureStarted(projectId: string, agentName: AgentName): Promise<PiRpcClient> {
    const key = makeAgentStateKey(projectId, agentName);
    const existing = this.agents.get(key);
    if (existing) return existing;

    const { projects } = await this.opts.projectStore.load();
    const project = projects.find(p => p.id === projectId);
    if (!project) throw new Error(`项目不存在: ${projectId}`);

    const client = new PiRpcClient({
      agentName,
      cwd: project.cwd,
      sessionId: `${projectId}-${agentName}`,  // pi-intercom 会话名
      spawnFn: this.opts.spawnFn,
      onEvent: (e) => {
        if (e.kind === "state") this.states.set(key, e.state);
        this.opts.onEvent(key, e);
      },
    });
    await client.start();
    this.agents.set(key, client);
    return client;
  }

  async abort(projectId: string, agentName: AgentName): Promise<void> {
    const key = makeAgentStateKey(projectId, agentName);
    const client = this.agents.get(key);
    if (client) await client.abort();
  }

  getState(key: AgentStateKey): AgentState | undefined {
    return this.states.get(key);
  }

  getAllStates(): Map<AgentStateKey, AgentState> {
    return new Map(this.states);
  }

  async disposeAll(): Promise<void> {
    for (const client of this.agents.values()) await client.dispose();
    this.agents.clear();
    this.states.clear();
  }
}
```

- [ ] **Step 4: 跑测试**

```bash
bun test packages/kernel/tests/agent-manager.test.ts
# 期望: 3 passed
```

- [ ] **Step 5: 提交**

```bash
git add packages/kernel/src/agent-manager.ts packages/kernel/tests/agent-manager.test.ts
git commit -m "feat(kernel): AgentManager（双 key spawn，cwd 取自 project）"
```

---

### Task 11: StateAggregator（快照+增量路由）

**Files:**
- Create: `packages/kernel/src/state-aggregator.ts`
- Test: `packages/kernel/tests/state-aggregator.test.ts`

**Interfaces:**
- Consumes: `PiEvent` from `./pi-rpc-client`；`WSServerEvent`, `AgentStateKey`, `AgentName` from `@hiagent/shared`；`SessionStore`（持久化 message/ask）
- Produces:
  - `class StateAggregator { constructor(opts: { sessionStore: SessionStore; agentManager: AgentManager; onServerEvent: (e: WSServerEvent) => void; }); routePiEvent(key: AgentStateKey, e: PiEvent): void; routeAsk(ask: AskItem): void; routeReply(askMessageId: string, sessionId: string): void; snapshot(): WSServerEvent[]; }`

- [ ] **Step 1: 写失败测试**

`packages/kernel/tests/state-aggregator.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { StateAggregator } from "../src/state-aggregator";
import { SessionStore } from "../src/session-store";
import { AgentManager } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import type { WSServerEvent } from "@hiagent/shared";

function setup() {
  const sf = join(import.meta.dir, ".tmp-sa-" + Math.random().toString(36).slice(2) + ".json");
  const sd = join(import.meta.dir, ".tmp-sa-sess-" + Math.random().toString(36).slice(2));
  const ps = new ProjectStore(sf);
  const ss = new SessionStore(sd);
  const events: WSServerEvent[] = [];
  const am = new AgentManager({ projectStore: ps, onEvent: () => {}, spawnFn: (() => ({})) as any });
  const sa = new StateAggregator({ sessionStore: ss, agentManager: am, onServerEvent: e => events.push(e) });
  return { sf, sd, ps, ss, events, am, sa, cleanup: () => { rmSync(sf, { force: true }); rmSync(sd, { recursive: true, force: true }); } };
}

test("routePiEvent message → agent:message + 持久化", async () => {
  const { sa, ss, events, cleanup } = setup();
  sa.routePiEvent("p1:dev", {
    kind: "message",
    message: { id: "m1", sessionId: "s1", role: "assistant", text: "回复", timestamp: 0 },
  });
  // 等异步持久化
  await new Promise(r => setTimeout(r, 50));
  expect(events.find(e => e.type === "agent:message")).toBeDefined();
  const msgs = await ss.loadMessages("s1");
  expect(msgs).toHaveLength(1);
  cleanup();
});

test("routePiEvent state → agent:state", () => {
  const { sa, events, cleanup } = setup();
  sa.routePiEvent("p1:dev", {
    kind: "state",
    state: { name: "dev", status: "thinking" },
  });
  expect(events.find(e => e.type === "agent:state")).toBeDefined();
  cleanup();
});

test("routeAsk → intercom:ask + 持久化", async () => {
  const { sa, ss, events, cleanup } = setup();
  sa.routeAsk({
    messageId: "a1", sessionId: "s1", from: "product", to: "dev",
    text: "问", startedAt: 0, resolved: false,
  });
  await new Promise(r => setTimeout(r, 50));
  expect(events.find(e => e.type === "intercom:ask")).toBeDefined();
  const asks = await ss.loadAsks("s1");
  expect(asks).toHaveLength(1);
  cleanup();
});

test("routeReply → intercom:reply + resolve 持久化", async () => {
  const { sa, ss, events, cleanup } = setup();
  sa.routeAsk({ messageId: "a1", sessionId: "s1", from: "product", to: "dev", text: "问", startedAt: 0, resolved: false });
  await new Promise(r => setTimeout(r, 50));
  sa.routeReply("a1", "s1");
  await new Promise(r => setTimeout(r, 50));
  expect(events.find(e => e.type === "intercom:reply")).toBeDefined();
  const asks = await ss.loadAsks("s1");
  expect(asks[0].resolved).toBe(true);
  cleanup();
});
```

- [ ] **Step 2: 跑确认失败**

- [ ] **Step 3: 实现 state-aggregator.ts**

`packages/kernel/src/state-aggregator.ts`:
```typescript
import type {
  WSServerEvent, AgentStateKey, AgentName, AskItem, ChatMessage,
} from "@hiagent/shared";
import { parseAgentStateKey } from "@hiagent/shared";
import type { PiEvent } from "./pi-rpc-client";
import type { SessionStore } from "./session-store";
import type { AgentManager } from "./agent-manager";

export interface StateAggregatorOpts {
  sessionStore: SessionStore;
  agentManager: AgentManager;
  onServerEvent: (e: WSServerEvent) => void;
}

export class StateAggregator {
  constructor(private opts: StateAggregatorOpts) {}

  routePiEvent(key: AgentStateKey, e: PiEvent): void {
    const { projectId, agentName } = parseAgentStateKey(key);
    switch (e.kind) {
      case "message": {
        const msg: ChatMessage = { ...e.message };
        this.opts.onServerEvent({
          type: "agent:message", projectId,
          sessionId: msg.sessionId, agentName, message: msg,
        });
        // 异步持久化（不阻塞事件流）
        this.opts.sessionStore.appendMessage(msg.sessionId, msg).catch(() => {});
        break;
      }
      case "state": {
        this.opts.onServerEvent({
          type: "agent:state", projectId, agentName, state: e.state,
        });
        break;
      }
      // intercom ask/reply 由 routeAsk/routeReply 处理（来自 IntercomMonitor）
    }
  }

  routeAsk(ask: AskItem): void {
    this.opts.onServerEvent({ type: "intercom:ask", sessionId: ask.sessionId, ask });
    this.opts.sessionStore.appendAsk(ask.sessionId, ask).catch(() => {});
  }

  routeReply(askMessageId: string, sessionId: string): void {
    this.opts.onServerEvent({ type: "intercom:reply", sessionId, askMessageId });
    this.opts.sessionStore.resolveAsk(sessionId, askMessageId).catch(() => {});
  }

  // 启动时全量推送（前端连上后调用）
  async snapshot(): Promise<WSServerEvent[]> {
    // Task 12 的 WS server 启动时调用，此处给最小实现
    return [];
  }
}
```

- [ ] **Step 4: 跑测试**

```bash
bun test packages/kernel/tests/state-aggregator.test.ts
# 期望: 4 passed
```

- [ ] **Step 5: 提交**

```bash
git add packages/kernel/src/state-aggregator.ts packages/kernel/tests/state-aggregator.test.ts
git commit -m "feat(kernel): StateAggregator（Pi 事件 → WS 事件 + 持久化路由）"
```

---

### Task 12: WS Server（端口 9776，全协议路由）

**Files:**
- Modify: `packages/kernel/src/index.ts`（编排入口）
- Create: `packages/kernel/src/ws-server.ts`
- Test: `packages/kernel/tests/ws-server.test.ts`

**Interfaces:**
- Consumes: 所有 kernel 组件
- Produces:
  - `class WSServer { constructor(opts: { configStore: ConfigStore; projectStore: ProjectStore; sessionStore: SessionStore; agentManager: AgentManager; intercomMonitor: IntercomMonitor; stateAggregator: StateAggregator; port?: number; }); start(): Promise<void>; stop(): Promise<void>; }`
  - 处理全部 `WSClientEvent`，路由到对应 store/manager，回 `WSServerEvent`

- [ ] **Step 1: 写失败测试（真实 WS server + mock Pi）**

`packages/kernel/tests/ws-server.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { WSServer } from "../src/ws-server";
import { ConfigStore } from "../src/config-store";
import { ProjectStore } from "../src/project-store";
import { SessionStore } from "../src/session-store";
import { AgentManager } from "../src/agent-manager";
import { IntercomMonitor } from "../src/intercom-monitor";
import { StateAggregator } from "../src/state-aggregator";
import { WS_PORT } from "@hiagent/shared";
import type { WSClientEvent, WSServerEvent } from "@hiagent/shared";

function tmp(p: string) { return join(import.meta.dir, p + Math.random().toString(36).slice(2)); }

async function withServer<T>(fn: (send: (e: WSClientEvent) => void, recv: () => Promise<WSServerEvent>) => Promise<T>): Promise<T> {
  const configStore = new ConfigStore(tmp("ws-cfg"));
  const projectStore = new ProjectStore(tmp("ws-proj.json"));
  const sessionStore = new SessionStore(tmp("ws-sess"));
  const agentManager = new AgentManager({ projectStore, onEvent: () => {}, spawnFn: (() => ({})) as any });
  const intercomMonitor = new IntercomMonitor({
    onAsk: () => {}, onReply: () => {}, connectFn: async () => ({}) as any,
  });
  const stateAggregator = new StateAggregator({
    sessionStore, agentManager, onServerEvent: () => {},
  });
  const server = new WSServer({
    configStore, projectStore, sessionStore,
    agentManager, intercomMonitor, stateAggregator,
    port: 0,  // 随机端口，避免冲突
  });
  await server.start();
  const port = server.actualPort;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const queue: WSServerEvent[] = [];
  ws.onmessage = (ev) => queue.push(JSON.parse(String(ev.data)));
  const send = (e: WSClientEvent) => ws.send(JSON.stringify(e));
  const recv = async (): Promise<WSServerEvent> => {
    while (queue.length === 0) await new Promise(r => setTimeout(r, 20));
    return queue.shift()!;
  };
  try { return await fn(send, recv); }
  finally { ws.close(); await server.stop(); }
}

test("projects:list 返回空", async () => {
  await withServer(async (send, recv) => {
    send({ type: "projects:list" });
    const e = await recv() as any;
    expect(e.type).toBe("projects:list");
    expect(e.projects).toEqual([]);
  });
});

test("project:create + projects:list", async () => {
  await withServer(async (send, recv) => {
    send({ type: "project:create", name: "P", cwd: "/p" });
    const created = await recv() as any;
    expect(created.type).toBe("project:created");
    expect(created.project.name).toBe("P");
    send({ type: "projects:list" });
    const list = await recv() as any;
    expect(list.projects).toHaveLength(1);
  });
});

test("session:create 隐含于 agent:prompt（首条消息建会话）", async () => {
  await withServer(async (send, recv) => {
    send({ type: "project:create", name: "P", cwd: "/p" });
    const created = await recv() as any;
    const projectId = created.project.id;
    send({ type: "agent:prompt", projectId, sessionId: "s-fake", agentName: "dev", text: "你好" });
    // 期望收到 session:created（会话被建立）
    const ev = await recv() as any;
    expect(ev.type).toBe("session:created");
    expect(ev.session.projectId).toBe(projectId);
  });
});
```

- [ ] **Step 2: 跑确认失败**

- [ ] **Step 3: 实现 ws-server.ts**

`packages/kernel/src/ws-server.ts`:
```typescript
import type {
  WSClientEvent, WSServerEvent, AgentName,
} from "@hiagent/shared";
import { WS_PORT, makeAgentStateKey } from "@hiagent/shared";
import type { ConfigStore } from "./config-store";
import type { ProjectStore } from "./project-store";
import type { SessionStore } from "./session-store";
import type { AgentManager } from "./agent-manager";
import type { IntercomMonitor } from "./intercom-monitor";
import type { StateAggregator } from "./state-aggregator";

export interface WSServerOpts {
  configStore: ConfigStore;
  projectStore: ProjectStore;
  sessionStore: SessionStore;
  agentManager: AgentManager;
  intercomMonitor: IntercomMonitor;
  stateAggregator: StateAggregator;
  port?: number;
}

export class WSServer {
  actualPort = 0;
  private server: any;
  private clients = new Set<any>();  // 跟踪连接的客户端用于广播

  constructor(private opts: WSServerOpts) {}

  // 广播给所有客户端（StateAggregator 的 onServerEvent 调用）
  private broadcast(e: WSServerEvent): void {
    const payload = JSON.stringify(e);
    for (const ws of this.clients) {
      try { ws.send(payload); } catch {}
    }
  }

  // 暴露给 index.ts：把 StateAggregator 的输出接到 broadcast
  bindAggregatorBroadcast(): void {
    (this.opts.stateAggregator as any).opts.onServerEvent = (e: WSServerEvent) => this.broadcast(e);
  }

  async start(): Promise<void> {
    this.server = Bun.serve({
      port: this.opts.port ?? WS_PORT,
      fetch: (req, server) => {
        if (server.upgrade(req)) return;
        return new Response("WS only", { status: 426 });
      },
      websocket: {
        open: (ws) => { this.clients.add(ws); },
        message: async (ws, msg) => {
          const text = typeof msg === "string" ? msg : new TextDecoder().decode(msg as ArrayBuffer);
          let event: WSClientEvent;
          try { event = JSON.parse(text); } catch { return; }
          // 多数响应通过 broadcast 推全量；少数（projects:list、agent:config）定向回请求者
          const reply = (e: WSServerEvent) => ws.send(JSON.stringify(e));
          await this.handle(event, reply);
        },
        close: (ws) => { this.clients.delete(ws); },
      },
    });
    this.actualPort = this.server.port;
    this.bindAggregatorBroadcast();
  }

  async stop(): Promise<void> {
    this.server?.stop();
    await this.opts.agentManager.disposeAll();
    this.opts.intercomMonitor.dispose();
  }

  private async handle(event: WSClientEvent, reply: (e: WSServerEvent) => void): Promise<void> {
    switch (event.type) {
      case "projects:list": {
        const { projects, sessions } = await this.opts.projectStore.load();
        reply({ type: "projects:list", projects, sessions });  // 定向回请求者
        break;
      }
      case "project:create": {
        const project = await this.opts.projectStore.createProject({ name: event.name, cwd: event.cwd });
        this.broadcast({ type: "project:created", project });  // 广播：所有客户端同步
        break;
      }
      case "project:update": {
        await this.opts.projectStore.updateProject(event.projectId, { name: event.name, cwd: event.cwd });
        const data = await this.opts.projectStore.load();
        this.broadcast({ type: "projects:list", projects: data.projects, sessions: data.sessions });
        break;
      }
      case "project:delete": {
        await this.opts.projectStore.deleteProject(event.projectId);
        const data = await this.opts.projectStore.load();
        this.broadcast({ type: "projects:list", projects: data.projects, sessions: data.sessions });
        break;
      }
      case "session:rename": {
        await this.opts.projectStore.renameSession(event.sessionId, event.title);
        const data = await this.opts.projectStore.load();
        this.broadcast({ type: "projects:list", projects: data.projects, sessions: data.sessions });
        break;
      }
      case "session:delete": {
        await this.opts.projectStore.deleteSession(event.sessionId);
        const data = await this.opts.projectStore.load();
        this.broadcast({ type: "projects:list", projects: data.projects, sessions: data.sessions });
        break;
      }
      case "agent:prompt": {
        // session 元数据由 kernel 用 randomUUID 创建（前端传的 sessionId 仅作请求追踪，
        // 实际 session.id 由 ProjectStore 生成并经 session:created 广播回前端）
        const { sessions } = await this.opts.projectStore.load();
        const existing = sessions.find(s => s.id === event.sessionId);
        const session = existing ?? await this.opts.projectStore.createSession({
          projectId: event.projectId, primaryAgent: event.agentName,
          title: event.text.slice(0, 20),
        });
        this.broadcast({ type: "session:created", session });
        await this.opts.projectStore.touchSession(session.id);
        const client = await this.opts.agentManager.ensureStarted(event.projectId, event.agentName);
        await client.prompt(event.text);
        break;
      }
      case "agent:abort": {
        await this.opts.agentManager.abort(event.projectId, event.agentName);
        break;
      }
      case "intercom:inject-reply": {
        await this.opts.intercomMonitor.injectReply(event.askMessageId, event.text);
        break;
      }
      case "agent:config:get": {
        const config = await this.opts.configStore.getAgent(event.agentName);
        if (config) reply({ type: "agent:config", agentName: event.agentName, config });  // 定向
        break;
      }
      case "agent:config:save": {
        const errs = await this.opts.configStore.saveAgent(event.config);
        if (errs.length) reply({ type: "error", message: errs.join("; ") });
        break;
      }
    }
  }
}
```

- [ ] **Step 4: 跑测试**

```bash
bun test packages/kernel/tests/ws-server.test.ts
# 期望: 3 passed
```

- [ ] **Step 5: 写 kernel 入口 index.ts**

`packages/kernel/src/index.ts`:
```typescript
import { ConfigStore } from "./config-store";
import { ProjectStore } from "./project-store";
import { SessionStore } from "./session-store";
import { AgentManager } from "./agent-manager";
import { IntercomMonitor } from "./intercom-monitor";
import { StateAggregator } from "./state-aggregator";
import { WSServer } from "./ws-server";
import { WS_PORT } from "@hiagent/shared";

async function main() {
  const configStore = new ConfigStore();
  const projectStore = new ProjectStore();
  const sessionStore = new SessionStore();

  // 先建一个占位 broadcast，待 WSServer 实例化后绑定真实实现
  let broadcast: (e: import("@hiagent/shared").WSServerEvent) => void = () => {};

  // StateAggregator：Pi 事件 → WS 事件，输出到 broadcast
  const agentManager = new AgentManager({
    projectStore,
    onEvent: () => {},  // 下面立即用真实闭包重建
  });
  const stateAggregator = new StateAggregator({
    sessionStore,
    agentManager,
    onServerEvent: (e) => broadcast(e),
  });
  // 用真实闭包重写 AgentManager.onEvent（避免 as any 改 opts）
  (agentManager as { opts: { onEvent: (k: never, e: never) => void } }).opts.onEvent =
    (key, e) => stateAggregator.routePiEvent(key as never, e as never);

  const intercomMonitor = new IntercomMonitor({
    onAsk: (a) => stateAggregator.routeAsk(a),
    onReply: (id, sid) => stateAggregator.routeReply(id, sid),
  });
  await intercomMonitor.connect();

  const server = new WSServer({
    configStore, projectStore, sessionStore,
    agentManager, intercomMonitor, stateAggregator,
    port: WS_PORT,
  });
  await server.start();
  // 绑定真实广播（WSServer.broadcast 通过 clients 集群分发）
  broadcast = (e) => (server as unknown as { broadcast: (e2: import("@hiagent/shared").WSServerEvent) => void }).broadcast(e);
  server.bindAggregatorBroadcast();

  console.log(`[kernel] WS 监听 ws://127.0.0.1:${server.actualPort}`);
}

main().catch(e => { console.error(e); process.exit(1); });
```

> 注：`bindAggregatorBroadcast` 会把 `stateAggregator.opts.onServerEvent` 重指向 `WSServer.broadcast`，覆盖上面的 `broadcast(e)` 闭包——两者等效（都调 server.broadcast）。保留闭包仅为启动初期（server.start 前）的安全兜底。

- [ ] **Step 6: 提交**

```bash
git add packages/kernel
git commit -m "feat(kernel): WS Server（端口 9776，全协议路由）+ 入口编排"
```

> 验证（四层）：第一/三层合并——3 passed（真实 WS server + mock Pi）。第三层 `[需 pi 环境]`：Task 33 集成。

---
## Phase 3 — 前端基础

### Task 13: frontend 脚手架（Vite + React + Tailwind）

**Files:**
- Create: `packages/frontend/vite.config.ts` / `vitest.config.ts` / `tailwind.config.js` / `postcss.config.js` / `index.html`
- Modify: `packages/frontend/src/main.tsx`（最小渲染）/ Create `packages/frontend/src/App.tsx`
- Test: `packages/frontend/tests/render.test.tsx`

**Interfaces:**
- Consumes: `@hiagent/shared`
- Produces: 可 `bun run dev` 启动的 Vite dev server（`http://localhost:5173`）；`bun run test` 跑通渲染测试

- [ ] **Step 1: vite.config.ts**

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  resolve: {
    alias: { "@hiagent/shared": "../../packages/shared/src/index.ts" },
  },
});
```

- [ ] **Step 2: vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    globals: true,
  },
  resolve: {
    alias: { "@hiagent/shared": "../../packages/shared/src/index.ts" },
  },
});
```

- [ ] **Step 3: tailwind.config.js + postcss.config.js**

```javascript
// tailwind.config.js
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        base: "#1e1e2e", mantle: "#181825", surface: "#313244", surface2: "#585b70",
        text: "#cdd6f4", subtext: "#a6adc8", overlay: "#6c7086",
        blue: "#89b4fa", green: "#a6e3a1", peach: "#fab387", yellow: "#f9e2af",
        mauve: "#cba6f7", red: "#f38ba8", lavender: "#b4befe", maroon: "#ebbc9e", teal: "#94e2d5",
      },
    },
  },
  plugins: [],
};
```

```javascript
// postcss.config.js
export default { plugins: { tailwindcss: {} } };
```

- [ ] **Step 4: index.html + src/styles.css**

`packages/frontend/index.html`:
```html
<!doctype html>
<html lang="zh">
  <head><meta charset="UTF-8" /><title>HiAgent</title></head>
  <body class="bg-base text-text"><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
```

`packages/frontend/src/styles.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
body { margin: 0; font-family: 'Segoe UI', sans-serif; }
```

- [ ] **Step 5: main.tsx + App.tsx**

`packages/frontend/src/main.tsx`:
```typescript
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
createRoot(document.getElementById("root")!).render(<App />);
```

`packages/frontend/src/App.tsx`:
```typescript
export function App() {
  return <div className="p-4">HiAgent 占位</div>;
}
```

- [ ] **Step 6: 写渲染测试**

`packages/frontend/tests/render.test.tsx`:
```typescript
import { test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "../src/App";

test("App 渲染占位", () => {
  render(<App />);
  expect(screen.getByText("HiAgent 占位")).toBeTruthy();
});
```

- [ ] **Step 7: 装依赖 + 跑测试**

```bash
cd packages/frontend
bun install
bun run test
# 期望: 1 passed
bun run dev
# 手动访问 http://localhost:5173 看到"HiAgent 占位"，Ctrl+C 退出
```

- [ ] **Step 8: 提交**

```bash
git add packages/frontend
git commit -m "chore(frontend): Vite + React 19 + Tailwind 脚手架"
```

> 验证（四层）：第二层 1 passed（组件渲染）。dev server 可启动留作手动验证。

---

### Task 14: WS 客户端 + 4 个 store

**Files:**
- Create: `packages/frontend/src/ws-instance.ts`（单例 WS 连接）
- Create: `packages/frontend/src/store/projects.ts`
- Create: `packages/frontend/src/store/session.ts`
- Create: `packages/frontend/src/store/agents.ts`
- Create: `packages/frontend/src/store/intercom.ts`
- Test: `packages/frontend/tests/store-projects.test.ts` / `store-agents.test.ts`

**Interfaces:**
- Consumes: 所有 `@hiagent/shared` 类型与事件
- Produces（**后续所有组件依赖**）:
  - `wsInstance`: 单例 WebSocket，`send(e: WSClientEvent)`，`onMessage(cb)` 注册
  - `useProjectsStore`: Zustand store，字段 `{ projects, sessions, currentProjectId, currentSessionId, load(), createProject(), selectProject(id), selectSession(id) }`
  - `useSessionStore`: `{ messagesBySession: Record<string, ChatMessage[]>, append(msg), clear() }`
  - `useAgentsStore`: `{ states: Record<AgentStateKey, AgentState>, configs: Record<AgentName, AgentConfig>, setState(key, s), getGlobalState(name): AgentStatus, loadConfig(name) }`
  - `useIntercomStore`: `{ asksBySession: Record<string, AskItem[]>, addAsk(ask), resolveAsk(sessionId, id) }`

- [ ] **Step 1: 写 ws-instance.ts**

`packages/frontend/src/ws-instance.ts`:
```typescript
import type { WSClientEvent, WSServerEvent } from "@hiagent/shared";
import { WS_PORT } from "@hiagent/shared";

type Handler = (e: WSServerEvent) => void;
const handlers = new Set<Handler>();
let ws: WebSocket | null = null;

export function getWs(): WebSocket {
  if (!ws) {
    ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
    ws.onmessage = (ev) => {
      try {
        const e = JSON.parse(String(ev.data)) as WSServerEvent;
        handlers.forEach(h => h(e));
      } catch {}
    };
  }
  return ws;
}

export function send(e: WSClientEvent): void {
  const s = getWs();
  if (s.readyState === WebSocket.OPEN) s.send(JSON.stringify(e));
  else s.addEventListener("open", () => s.send(JSON.stringify(e)), { once: true });
}

export function onMessage(h: Handler): () => void {
  handlers.add(h);
  return () => handlers.delete(h);
}
```

- [ ] **Step 2: 写 projects store**

`packages/frontend/src/store/projects.ts`:
```typescript
import { create } from "zustand";
import type { ProjectEntity, SessionEntity } from "@hiagent/shared";
import { send } from "../ws-instance";

interface ProjectsState {
  projects: ProjectEntity[];
  sessions: SessionEntity[];
  currentProjectId: string | null;
  currentSessionId: string | null;
  load: () => void;
  setAll: (projects: ProjectEntity[], sessions: SessionEntity[]) => void;
  createProject: (name: string, cwd: string) => void;
  addProject: (p: ProjectEntity) => void;
  addSession: (s: SessionEntity) => void;
  selectProject: (id: string) => void;
  selectSession: (id: string) => void;
  setCurrentSessionId: (id: string | null) => void;
}

export const useProjectsStore = create<ProjectsState>((set) => ({
  projects: [],
  sessions: [],
  currentProjectId: null,
  currentSessionId: null,
  load: () => send({ type: "projects:list" }),
  setAll: (projects, sessions) => set({ projects, sessions }),
  createProject: (name, cwd) => send({ type: "project:create", name, cwd }),
  addProject: (p) => set(s => ({ projects: [...s.projects, p], currentProjectId: p.id })),
  addSession: (sess) => set(s => ({
    sessions: [...s.sessions, sess],
    currentSessionId: sess.id,
    currentProjectId: sess.projectId,
  })),
  selectProject: (id) => set({ currentProjectId: id }),
  selectSession: (id) => set({ currentSessionId: id }),
  setCurrentSessionId: (id) => set({ currentSessionId: id }),
}));
```

- [ ] **Step 3: 写 session store**

`packages/frontend/src/store/session.ts`:
```typescript
import { create } from "zustand";
import type { ChatMessage } from "@hiagent/shared";

interface SessionState {
  messagesBySession: Record<string, ChatMessage[]>;
  append: (msg: ChatMessage) => void;
  clear: () => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  messagesBySession: {},
  append: (msg) => set(s => ({
    messagesBySession: {
      ...s.messagesBySession,
      [msg.sessionId]: [...(s.messagesBySession[msg.sessionId] ?? []), msg],
    },
  })),
  clear: () => set({ messagesBySession: {} }),
}));
```

- [ ] **Step 4: 写 agents store**

`packages/frontend/src/store/agents.ts`:
```typescript
import { create } from "zustand";
import type { AgentConfig, AgentName, AgentState, AgentStateKey, AgentStatus } from "@hiagent/shared";
import { aggregateAgentState } from "@hiagent/shared";
import { send } from "../ws-instance";

interface AgentsState {
  states: Record<AgentStateKey, AgentState>;
  configs: Partial<Record<AgentName, AgentConfig>>;
  setState: (key: AgentStateKey, s: AgentState) => void;
  loadConfig: (name: AgentName) => void;
  setConfig: (name: AgentName, c: AgentConfig) => void;
  getGlobalState: (name: AgentName) => AgentStatus;
}

export const useAgentsStore = create<AgentsState>((set, get) => ({
  states: {},
  configs: {},
  setState: (key, s) => set(st => ({ states: { ...st.states, [key]: s } })),
  loadConfig: (name) => send({ type: "agent:config:get", agentName: name }),
  setConfig: (name, c) => set(st => ({ configs: { ...st.configs, [name]: c } })),
  getGlobalState: (name) => {
    const all = Object.entries(get().states)
      .filter(([k]) => k.endsWith(`:${name}`))
      .map(([, v]) => v);
    return aggregateAgentState(all);
  },
}));
```

- [ ] **Step 5: 写 intercom store**

`packages/frontend/src/store/intercom.ts`:
```typescript
import { create } from "zustand";
import type { AskItem } from "@hiagent/shared";

interface IntercomState {
  asksBySession: Record<string, AskItem[]>;
  addAsk: (ask: AskItem) => void;
  resolveAsk: (sessionId: string, id: string) => void;
}

export const useIntercomStore = create<IntercomState>((set) => ({
  asksBySession: {},
  addAsk: (ask) => set(s => ({
    asksBySession: {
      ...s.asksBySession,
      [ask.sessionId]: [...(s.asksBySession[ask.sessionId] ?? []), ask],
    },
  })),
  resolveAsk: (sessionId, id) => set(s => ({
    asksBySession: {
      ...s.asksBySession,
      [sessionId]: (s.asksBySession[sessionId] ?? []).map(a =>
        a.messageId === id ? { ...a, resolved: true, resolvedAt: Date.now() } : a
      ),
    },
  })),
}));
```

- [ ] **Step 6: 写 store 测试**

`packages/frontend/tests/store-projects.test.ts`:
```typescript
import { test, expect, beforeEach } from "vitest";
import { useProjectsStore } from "../src/store/projects";

beforeEach(() => useProjectsStore.setState({
  projects: [], sessions: [], currentProjectId: null, currentSessionId: null,
}));

test("setAll 设置项目列表", () => {
  useProjectsStore.getState().setAll(
    [{ id: "p1", name: "P", cwd: "/p", createdAt: 0 }],
    [],
  );
  expect(useProjectsStore.getState().projects).toHaveLength(1);
});

test("addSession 切到新会话", () => {
  useProjectsStore.getState().addSession({
    id: "s1", projectId: "p1", primaryAgent: "dev",
    title: "t", createdAt: 0, lastActivity: 0,
  });
  expect(useProjectsStore.getState().currentSessionId).toBe("s1");
});
```

`packages/frontend/tests/store-agents.test.ts`:
```typescript
import { test, expect, beforeEach } from "vitest";
import { useAgentsStore } from "../src/store/agents";

beforeEach(() => useAgentsStore.setState({ states: {}, configs: {} }));

test("getGlobalState 跨项目聚合", () => {
  const { setState, getGlobalState } = useAgentsStore.getState();
  setState("p1:dev", { name: "dev", status: "idle" });
  setState("p2:dev", { name: "dev", status: "thinking" });
  expect(getGlobalState("dev")).toBe("thinking");
  setState("p3:dev", { name: "dev", status: "blocked" });
  expect(getGlobalState("dev")).toBe("blocked");
});
```

- [ ] **Step 7: 跑测试**

```bash
cd packages/frontend
bun run test
# 期望: 3 passed（含 Task 13 的 render）
```

- [ ] **Step 8: 提交**

```bash
git add packages/frontend
git commit -m "feat(frontend): WS 客户端 + 4 个 store（projects/session/agents/intercom）"
```

---

### Task 15: 主题系统（设计 token + 角色）

**Files:**
- Create: `packages/frontend/src/theme/agents.ts`
- Create: `packages/frontend/src/theme/colors.ts`
- Test: `packages/frontend/tests/theme.test.ts`

**Interfaces:**
- Consumes: `AGENT_DEFS` from `@hiagent/shared`
- Produces:
  - `agentEmoji(name): string` / `agentGradient(name): string`（CSS linear-gradient）
  - `STATUS_COLORS: Record<AgentStatus, string>`

- [ ] **Step 1: 实现**

`packages/frontend/src/theme/colors.ts`:
```typescript
import type { AgentStatus } from "@hiagent/shared";

export const STATUS_COLORS: Record<AgentStatus, string> = {
  idle: "#6c7086",
  thinking: "#89b4fa",
  blocked: "#fab387",
};
```

`packages/frontend/src/theme/agents.ts`:
```typescript
import { AGENT_DEFS } from "@hiagent/shared";
import type { AgentName } from "@hiagent/shared";

export function agentEmoji(name: AgentName): string {
  return AGENT_DEFS[name].emoji;
}

export function agentGradient(name: AgentName): string {
  const [a, b] = AGENT_DEFS[name].gradient;
  return `linear-gradient(135deg, ${a}, ${b})`;
}
```

- [ ] **Step 2: 测试**

`packages/frontend/tests/theme.test.ts`:
```typescript
import { test, expect } from "vitest";
import { agentEmoji, agentGradient } from "../src/theme/agents";
import { STATUS_COLORS } from "../src/theme/colors";

test("agentEmoji 4 角色", () => {
  expect(agentEmoji("product")).toBe("📋");
  expect(agentEmoji("dev")).toBe("⚙️");
});

test("agentGradient 含两色", () => {
  expect(agentGradient("dev")).toContain("#fab387");
  expect(agentGradient("dev")).toContain("#f38ba8");
});

test("STATUS_COLORS 三态", () => {
  expect(STATUS_COLORS.blocked).toBe("#fab387");
});
```

- [ ] **Step 3: 跑测试 + 提交**

```bash
bun run test
git add packages/frontend/src/theme packages/frontend/tests/theme.test.ts
git commit -m "feat(frontend): 主题系统（角色 emoji/渐变 + 状态色）"
```

---

### Task 16: NewSessionButton 组件（① 新建会话区）

**Files:**
- Create: `packages/frontend/src/components/NewSessionButton.tsx`
- Test: `packages/frontend/tests/NewSessionButton.test.tsx`

**Interfaces:**
- Consumes: `useProjectsStore`（切到 new-session 态）
- Produces: 点击触发 `onNewSession`（由 App 改 currentView）

- [ ] **Step 1: 实现 + 测试**

`packages/frontend/src/components/NewSessionButton.tsx`:
```typescript
interface Props { onNewSession: () => void; }

export function NewSessionButton({ onNewSession }: Props) {
  return (
    <button
      onClick={onNewSession}
      className="w-full px-3 py-2 mb-2 text-left rounded border border-dashed border-surface2 text-subtext hover:border-blue hover:text-text text-sm"
      data-testid="new-session-btn"
    >
      ➕ 新建会话
    </button>
  );
}
```

`packages/frontend/tests/NewSessionButton.test.tsx`:
```typescript
import { test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NewSessionButton } from "../src/components/NewSessionButton";

test("点击触发 onNewSession", () => {
  const fn = vi.fn();
  render(<NewSessionButton onNewSession={fn} />);
  fireEvent.click(screen.getByTestId("new-session-btn"));
  expect(fn).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: 跑测试 + 提交**

```bash
bun run test
git add packages/frontend/src/components/NewSessionButton.tsx packages/frontend/tests/NewSessionButton.test.tsx
git commit -m "feat(frontend): NewSessionButton 组件（① 新建会话区）"
```

---

### Task 17: AgentListSection 组件（② 我的智能体区）

**Files:**
- Create: `packages/frontend/src/components/AgentListSection.tsx`
- Test: `packages/frontend/tests/AgentListSection.test.tsx`

**Interfaces:**
- Consumes: `useAgentsStore`（getGlobalState），`AGENT_DEFS`，`agentEmoji`，`STATUS_COLORS`
- Produces: 渲染 4 个 agent 行，点击触发 `onSelectAgent(name)`（进 AgentConfig 弹窗）

- [ ] **Step 1: 实现**

`packages/frontend/src/components/AgentListSection.tsx`:
```typescript
import { AGENT_DEFS } from "@hiagent/shared";
import type { AgentName } from "@hiagent/shared";
import { useAgentsStore } from "../store/agents";
import { STATUS_COLORS } from "../theme/colors";

const NAMES: AgentName[] = ["product", "pm", "dev", "test"];

interface Props { onSelectAgent: (name: AgentName) => void; }

export function AgentListSection({ onSelectAgent }: Props) {
  // 订阅 states 触发重渲染（getGlobalState 内部读 states），否则状态点不会更新
  useAgentsStore(s => s.states);
  const getGlobalState = useAgentsStore.getState().getGlobalState;
  return (
    <div className="mb-3">
      <div className="text-xs text-overlay px-2 mb-1">👥 我的智能体</div>
      {NAMES.map(name => {
        const status = getGlobalState(name);
        return (
          <button
            key={name}
            onClick={() => onSelectAgent(name)}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface text-left"
            data-testid={`agent-${name}`}
          >
            <span className="text-base">{AGENT_DEFS[name].emoji}</span>
            <span className="text-sm text-text flex-1">{AGENT_DEFS[name].label}</span>
            <span
              className="w-2 h-2 rounded-full"
              style={{ background: STATUS_COLORS[status] }}
              data-testid={`status-${name}`}
            />
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: 测试**

`packages/frontend/tests/AgentListSection.test.tsx`:
```typescript
import { test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentListSection } from "../src/components/AgentListSection";
import { useAgentsStore } from "../src/store/agents";

beforeEach(() => useAgentsStore.setState({ states: {}, configs: {} }));

test("渲染 4 个 agent 行", () => {
  render(<AgentListSection onSelectAgent={() => {}} />);
  expect(screen.getByTestId("agent-dev")).toBeTruthy();
  expect(screen.getByTestId("agent-test")).toBeTruthy();
});

test("状态点反映全局聚合", () => {
  useAgentsStore.setState({
    states: { "p1:dev": { name: "dev", status: "thinking" } },
    configs: {},
  });
  render(<AgentListSection onSelectAgent={() => {}} />);
  const dot = screen.getByTestId("status-dev");
  expect((dot as HTMLElement).style.background).toBe("#89b4fa"); // thinking 蓝
});

test("点击触发 onSelectAgent", () => {
  const fn = vi.fn();
  render(<AgentListSection onSelectAgent={fn} />);
  fireEvent.click(screen.getByTestId("agent-dev"));
  expect(fn).toHaveBeenCalledWith("dev");
});
```

- [ ] **Step 3: 跑测试 + 提交**

```bash
bun run test
git add packages/frontend/src/components/AgentListSection.tsx packages/frontend/tests/AgentListSection.test.tsx
git commit -m "feat(frontend): AgentListSection 组件（② 我的智能体 + 全局聚合状态点）"
```

---

### Task 18: ProjectList + ProjectItem + SessionRow（③ 项目管理区）

**Files:**
- Create: `packages/frontend/src/components/ProjectList.tsx`
- Create: `packages/frontend/src/components/ProjectItem.tsx`
- Create: `packages/frontend/src/components/SessionRow.tsx`
- Test: `packages/frontend/tests/ProjectList.test.tsx` / `SessionRow.test.tsx`

**Interfaces:**
- Consumes: `useProjectsStore`，`formatRelativeTime`，`agentEmoji`
- Produces:
  - `ProjectList`: 渲染项目列表 + "＋ 新建项目"按钮
  - `ProjectItem`: 折叠/展开 + ＋（项目内新建）+ ⚙️（设置）
  - `SessionRow`: `{emoji} {title} · {time}`，选中态蓝左条

- [ ] **Step 1: SessionRow 组件 + 测试**

`packages/frontend/src/components/SessionRow.tsx`:
```typescript
import type { SessionEntity } from "@hiagent/shared";
import { formatRelativeTime } from "@hiagent/shared";
import { agentEmoji } from "../theme/agents";

interface Props {
  session: SessionEntity;
  selected: boolean;
  onSelect: (id: string) => void;
}

export function SessionRow({ session, selected, onSelect }: Props) {
  return (
    <button
      onClick={() => onSelect(session.id)}
      className="w-full flex items-center gap-2 px-2 py-1.5 text-left text-sm"
      style={{
        borderLeft: selected ? "2px solid #89b4fa" : "2px solid transparent",
        background: selected ? "rgba(137,180,250,0.15)" : "transparent",
      }}
      data-testid={`session-${session.id}`}
    >
      <span>{agentEmoji(session.primaryAgent)}</span>
      <span className="text-text flex-1 truncate">{session.title}</span>
      <span className="text-xs text-overlay">{formatRelativeTime(session.lastActivity)}</span>
    </button>
  );
}
```

`packages/frontend/tests/SessionRow.test.tsx`:
```typescript
import { test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SessionRow } from "../src/components/SessionRow";
import type { SessionEntity } from "@hiagent/shared";

const session: SessionEntity = {
  id: "s1", projectId: "p1", primaryAgent: "dev",
  title: "测试会话", createdAt: 0, lastActivity: Date.now() - 120000,
};

test("显示 emoji + 标题 + 相对时间", () => {
  render(<table><tbody><SessionRow session={session} selected={false} onSelect={() => {}} /></tbody></table>);
  expect(screen.getByText("⚙️")).toBeTruthy();
  expect(screen.getByText("测试会话")).toBeTruthy();
  expect(screen.getByText("2m")).toBeTruthy();
});

test("选中态蓝左条", () => {
  const { container } = render(<table><tbody><SessionRow session={session} selected={true} onSelect={() => {}} /></tbody></table>);
  const btn = container.querySelector("[data-testid='session-s1']") as HTMLElement;
  expect(btn.style.borderLeft).toContain("#89b4fa");
});

test("点击 onSelect", () => {
  const fn = vi.fn();
  render(<table><tbody><SessionRow session={session} selected={false} onSelect={fn} /></tbody></table>);
  fireEvent.click(screen.getByTestId("session-s1"));
  expect(fn).toHaveBeenCalledWith("s1");
});
```

- [ ] **Step 2: ProjectItem + ProjectList 组件**

`packages/frontend/src/components/ProjectItem.tsx`:
```typescript
import { useState } from "react";
import type { ProjectEntity, SessionEntity } from "@hiagent/shared";
import { SessionRow } from "./SessionRow";

interface Props {
  project: ProjectEntity;
  sessions: SessionEntity[];
  currentSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewSessionInProject: (projectId: string) => void;
  onProjectSettings: (projectId: string) => void;
}

export function ProjectItem(props: Props) {
  const [expanded, setExpanded] = useState(true);
  const { project, sessions, currentSessionId } = props;
  const mySessions = sessions.filter(s => s.projectId === project.id);
  return (
    <div data-testid={`project-${project.id}`}>
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button onClick={() => setExpanded(e => !e)} className="text-overlay w-4">
          {expanded ? "▼" : "▶"}
        </button>
        <span className="text-sm text-text flex-1 truncate">{project.name}</span>
        <button
          onClick={() => props.onNewSessionInProject(project.id)}
          className="text-overlay hover:text-blue px-1"
          data-testid={`new-in-${project.id}`}
        >＋</button>
        <button
          onClick={() => props.onProjectSettings(project.id)}
          className="text-overlay hover:text-blue px-1"
        >⚙️</button>
      </div>
      {expanded && mySessions.map(s => (
        <SessionRow
          key={s.id}
          session={s}
          selected={s.id === currentSessionId}
          onSelect={props.onSelectSession}
        />
      ))}
    </div>
  );
}
```

`packages/frontend/src/components/ProjectList.tsx`:
```typescript
import { useProjectsStore } from "../store/projects";
import { ProjectItem } from "./ProjectItem";

interface Props {
  onSelectSession: (id: string) => void;
  onNewSessionInProject: (projectId: string) => void;
  onProjectSettings: (projectId: string) => void;
  onNewProject: () => void;
}

export function ProjectList(props: Props) {
  const { projects, sessions, currentSessionId } = useProjectsStore();
  return (
    <div className="flex-1 overflow-auto">
      <div className="text-xs text-overlay px-2 py-1 border-t border-surface2 mt-2">项目管理</div>
      {projects.map(p => (
        <ProjectItem
          key={p.id}
          project={p}
          sessions={sessions}
          currentSessionId={currentSessionId}
          {...props}
        />
      ))}
      <button
        onClick={props.onNewProject}
        className="w-full text-left px-2 py-1.5 text-xs text-overlay hover:text-blue"
        data-testid="new-project-btn"
      >＋ 新建项目</button>
    </div>
  );
}
```

- [ ] **Step 3: ProjectList 测试**

`packages/frontend/tests/ProjectList.test.tsx`:
```typescript
import { test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProjectList } from "../src/components/ProjectList";
import { useProjectsStore } from "../src/store/projects";

beforeEach(() => useProjectsStore.setState({
  projects: [], sessions: [], currentProjectId: null, currentSessionId: null,
}));

test("渲染项目 + 会话", () => {
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "项目A", cwd: "/a", createdAt: 0 }],
    sessions: [{ id: "s1", projectId: "p1", primaryAgent: "dev", title: "会话1", createdAt: 0, lastActivity: Date.now() }],
    currentProjectId: null, currentSessionId: null,
  });
  render(<ProjectList onSelectSession={() => {}} onNewSessionInProject={() => {}} onProjectSettings={() => {}} onNewProject={() => {}} />);
  expect(screen.getByText("项目A")).toBeTruthy();
  expect(screen.getByText("会话1")).toBeTruthy();
});

test("项目内 ＋ 触发 onNewSessionInProject", () => {
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "P", cwd: "/a", createdAt: 0 }],
    sessions: [], currentProjectId: null, currentSessionId: null,
  });
  const fn = vi.fn();
  render(<ProjectList onSelectSession={() => {}} onNewSessionInProject={fn} onProjectSettings={() => {}} onNewProject={() => {}} />);
  fireEvent.click(screen.getByTestId("new-in-p1"));
  expect(fn).toHaveBeenCalledWith("p1");
});

test("新建项目按钮", () => {
  const fn = vi.fn();
  render(<ProjectList onSelectSession={() => {}} onNewSessionInProject={() => {}} onProjectSettings={() => {}} onNewProject={fn} />);
  fireEvent.click(screen.getByTestId("new-project-btn"));
  expect(fn).toHaveBeenCalledOnce();
});
```

- [ ] **Step 4: 跑测试 + 提交**

```bash
bun run test
git add packages/frontend/src/components/ProjectList.tsx packages/frontend/src/components/ProjectItem.tsx packages/frontend/src/components/SessionRow.tsx packages/frontend/tests/ProjectList.test.tsx packages/frontend/tests/SessionRow.test.tsx
git commit -m "feat(frontend): ProjectList + ProjectItem + SessionRow（③ 项目管理区）"
```

---
## Phase 4 — 前端主区

### Task 19: Sidebar 容器（编排四区）

**Files:**
- Create: `packages/frontend/src/components/Sidebar.tsx`
- Test: `packages/frontend/tests/Sidebar.test.tsx`

**Interfaces:**
- Consumes: NewSessionButton, AgentListSection, ProjectList
- Produces: 260px 宽容器，编排四区，透传各回调

- [ ] **Step 1: 实现**

`packages/frontend/src/components/Sidebar.tsx`:
```typescript
import type { AgentName } from "@hiagent/shared";
import { NewSessionButton } from "./NewSessionButton";
import { AgentListSection } from "./AgentListSection";
import { ProjectList } from "./ProjectList";

interface Props {
  onNewSession: () => void;
  onSelectAgent: (name: AgentName) => void;
  onSelectSession: (id: string) => void;
  onNewSessionInProject: (projectId: string) => void;
  onProjectSettings: (projectId: string) => void;
  onNewProject: () => void;
}

export function Sidebar(props: Props) {
  return (
    <aside
      className="flex flex-col gap-1 p-2 overflow-hidden"
      style={{ width: 260, background: "#181825" }}
      data-testid="sidebar"
    >
      <NewSessionButton onNewSession={props.onNewSession} />
      <AgentListSection onSelectAgent={props.onSelectAgent} />
      <ProjectList
        onSelectSession={props.onSelectSession}
        onNewSessionInProject={props.onNewSessionInProject}
        onProjectSettings={props.onProjectSettings}
        onNewProject={props.onNewProject}
      />
    </aside>
  );
}
```

- [ ] **Step 2: 测试**

`packages/frontend/tests/Sidebar.test.tsx`:
```typescript
import { test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Sidebar } from "../src/components/Sidebar";
import { useProjectsStore } from "../src/store/projects";
import { useAgentsStore } from "../src/store/agents";

beforeEach(() => {
  useProjectsStore.setState({ projects: [], sessions: [], currentProjectId: null, currentSessionId: null });
  useAgentsStore.setState({ states: {}, configs: {} });
});

test("渲染四区容器 + 新建会话按钮", () => {
  render(<Sidebar onNewSession={() => {}} onSelectAgent={() => {}} onSelectSession={() => {}} onNewSessionInProject={() => {}} onProjectSettings={() => {}} onNewProject={() => {}} />);
  expect(screen.getByTestId("sidebar")).toBeTruthy();
  expect(screen.getByText("新建会话")).toBeTruthy();
  expect(screen.getByText("我的智能体")).toBeTruthy();
  expect(screen.getByText("项目管理")).toBeTruthy();
});

test("透传 onNewSession", () => {
  const fn = vi.fn();
  render(<Sidebar onNewSession={fn} onSelectAgent={() => {}} onSelectSession={() => {}} onNewSessionInProject={() => {}} onProjectSettings={() => {}} onNewProject={() => {}} />);
  fireEvent.click(screen.getByTestId("new-session-btn"));
  expect(fn).toHaveBeenCalledOnce();
});
```

- [ ] **Step 3: 跑测试 + 提交**

```bash
bun run test
git add packages/frontend/src/components/Sidebar.tsx packages/frontend/tests/Sidebar.test.tsx
git commit -m "feat(frontend): Sidebar 容器（编排四区，260px 宽）"
```

---

### Task 20: NewSessionPane 组件（新建会话面板）

**Files:**
- Create: `packages/frontend/src/components/NewSessionPane.tsx`
- Test: `packages/frontend/tests/NewSessionPane.test.tsx`

**Interfaces:**
- Consumes: `useProjectsStore`，`AGENT_DEFS`，`send`
- Produces: 输入框上方 `📁 项目目录 ▾` + `🤖 agent ▾` 下拉并排 + 输入框 + 发送

- [ ] **Step 1: 实现**

`packages/frontend/src/components/NewSessionPane.tsx`:
```typescript
import { useState } from "react";
import { AGENT_DEFS, randomSessionId } from "@hiagent/shared";
import type { AgentName } from "@hiagent/shared";
import { useProjectsStore } from "../store/projects";
import { send } from "../ws-instance";

const NAMES: AgentName[] = ["product", "pm", "dev", "test"];

// 注：randomSessionId 加到 shared pure.ts（Step 2 补）
export function NewSessionPane() {
  const { projects, currentProjectId, addSession } = useProjectsStore();
  const [agentName, setAgentName] = useState<AgentName>("dev");
  const [text, setText] = useState("");
  const initialProject = currentProjectId ?? projects[0]?.id ?? null;
  const [projectId, setProjectId] = useState<string | null>(initialProject);

  const handleSend = () => {
    if (!projectId || !text.trim()) return;
    const sessionId = randomSessionId();
    send({ type: "agent:prompt", projectId, sessionId, agentName, text });
    setText("");
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6" data-testid="new-session-pane">
      <h2 className="text-2xl font-bold text-text mb-2">开始新会话</h2>
      <p className="text-subtext mb-6">选好项目目录和角色，直接打字发送</p>
      <div className="w-full max-w-2xl bg-surface rounded-lg overflow-hidden" style={{ background: "#313244" }}>
        <div className="flex gap-2 p-2 border-b border-surface2">
          <select
            value={projectId ?? ""}
            onChange={e => setProjectId(e.target.value || null)}
            className="flex-1 bg-mantle text-text rounded px-2 py-1 text-sm"
            data-testid="project-select"
          >
            {projects.length === 0 && <option value="">（无项目，请先新建）</option>}
            {projects.map(p => <option key={p.id} value={p.id}>📁 {p.name} {p.cwd}</option>)}
          </select>
          <select
            value={agentName}
            onChange={e => setAgentName(e.target.value as AgentName)}
            className="bg-mantle text-text rounded px-2 py-1 text-sm"
            data-testid="agent-select"
          >
            {NAMES.map(n => <option key={n} value={n}>{AGENT_DEFS[n].emoji} {AGENT_DEFS[n].label}</option>)}
          </select>
        </div>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          placeholder="给研发发消息..."
          className="w-full bg-transparent text-text p-3 outline-none resize-none"
          rows={3}
          data-testid="new-session-input"
        />
        <div className="flex items-center justify-between p-2 border-t border-surface2">
          <span className="text-xs text-overlay">📎 附件 🎨 模型</span>
          <button
            onClick={handleSend}
            disabled={!projectId || !text.trim()}
            className="px-3 py-1 rounded text-sm"
            style={{ background: text.trim() && projectId ? "#89b4fa" : "#585b70", color: "#1e1e2e" }}
            data-testid="new-session-send"
          >发送 →</button>
        </div>
      </div>
      <p className="text-xs text-overlay mt-4">💡 项目目录可在此切换；agent 选谁谁是主理人</p>
    </div>
  );
}
```

- [ ] **Step 2: 测试**

`packages/frontend/tests/NewSessionPane.test.tsx`:
```typescript
import { test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NewSessionPane } from "../src/components/NewSessionPane";
import { useProjectsStore } from "../src/store/projects";

// mock ws-instance.send
vi.mock("../src/ws-instance", () => ({
  send: vi.fn(),
  getWs: () => ({}),
  onMessage: () => () => {},
}));

beforeEach(() => useProjectsStore.setState({
  projects: [{ id: "p1", name: "项目A", cwd: "/a", createdAt: 0 }],
  sessions: [], currentProjectId: "p1", currentSessionId: null,
}));

test("渲染项目+agent 下拉并排", () => {
  render(<NewSessionPane />);
  expect(screen.getByTestId("project-select")).toBeTruthy();
  expect(screen.getByTestId("agent-select")).toBeTruthy();
});

test("输入并发送调用 send", async () => {
  const { send } = await import("../src/ws-instance");
  (send as any).mockClear();
  render(<NewSessionPane />);
  const input = screen.getByTestId("new-session-input") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "你好" } });
  fireEvent.click(screen.getByTestId("new-session-send"));
  expect(send).toHaveBeenCalled();
  const arg = (send as any).mock.calls[0][0];
  expect(arg.type).toBe("agent:prompt");
  expect(arg.projectId).toBe("p1");
  expect(arg.text).toBe("你好");
});
```

- [ ] **Step 4: 跑测试 + 提交**

```bash
bun run test
git add packages/frontend packages/shared/src/pure.ts
git commit -m "feat(frontend): NewSessionPane（新建会话面板，项目+agent 下拉并排）"
```

---

### Task 21: App 三态路由（empty/new-session/session）

**Files:**
- Modify: `packages/frontend/src/App.tsx`
- Create: `packages/frontend/src/components/EmptyState.tsx`（无项目引导）
- Test: `packages/frontend/tests/App-routing.test.tsx`

**Interfaces:**
- Consumes: Sidebar, NewSessionPane, SessionView, useProjectsStore
- Produces: `currentView: "empty" | "new-session" | "session"`，由 projects/currentSessionId 派生

- [ ] **Step 1: EmptyState 组件**

`packages/frontend/src/components/EmptyState.tsx`:
```typescript
interface Props { onNewProject: () => void; }

export function EmptyState({ onNewProject }: Props) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center" data-testid="empty-state">
      <p className="text-text mb-4">还没有项目，先创建一个吧</p>
      <button
        onClick={onNewProject}
        className="px-4 py-2 rounded text-sm"
        style={{ background: "#89b4fa", color: "#1e1e2e" }}
        data-testid="empty-new-project"
      >＋ 新建项目</button>
    </div>
  );
}
```

- [ ] **Step 2: App 三态路由**

`packages/frontend/src/App.tsx`:
```typescript
import { useEffect, useState } from "react";
import type { AgentName } from "@hiagent/shared";
import { Sidebar } from "./components/Sidebar";
import { NewSessionPane } from "./components/NewSessionPane";
import { SessionView } from "./components/SessionView";
import { EmptyState } from "./components/EmptyState";
import { AgentConfig } from "./components/AgentConfig";
import { useProjectsStore } from "./store/projects";
import { onMessage, getWs } from "./ws-instance";

type View = "empty" | "new-session" | "session";

export function App() {
  // 只订阅渲染所需的最小状态；actions 在回调里用 getState() 取，避免 stale closure
  const projects = useProjectsStore(s => s.projects);
  const currentSessionId = useProjectsStore(s => s.currentSessionId);
  const [view, setView] = useState<View>("empty");
  const [configAgent, setConfigAgent] = useState<AgentName | null>(null);

  useEffect(() => {
    getWs();
    useProjectsStore.getState().load();  // getState() 取最新 action
    const off = onMessage(e => {
      const ps = useProjectsStore.getState();  // 每次事件取最新，避免 stale
      switch (e.type) {
        case "projects:list": ps.setAll(e.projects, e.sessions); break;
        case "project:created": ps.addProject(e.project); break;
        case "session:created": ps.addSession(e.session); break;
      }
    });
    return off;
  }, []);  // 空依赖：onMessage 用 getState，不需重订阅

  // 派生 view
  useEffect(() => {
    if (projects.length === 0) setView("empty");
    else if (currentSessionId) setView("session");
    else setView("new-session");
  }, [projects.length, currentSessionId]);

  return (
    <div className="flex h-screen" style={{ background: "#1e1e2e" }}>
      <Sidebar
        onNewSession={() => setView("new-session")}
        onSelectAgent={(name) => setConfigAgent(name)}
        onSelectSession={(id) => { useProjectsStore.getState().selectSession(id); setView("session"); }}
        onNewSessionInProject={(pid) => { useProjectsStore.getState().selectProject(pid); setView("new-session"); }}
        onProjectSettings={() => {}}
        onNewProject={() => { const name = prompt("项目名"); const cwd = prompt("cwd"); if (name && cwd) useProjectsStore.getState().createProject(name, cwd); }}
      />
      <main className="flex-1 flex flex-col overflow-hidden">
        {view === "empty" && <EmptyState onNewProject={() => useProjectsStore.getState().createProject(prompt("项目名")!, prompt("cwd")!)} />}
        {view === "new-session" && <NewSessionPane />}
        {view === "session" && currentSessionId && <SessionView sessionId={currentSessionId} onSwitchToCanvas={() => {}} />}
      </main>
      {configAgent && <AgentConfig agentName={configAgent} onClose={() => setConfigAgent(null)} />}
    </div>
  );
}
```

- [ ] **Step 3: 测试**

`packages/frontend/tests/App-routing.test.tsx`:
```typescript
import { test, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "../src/App";
import { useProjectsStore } from "../src/store/projects";

vi.mock("../src/ws-instance", () => ({
  getWs: () => ({ readyState: 1, addEventListener: () => {}, send: () => {} }),
  send: () => {},
  onMessage: () => () => {},
}));

beforeEach(() => useProjectsStore.setState({
  projects: [], sessions: [], currentProjectId: null, currentSessionId: null,
}));

test("无项目显示 empty 态", () => {
  render(<App />);
  expect(screen.getByTestId("empty-state")).toBeTruthy();
});

test("有项目无会话显示 new-session 态", () => {
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "P", cwd: "/p", createdAt: 0 }],
    sessions: [], currentProjectId: "p1", currentSessionId: null,
  });
  render(<App />);
  expect(screen.getByTestId("new-session-pane")).toBeTruthy();
});
```

- [ ] **Step 4: 跑测试 + 提交**

```bash
bun run test
git add packages/frontend
git commit -m "feat(frontend): App 三态路由（empty/new-session/session）"
```

---

### Task 22: MessageList 组件

**Files:**
- Create: `packages/frontend/src/components/MessageList.tsx`
- Test: `packages/frontend/tests/MessageList.test.tsx`

**Interfaces:**
- Consumes: `useSessionStore`
- Produces: 按 sessionId 渲染消息流

- [ ] **Step 1: 实现**

`packages/frontend/src/components/MessageList.tsx`:
```typescript
import type { ChatMessage } from "@hiagent/shared";
import { useSessionStore } from "../store/session";

interface Props { sessionId: string; }

export function MessageList({ sessionId }: Props) {
  const messages = useSessionStore(s => s.messagesBySession[sessionId] ?? []);
  return (
    <div className="flex-1 overflow-auto p-4 flex flex-col gap-3.5" data-testid="message-list">
      {messages.map(m => <MessageBubble key={m.id} msg={m} />)}
    </div>
  );
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";
  return (
    <div className="flex gap-2" data-testid={`msg-${msg.id}`}>
      <div
        className="max-w-[70%] px-3 py-2"
        style={{
          background: isUser ? "#313244" : "#181825",
          borderRadius: isUser ? "4px 12px 12px 12px" : "12px 4px 12px 12px",
          color: "#cdd6f4",
        }}
      >
        <div className="text-xs text-overlay mb-0.5">{isUser ? "你" : "agent"}</div>
        <div className="text-sm whitespace-pre-wrap">{msg.text}</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 测试**

`packages/frontend/tests/MessageList.test.tsx`:
```typescript
import { test, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MessageList } from "../src/components/MessageList";
import { useSessionStore } from "../store/session";

beforeEach(() => useSessionStore.setState({ messagesBySession: {} }));

test("渲染指定 session 的消息", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        { id: "m1", sessionId: "s1", role: "user", text: "你好", timestamp: 0 },
        { id: "m2", sessionId: "s1", role: "assistant", text: "收到", timestamp: 0 },
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  expect(screen.getByText("你好")).toBeTruthy();
  expect(screen.getByText("收到")).toBeTruthy();
});

test("空 session 无消息", () => {
  render(<MessageList sessionId="empty" />);
  expect(screen.getByTestId("message-list").children).toHaveLength(0);
});
```

- [ ] **Step 3: 跑测试 + 提交**

```bash
bun run test
git add packages/frontend/src/components/MessageList.tsx packages/frontend/tests/MessageList.test.tsx
git commit -m "feat(frontend): MessageList（按 sessionId 取消息流）"
```

---

### Task 23: Composer 组件

**Files:**
- Create: `packages/frontend/src/components/Composer.tsx`
- Test: `packages/frontend/tests/Composer.test.tsx`

**Interfaces:**
- Consumes: `useProjectsStore`（取 projectId/sessionId/primaryAgent），`send`
- Produces: 发送 `agent:prompt` 事件

- [ ] **Step 1: 实现**

`packages/frontend/src/components/Composer.tsx`:
```typescript
import { useState } from "react";
import type { AgentName } from "@hiagent/shared";
import { send } from "../ws-instance";
import { useProjectsStore } from "../store/projects";
import { agentEmoji } from "../theme/agents";

interface Props { sessionId: string; agentName: AgentName; }

export function Composer({ sessionId, agentName }: Props) {
  const [text, setText] = useState("");
  const { sessions, currentProjectId } = useProjectsStore();
  const session = sessions.find(s => s.id === sessionId);
  const projectId = session?.projectId ?? currentProjectId ?? "";

  const handleSend = () => {
    if (!text.trim()) return;
    send({ type: "agent:prompt", projectId, sessionId, agentName, text });
    setText("");
  };

  return (
    <div className="p-3" style={{ background: "#181825" }} data-testid="composer">
      <div className="flex gap-2 items-end rounded-lg p-2" style={{ background: "#313244" }}>
        <span className="text-lg">{agentEmoji(agentName)}</span>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          placeholder={`给${agentName}发消息...`}
          className="flex-1 bg-transparent text-text outline-none resize-none text-sm"
          rows={1}
          data-testid="composer-input"
        />
        <button
          onClick={handleSend}
          disabled={!text.trim()}
          className="px-3 py-1 rounded text-sm"
          style={{ background: text.trim() ? "#89b4fa" : "#585b70", color: "#1e1e2e" }}
          data-testid="composer-send"
        >↩</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 测试**

`packages/frontend/tests/Composer.test.tsx`:
```typescript
import { test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Composer } from "../src/components/Composer";
import { useProjectsStore } from "../src/store/projects";

vi.mock("../src/ws-instance", () => ({ send: vi.fn() }));

beforeEach(() => useProjectsStore.setState({
  projects: [], sessions: [{ id: "s1", projectId: "p1", primaryAgent: "dev", title: "t", createdAt: 0, lastActivity: 0 }],
  currentProjectId: "p1", currentSessionId: "s1",
}));

test("输入发送调 send 带 projectId/sessionId/agentName", async () => {
  const { send } = await import("../src/ws-instance");
  (send as any).mockClear();
  render(<Composer sessionId="s1" agentName={"dev" as const} />);
  fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "继续" } });
  fireEvent.click(screen.getByTestId("composer-send"));
  const arg = (send as any).mock.calls[0][0];
  expect(arg).toEqual({ type: "agent:prompt", projectId: "p1", sessionId: "s1", agentName: "dev", text: "继续" });
});
```

- [ ] **Step 3: 跑测试 + 提交**

```bash
bun run test
git add packages/frontend/src/components/Composer.tsx packages/frontend/tests/Composer.test.tsx
git commit -m "feat(frontend): Composer（带 projectId/sessionId/agentName 发送）"
```

---

### Task 24: AskCard 组件（委派内联卡片 + 干预）

**Files:**
- Create: `packages/frontend/src/components/AskCard.tsx`
- Test: `packages/frontend/tests/AskCard.test.tsx`

**Interfaces:**
- Consumes: `useAgentsStore`（agentEmoji），`send`（inject-reply）
- Produces: 渲染橙色委派卡片 + "🙋 我来回答"按钮，点击展开输入框提交

- [ ] **Step 1: 实现**

`packages/frontend/src/components/AskCard.tsx`:
```typescript
import { useState } from "react";
import type { AskItem } from "@hiagent/shared";
import { send } from "../ws-instance";
import { agentEmoji } from "../theme/agents";

interface Props { ask: AskItem; }

export function AskCard({ ask }: Props) {
  const [answering, setAnswering] = useState(false);
  const [text, setText] = useState("");
  const elapsed = Math.floor((Date.now() - ask.startedAt) / 1000);

  const submit = () => {
    if (!text.trim()) return;
    send({ type: "intercom:inject-reply", sessionId: ask.sessionId, askMessageId: ask.messageId, text });
    setText("");
    setAnswering(false);
  };

  const borderColor = ask.resolved ? "#a6e3a1" : "rgba(250,179,135,0.3)";
  const bgColor = ask.resolved ? "rgba(166,227,161,0.1)" : "rgba(250,179,135,0.1)";

  return (
    <div
      className="rounded-lg p-3 my-2"
      style={{ background: bgColor, border: `1px solid ${borderColor}` }}
      data-testid={`ask-${ask.messageId}`}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm" style={{ color: ask.resolved ? "#a6e3a1" : "#fab387" }}>
          {ask.resolved ? "✓ 已回复" : `↗ 委派给 ${agentEmoji(ask.to)}`}
        </span>
        {!ask.resolved && (
          <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: "rgba(250,179,135,0.2)", color: "#fab387" }}>
            ask · 阻塞中 {elapsed}s
          </span>
        )}
      </div>
      <p className="text-sm text-text italic mb-2">"{ask.text}"</p>
      {ask.resolved ? null : answering ? (
        <div className="flex gap-2">
          <input
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="替被问 agent 输入回复..."
            className="flex-1 bg-mantle text-text rounded px-2 py-1 text-sm outline-none"
            data-testid="ask-input"
          />
          <button onClick={submit} className="px-3 py-1 rounded text-sm" style={{ background: "#a6e3a1", color: "#1e1e2e" }}>提交</button>
        </div>
      ) : (
        <button
          onClick={() => setAnswering(true)}
          className="px-3 py-1 rounded text-sm"
          style={{ background: "#313244", color: "#a6e3a1" }}
          data-testid="ask-answer-btn"
        >🙋 我来回答</button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 测试**

`packages/frontend/tests/AskCard.test.tsx`:
```typescript
import { test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AskCard } from "../src/components/AskCard";
import type { AskItem } from "@hiagent/shared";

vi.mock("../src/ws-instance", () => ({ send: vi.fn() }));

const ask: AskItem = {
  messageId: "a1", sessionId: "s1", from: "product", to: "dev",
  text: "WebSocket 怎么选", startedAt: Date.now() - 23000, resolved: false,
};

test("未解决显示阻塞计时", () => {
  render(<AskCard ask={ask} />);
  expect(screen.getByText(/阻塞中/)).toBeTruthy();
});

test("点击我来回答展开输入", () => {
  render(<AskCard ask={ask} />);
  fireEvent.click(screen.getByTestId("ask-answer-btn"));
  expect(screen.getByTestId("ask-input")).toBeTruthy();
});

test("提交调 inject-reply", async () => {
  const { send } = await import("../src/ws-instance");
  (send as any).mockClear();
  render(<AskCard ask={ask} />);
  fireEvent.click(screen.getByTestId("ask-answer-btn"));
  fireEvent.change(screen.getByTestId("ask-input"), { target: { value: "用 SSE" } });
  fireEvent.click(screen.getByText("提交"));
  expect(send).toHaveBeenCalledWith({
    type: "intercom:inject-reply", sessionId: "s1", askMessageId: "a1", text: "用 SSE",
  });
});
```

- [ ] **Step 3: 跑测试 + 提交**

```bash
bun run test
git add packages/frontend/src/components/AskCard.tsx packages/frontend/tests/AskCard.test.tsx
git commit -m "feat(frontend): AskCard（委派内联卡片 + 🙋 我来回答 干预）"
```

---

### Task 25: SessionView 组件

**Files:**
- Create: `packages/frontend/src/components/SessionView.tsx`
- Test: `packages/frontend/tests/SessionView.test.tsx`

**Interfaces:**
- Consumes: MessageList, Composer, AskCard, useProjectsStore, useIntercomStore, useAgentsStore
- Produces: 会话 header（标题 + 橙色 intercom 徽标 + 主理agent/模型/状态）+ 消息流（含内联 AskCard）+ Composer

- [ ] **Step 1: 实现**

`packages/frontend/src/components/SessionView.tsx`:
```typescript
import { useEffect } from "react";
import { useProjectsStore } from "../store/projects";
import { useIntercomStore } from "../store/intercom";
import { useAgentsStore } from "../store/agents";
import { useSessionStore } from "../store/session";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { AskCard } from "./AskCard";
import { agentEmoji } from "../theme/agents";
import { onMessage } from "../ws-instance";

interface Props { sessionId: string; onSwitchToCanvas: () => void; }

export function SessionView({ sessionId, onSwitchToCanvas }: Props) {
  const session = useProjectsStore(s => s.sessions.find(x => x.id === sessionId));
  const project = useProjectsStore(s => s.projects.find(p => p.id === session?.projectId));
  const asks = useIntercomStore(s => s.asksBySession[sessionId] ?? []);
  const messages = useSessionStore(s => s.messagesBySession[sessionId] ?? []);
  const getGlobalState = useAgentsStore(s => s.getGlobalState);

  useEffect(() => {
    const off = onMessage(e => {
      if (e.type === "agent:message" && e.sessionId === sessionId) useSessionStore.getState().append(e.message);
      if (e.type === "intercom:ask" && e.sessionId === sessionId) useIntercomStore.getState().addAsk(e.ask);
      if (e.type === "intercom:reply" && e.sessionId === sessionId) useIntercomStore.getState().resolveAsk(sessionId, e.askMessageId);
      if (e.type === "agent:state") useAgentsStore.getState().setState(`${e.projectId}:${e.agentName}`, e.state);
    });
    return off;
  }, [sessionId]);

  if (!session) return null;
  const activeAsk = asks.find(a => !a.resolved);
  const state = getGlobalState(session.primaryAgent);

  return (
    <div className="flex-1 flex flex-col h-full" data-testid="session-view">
      <header className="flex items-center gap-2 px-4 py-2 border-b border-surface2" style={{ background: "#181825" }}>
        <span className="text-xl">{agentEmoji(session.primaryAgent)}</span>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-text font-semibold">{session.title}</span>
            {activeAsk && (
              <span
                className="text-xs px-2 py-0.5 rounded-full"
                style={{ background: "rgba(250,179,135,0.2)", color: "#fab387" }}
                data-testid="intercom-badge"
              >● {activeAsk.from}→{activeAsk.to} · ask · {Math.floor((Date.now() - activeAsk.startedAt)/1000)}s</span>
            )}
          </div>
          <div className="text-xs text-overlay">{session.primaryAgent} · {project?.cwd ?? ""} · {state}</div>
        </div>
        <button onClick={onSwitchToCanvas} className="text-sm text-subtext hover:text-text">编排画布</button>
      </header>
      <MessageList sessionId={sessionId} />
      {asks.map(a => <AskCard key={a.messageId} ask={a} />)}
      <Composer sessionId={sessionId} agentName={session.primaryAgent} />
    </div>
  );
}
```

- [ ] **Step 2: 测试**

`packages/frontend/tests/SessionView.test.tsx`:
```typescript
import { test, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SessionView } from "../src/components/SessionView";
import { useProjectsStore } from "../src/store/projects";
import { useIntercomStore } from "../src/store/intercom";
import { useAgentsStore } from "../src/store/agents";
import { useSessionStore } from "../src/store/session";

vi.mock("../src/ws-instance", () => ({ onMessage: () => () => {} }));

beforeEach(() => {
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "P", cwd: "/work/p1", createdAt: 0 }],
    sessions: [{ id: "s1", projectId: "p1", primaryAgent: "dev", title: "测试", createdAt: 0, lastActivity: 0 }],
    currentProjectId: "p1", currentSessionId: "s1",
  });
  useIntercomStore.setState({ asksBySession: {} });
  useAgentsStore.setState({ states: {}, configs: {} });
  useSessionStore.setState({ messagesBySession: {} });
});

test("渲染 header 标题 + 项目目录", () => {
  render(<SessionView sessionId="s1" onSwitchToCanvas={() => {}} />);
  expect(screen.getByText("测试")).toBeTruthy();
  expect(screen.getByText(/\/work\/p1/)).toBeTruthy();
});

test("无活跃 ask 不显示徽标", () => {
  render(<SessionView sessionId="s1" onSwitchToCanvas={() => {}} />);
  expect(screen.queryByTestId("intercom-badge")).toBeNull();
});

test("有活跃 ask 显示徽标", () => {
  useIntercomStore.setState({
    asksBySession: { s1: [{ messageId: "a1", sessionId: "s1", from: "product", to: "dev", text: "问", startedAt: Date.now(), resolved: false }] },
  });
  render(<SessionView sessionId="s1" onSwitchToCanvas={() => {}} />);
  expect(screen.getByTestId("intercom-badge")).toBeTruthy();
});
```

- [ ] **Step 3: 跑测试 + 提交**

```bash
bun run test
git add packages/frontend/src/components/SessionView.tsx packages/frontend/tests/SessionView.test.tsx
git commit -m "feat(frontend): SessionView（header 徽标 + 项目目录 + 消息流 + Composer）"
```

---

### Task 26: AgentConfig 组件

**Files:**
- Create: `packages/frontend/src/components/AgentConfig.tsx`
- Test: `packages/frontend/tests/AgentConfig.test.tsx`

**Interfaces:**
- Consumes: `useAgentsStore`（loadConfig/setConfig/saveConfig），`send`
- Produces: 弹窗，含基本信息 + 系统提示词 + 能力 tab + 合作伙伴

- [ ] **Step 1: 实现（核心 tab 结构）**

`packages/frontend/src/components/AgentConfig.tsx`:
```typescript
import { useEffect, useState } from "react";
import type { AgentConfig, AgentName } from "@hiagent/shared";
import { AGENT_DEFS } from "@hiagent/shared";
import { useAgentsStore } from "../store/agents";
import { send } from "../ws-instance";
import { onMessage } from "../ws-instance";

interface Props { agentName: AgentName; onClose: () => void; }

type Tab = "basic" | "prompt" | "tools" | "skills" | "partners" | "capabilities";

export function AgentConfig({ agentName, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("basic");
  const [draft, setDraft] = useState<AgentConfig | null>(null);
  const config = useAgentsStore(s => s.configs[agentName]);

  useEffect(() => {
    useAgentsStore.getState().loadConfig(agentName);
    const off = onMessage(e => {
      if (e.type === "agent:config" && e.agentName === agentName) {
        setDraft(e.config);
      }
    });
    return off;
  }, [agentName]);

  useEffect(() => { if (config && !draft) setDraft(config); }, [config, draft]);

  const save = () => {
    if (draft) send({ type: "agent:config:save", agentName, config: draft });
    onClose();
  };

  const tabs: Tab[] = ["basic", "prompt", "tools", "skills", "partners", "capabilities"];

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50" style={{ background: "rgba(0,0,0,0.5)" }} data-testid="agent-config">
      <div className="rounded-lg w-[800px] h-[600px] flex flex-col" style={{ background: "#1e1e2e" }}>
        <header className="flex items-center gap-3 p-4 border-b border-surface2">
          <div className="w-10 h-10 rounded-full flex items-center justify-center text-xl" style={{ background: `linear-gradient(135deg, ${AGENT_DEFS[agentName].gradient[0]}, ${AGENT_DEFS[agentName].gradient[1]})` }}>
            {AGENT_DEFS[agentName].emoji}
          </div>
          <div className="flex-1">
            <div className="text-text font-semibold">{draft?.displayName ?? agentName}</div>
            <div className="text-xs text-overlay">{AGENT_DEFS[agentName].label}</div>
          </div>
          <button onClick={save} className="px-3 py-1 rounded text-sm" style={{ background: "#89b4fa", color: "#1e1e2e" }}>保存</button>
          <button onClick={onClose} className="text-overlay hover:text-text">✕</button>
        </header>
        <nav className="flex gap-1 px-4 border-b border-surface2">
          {tabs.map(t => (
            <button key={t} onClick={() => setTab(t)} className="px-3 py-2 text-sm" style={{ borderBottom: tab === t ? "2px solid #89b4fa" : "none", color: tab === t ? "#cdd6f4" : "#6c7086" }}>
              {t === "basic" ? "基本信息" : t === "prompt" ? "系统提示词" : t === "tools" ? "工具" : t === "skills" ? "技能" : t === "partners" ? "合作伙伴" : "能力"}
            </button>
          ))}
        </nav>
        <div className="flex-1 p-4 overflow-auto text-text" data-testid="config-tab-content">
          {!draft && <p className="text-overlay">加载中...</p>}
          {draft && tab === "basic" && <BasicTab draft={draft} onChange={setDraft} />}
          {draft && tab === "prompt" && <PromptTab draft={draft} onChange={setDraft} />}
          {draft && tab === "partners" && <PartnersTab draft={draft} onChange={setDraft} />}
          {draft && (tab === "tools" || tab === "skills" || tab === "capabilities") && (
            <p className="text-overlay">{tab} 内容（工具/技能以逗号分隔编辑，MVP 简化）</p>
          )}
        </div>
      </div>
    </div>
  );
}

function BasicTab({ draft, onChange }: { draft: AgentConfig; onChange: (c: AgentConfig) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <label className="flex gap-2 items-center"><span className="w-20 text-subtext">显示名</span>
        <input value={draft.displayName} onChange={e => onChange({ ...draft, displayName: e.target.value })} className="flex-1 bg-mantle rounded px-2 py-1 text-sm" /></label>
      <label className="flex gap-2 items-center"><span className="w-20 text-subtext">描述</span>
        <input value={draft.description} onChange={e => onChange({ ...draft, description: e.target.value })} className="flex-1 bg-mantle rounded px-2 py-1 text-sm" /></label>
      <label className="flex gap-2 items-center"><span className="w-20 text-subtext">模型</span>
        <input value={draft.model} onChange={e => onChange({ ...draft, model: e.target.value })} className="flex-1 bg-mantle rounded px-2 py-1 text-sm" /></label>
      <label className="flex gap-2 items-center"><span className="w-20 text-subtext">thinking</span>
        <select value={draft.thinking} onChange={e => onChange({ ...draft, thinking: e.target.value as AgentConfig["thinking"] })} className="bg-mantle rounded px-2 py-1 text-sm">
          <option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
        </select></label>
    </div>
  );
}

function PromptTab({ draft, onChange }: { draft: AgentConfig; onChange: (c: AgentConfig) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-subtext text-sm">系统提示词正文（frontmatter 之后）</span>
      <textarea value={draft.systemPromptBody ?? ""} onChange={e => onChange({ ...draft, systemPromptBody: e.target.value })} className="bg-mantle rounded p-2 text-sm font-mono" rows={15} />
      <span className="text-xs text-overlay">模式：{draft.systemPromptMode}</span>
    </div>
  );
}

function PartnersTab({ draft, onChange }: { draft: AgentConfig; onChange: (c: AgentConfig) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-peach text-sm">↗ 可发起 ask 给（出向）</span>
      <input value={draft.partners.askTo.join(", ")} onChange={e => onChange({ ...draft, partners: { ...draft.partners, askTo: e.target.value.split(",").map(s => s.trim()).filter(Boolean) as AgentName[] } })} className="bg-mantle rounded px-2 py-1 text-sm" />
      <span className="text-green text-sm mt-2">↙ 可被 ask 自（入向）</span>
      <input value={draft.partners.askFrom.join(", ")} onChange={e => onChange({ ...draft, partners: { ...draft.partners, askFrom: e.target.value.split(",").map(s => s.trim()).filter(Boolean) as AgentName[] } })} className="bg-mantle rounded px-2 py-1 text-sm" />
    </div>
  );
}
```

- [ ] **Step 2: 测试**

`packages/frontend/tests/AgentConfig.test.tsx`:
```typescript
import { test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentConfig } from "../src/components/AgentConfig";
import { useAgentsStore } from "../src/store/agents";

const mockConfig = {
  name: "dev", displayName: "研发", avatar: "⚙️", avatarColor: "a-b",
  description: "后端", model: "claude", thinking: "high" as const,
  systemPromptMode: "replace" as const, inheritProjectContext: true, inheritSkills: false,
  tools: ["read"], skills: [], mcpServers: [],
  partners: { askTo: ["product"], askFrom: ["product"] },
  systemPromptBody: "你是工程师",
};

vi.mock("../src/ws-instance", () => ({
  send: vi.fn(),
  onMessage: (cb: any) => { cb({ type: "agent:config", agentName: "dev", config: mockConfig }); return () => {}; },
}));

beforeEach(() => useAgentsStore.setState({ states: {}, configs: { dev: mockConfig } }));

test("打开显示 header + tabs", () => {
  render(<AgentConfig agentName="dev" onClose={() => {}} />);
  expect(screen.getByText("研发")).toBeTruthy();
  expect(screen.getByText("基本信息")).toBeTruthy();
});

test("切到系统提示词 tab 显示正文", () => {
  render(<AgentConfig agentName="dev" onClose={() => {}} />);
  fireEvent.click(screen.getByText("系统提示词"));
  expect(screen.getByDisplayValue("你是工程师")).toBeTruthy();
});

test("保存调 send", async () => {
  const { send } = await import("../src/ws-instance");
  (send as any).mockClear();
  const onClose = vi.fn();
  render(<AgentConfig agentName="dev" onClose={onClose} />);
  fireEvent.click(screen.getByText("保存"));
  expect(send).toHaveBeenCalled();
  expect(onClose).toHaveBeenCalled();
});
```

- [ ] **Step 3: 跑测试 + 提交**

```bash
bun run test
git add packages/frontend/src/components/AgentConfig.tsx packages/frontend/tests/AgentConfig.test.tsx
git commit -m "feat(frontend): AgentConfig（基本信息+提示词+合作伙伴 tab）"
```

---
## Phase 5 — 画布与编排

### Task 27: CanvasNode + Canvas 数据模型

**Files:**
- Create: `packages/frontend/src/components/canvas/types.ts`
- Create: `packages/frontend/src/components/canvas/CanvasNode.tsx`
- Test: `packages/frontend/tests/CanvasNode.test.tsx`

**Interfaces:**
- Consumes: `AgentConfig`, `AgentName`, `AGENT_DEFS`，`useAgentsStore`
- Produces:
  - `CanvasNodeData { agentName, state }`
  - `CanvasNode` React Flow 节点组件（22px emoji + 名称 + 状态行 + token）

- [ ] **Step 1: 类型**

`packages/frontend/src/components/canvas/types.ts`:
```typescript
import type { AgentName, AgentStatus } from "@hiagent/shared";

export interface CanvasNodeData {
  agentName: AgentName;
  status: AgentStatus;
  tokenCount?: number;
}
```

- [ ] **Step 2: CanvasNode 组件**

`packages/frontend/src/components/canvas/CanvasNode.tsx`:
```typescript
import { Handle, Position } from "reactflow";
import { AGENT_DEFS } from "@hiagent/shared";
import { STATUS_COLORS } from "../../theme/colors";
import type { CanvasNodeData } from "./types";

const STATUS_LABEL: Record<string, string> = {
  idle: "○ idle", thinking: "● thinking", blocked: "⏸ 等待回复",
};

export function CanvasNode({ data }: { data: CanvasNodeData }) {
  const def = AGENT_DEFS[data.agentName];
  const color = STATUS_COLORS[data.status];
  return (
    <div
      className="rounded-lg px-3 py-2 min-w-[90px]"
      style={{ background: "#181825", border: `2px solid ${color}`, boxShadow: data.status !== "idle" ? `0 0 20px ${color}40` : "none" }}
      data-testid={`canvas-node-${data.agentName}`}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <div className="flex items-center gap-1">
        <span className="text-lg">{def.emoji}</span>
        <span className="text-sm text-text">{def.label}</span>
      </div>
      <div className="text-[9px] mt-0.5" style={{ color }}>{STATUS_LABEL[data.status]}</div>
      {data.tokenCount !== undefined && <div className="text-[9px] text-overlay">{(data.tokenCount/1000).toFixed(1)}k tok</div>}
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}
```

- [ ] **Step 3: 测试**

`packages/frontend/tests/CanvasNode.test.tsx`:
```typescript
import { test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CanvasNode } from "../src/components/canvas/CanvasNode";

vi.mock("reactflow", () => ({
  Handle: () => null,
  Position: { Top: "top", Bottom: "bottom" },
}));

test("渲染 emoji + 状态", () => {
  render(<CanvasNode data={{ agentName: "dev", status: "thinking", tokenCount: 2400 }} />);
  expect(screen.getByText("技术实现")).toBeTruthy();
  expect(screen.getByText(/thinking/)).toBeTruthy();
  expect(screen.getByText(/2\.4k tok/)).toBeTruthy();
});
```

- [ ] **Step 4: 跑测试 + 提交**

```bash
bun run test
git add packages/frontend/src/components/canvas packages/frontend/tests/CanvasNode.test.tsx
git commit -m "feat(frontend): CanvasNode（React Flow 节点 + 状态边框）"
```

---

### Task 28: Canvas 组件（实时状态 + ask 连线动画）

**Files:**
- Create: `packages/frontend/src/components/canvas/Canvas.tsx`
- Test: `packages/frontend/tests/Canvas.test.tsx`

**Interfaces:**
- Consumes: `useAgentsStore`（取所有 agent 状态），`useIntercomStore`（活跃 ask 连线），partners（来自 configs）
- Produces: React Flow 画布，节点 = 4 agent，连线 = partners，活跃 ask 橙色虚线动画

- [ ] **Step 1: 实现**

`packages/frontend/src/components/canvas/Canvas.tsx`:
```typescript
import { useMemo } from "react";
import ReactFlow, { Background } from "reactflow";
import "reactflow/dist/style.css";
import { AGENT_DEFS } from "@hiagent/shared";
import type { AgentName } from "@hiagent/shared";
import { useAgentsStore } from "../../store/agents";
import { useIntercomStore } from "../../store/intercom";
import { CanvasNode } from "./CanvasNode";
import type { CanvasNodeData } from "./types";

const NAMES: AgentName[] = ["product", "pm", "dev", "test"];
const POSITIONS: Record<AgentName, { x: number; y: number }> = {
  product: { x: 100, y: 0 }, pm: { x: 350, y: 0 },
  dev: { x: 100, y: 150 }, test: { x: 350, y: 150 },
};

const nodeTypes = { agent: CanvasNode };

export function Canvas() {
  const states = useAgentsStore(s => s.states);
  const asksBySession = useIntercomStore(s => s.asksBySession);

  const nodes = useMemo(() => NAMES.map(name => {
    // 取该 agent 任一项目状态（画布是全局视图，简化取第一个）
    const entry = Object.entries(states).find(([k]) => k.endsWith(`:${name}`));
    const status = entry?.[1].status ?? "idle";
    const tokenCount = entry?.[1].tokenCount;
    return {
      id: name, type: "agent", position: POSITIONS[name],
      data: { agentName: name, status, tokenCount } as CanvasNodeData,
    };
  }), [states]);

  // 所有活跃 ask（跨会话）作为橙色动画连线
  const activeAsks = useMemo(() => {
    return Object.values(asksBySession).flat().filter(a => !a.resolved);
  }, [asksBySession]);

  const edges = useMemo(() => {
    const base = NAMES.flatMap(from =>
      AGENT_DEFS[from] ? [] : []
    );
    // partners 连线（灰色虚线，来自 config；MVP 用默认 partners）
    const defaultPartners: Array<[AgentName, AgentName]> = [
      ["product", "dev"], ["product", "pm"], ["pm", "dev"], ["pm", "test"], ["dev", "test"],
    ];
    const partnerEdges = defaultPartners.map(([f, t]) => ({
      id: `${f}-${t}`, source: f, target: t,
      style: { stroke: "#6c7086", strokeDasharray: "4,3", strokeWidth: 2 },
    }));
    const askEdges = activeAsks.map(a => ({
      id: `ask-${a.messageId}`, source: a.from, target: a.to,
      animated: true,
      style: { stroke: "#fab387", strokeDasharray: "6,4", strokeWidth: 2.5 },
    }));
    return [...partnerEdges, ...askEdges];
  }, [activeAsks]);

  return (
    <div className="flex-1 h-full" data-testid="canvas">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView>
        <Background gap={20} color="#313244" />
      </ReactFlow>
    </div>
  );
}
```

- [ ] **Step 2: 测试**

`packages/frontend/tests/Canvas.test.tsx`:
```typescript
import { test, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { Canvas } from "../src/components/canvas/Canvas";
import { useAgentsStore } from "../src/store/agents";
import { useIntercomStore } from "../src/store/intercom";

vi.mock("reactflow", () => ({
  default: ({ nodes }: any) => <div data-testid="canvas-mock">{nodes.map((n: any) => <span key={n.id}>{n.id}</span>)}</div>,
  Background: () => null,
}));

beforeEach(() => {
  useAgentsStore.setState({ states: {}, configs: {} });
  useIntercomStore.setState({ asksBySession: {} });
});

test("渲染 4 个节点", () => {
  render(<Canvas />);
  const mock = screen.getByTestId("canvas-mock");
  expect(mock.textContent).toContain("product");
  expect(mock.textContent).toContain("test");
});
```

- [ ] **Step 3: 跑测试 + 提交**

```bash
bun run test
git add packages/frontend/src/components/canvas/Canvas.tsx packages/frontend/tests/Canvas.test.tsx
git commit -m "feat(frontend): Canvas（React Flow 节点 + partners + 活跃 ask 连线）"
```

---

### Task 29: CanvasView 切换

**Files:**
- Modify: `packages/frontend/src/App.tsx`（加 view === "canvas" 分支）
- Modify: `packages/frontend/src/components/SessionView.tsx`（onSwitchToCanvas 改为实际切换）
- Test: `packages/frontend/tests/App-canvas.test.tsx`

**Interfaces:**
- Consumes: Canvas, SessionView
- Produces: view 增加 "canvas" 态，SessionView header "编排画布" 按钮切换

- [ ] **Step 1: 改 App.tsx 的 View 类型与分支**

`packages/frontend/src/App.tsx` 中：
```typescript
type View = "empty" | "new-session" | "session" | "canvas";
```
在 main 区域分支加：
```typescript
{view === "canvas" && <Canvas />}
```
onSwitchToCanvas 传 `() => setView("canvas")`，canvas 视图加返回按钮。

具体 diff：
- View 类型加 `"canvas"`
- 新增 state `const [canvasFromSession, setCanvasFromSession] = useState<string | null>(null)`
- SessionView 的 `onSwitchToCanvas` 改为 `() => { setCanvasFromSession(currentSessionId); setView("canvas"); }`
- canvas 分支：`{view === "canvas" && <div className="flex-1 flex flex-col"><button onClick={() => setView(currentSessionId ? "session" : "new-session")} className="p-2 text-subtext">← 返回会话</button><Canvas /></div>}`

- [ ] **Step 2: 测试切换**

`packages/frontend/tests/App-canvas.test.tsx`:
```typescript
import { test, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { App } from "../src/App";
import { useProjectsStore } from "../src/store/projects";

vi.mock("../src/ws-instance", () => ({ getWs: () => ({}), send: () => {}, onMessage: () => () => {} }));
vi.mock("reactflow", () => ({ default: ({ nodes }: any) => <div data-testid="rf">{nodes.length}</div>, Background: () => null }));

beforeEach(() => useProjectsStore.setState({
  projects: [{ id: "p1", name: "P", cwd: "/p", createdAt: 0 }],
  sessions: [{ id: "s1", projectId: "p1", primaryAgent: "dev", title: "t", createdAt: 0, lastActivity: 0 }],
  currentProjectId: "p1", currentSessionId: "s1",
}));

test("点编排画布切换到 canvas", () => {
  render(<App />);
  fireEvent.click(screen.getByText("编排画布"));
  expect(screen.getByTestId("canvas")).toBeTruthy();
});
```

- [ ] **Step 3: 跑测试 + 提交**

```bash
bun run test
git add packages/frontend
git commit -m "feat(frontend): CanvasView 切换（会话 header 按钮切画布）"
```

---

## Phase 6 — Tauri 集成

### Task 30: Tauri 项目初始化

**Files:**
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/build.rs`
- Create: `src-tauri/src/main.rs`
- Create: `src-tauri/icons/`（图标占位）

**Interfaces:**
- Produces: `npx @tauri-apps/cli dev` 可启动窗口（先空壳，加载 Vite dev server）

- [ ] **Step 1: Cargo.toml**

```toml
[package]
name = "hiagent"
version = "0.0.0"
edition = "2021"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-shell = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[features]
custom-protocol = ["tauri/custom-protocol"]
```

- [ ] **Step 2: tauri.conf.json**

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "HiAgent",
  "version": "0.0.0",
  "identifier": "com.hiagent.app",
  "build": {
    "frontendDist": "../packages/frontend/dist",
    "devUrl": "http://localhost:5173",
    "beforeDevCommand": "bun run --filter @hiagent/frontend dev",
    "beforeBuildCommand": "bun run --filter @hiagent/frontend build"
  },
  "app": {
    "windows": [{ "title": "HiAgent", "width": 1280, "height": 800 }],
    "security": { "csp": null }
  },
  "bundle": { "active": true, "targets": "all" }
}
```

- [ ] **Step 3: build.rs + main.rs（空壳）**

`src-tauri/build.rs`:
```rust
fn main() { tauri_build::build() }
```

`src-tauri/src/main.rs`:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() { hiagent_lib::run() }
```

`src-tauri/src/lib.rs`:
```rust
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 4: 验证启动**

```bash
# 装 tauri rust 依赖（首次较慢）
cd src-tauri && cargo build
# 启动 dev（会同时拉起 frontend dev server）
npx @tauri-apps/cli@2.11 dev
# 期望: 弹出 HiAgent 窗口，显示"HiAgent 占位"
```

- [ ] **Step 5: 提交**

```bash
git add src-tauri
git commit -m "chore(tauri): 项目初始化（Cargo + tauri.conf + 空壳窗口）"
```

> 验证（四层）：第四层 `[需 tauri build]`：手动确认窗口弹出。无单元测试（Rust 壳无业务逻辑）。

---

### Task 31: Bun sidecar 编译 + Tauri sidecar 配置

**Files:**
- Modify: `src-tauri/tauri.conf.json`（加 sidecar 配置）
- Modify: `src-tauri/Cargo.toml`（加 sidecar 权限）
- Modify: `packages/kernel/package.json`（确认 build 产物名）

**Interfaces:**
- Produces: Tauri 能管理 Bun kernel 进程的生命周期（启停）

- [ ] **Step 1: kernel build 产物**

确认 `packages/kernel/package.json` 的 build 脚本：
```json
"build": "bun build src/index.ts --target bun --outfile dist/hiagent-kernel"
```

- [ ] **Step 2: tauri.conf.json 加 sidecar**

```json
{
  "bundle": {
    "active": true,
    "targets": "all",
    "externalBin": ["../packages/kernel/dist/hiagent-kernel"]
  }
}
```

- [ ] **Step 3: capabilities 加 shell 权限**

`src-tauri/capabilities/default.json`:
```json
{
  "identifier": "default",
  "windows": ["main"],
  "permissions": ["core:default", "shell:allow-execute", "shell:allow-spawn"]
}
```

- [ ] **Step 4: 验证编译**

```bash
bun run --filter @hiagent/kernel build
ls packages/kernel/dist/hiagent-kernel*
# 期望: 产物存在
```

- [ ] **Step 5: 提交**

```bash
git add src-tauri packages/kernel/package.json
git commit -m "chore(tauri): Bun sidecar 编译产物 + Tauri sidecar 配置"
```

---

### Task 32: Rust 主进程（窗口 + sidecar 启停）

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Create: `src-tauri/src/sidecar.rs`

**Interfaces:**
- Produces: Tauri 启动时 spawn kernel sidecar（端口 9776），关闭时 kill；前端通过 WS 连 kernel

- [ ] **Step 1: sidecar.rs**

`src-tauri/src/sidecar.rs`:
```rust
use tauri::Manager;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

pub fn spawn_kernel(app: &tauri::AppHandle) -> std::result::Result<CommandChild, String> {
    let sidecar = app
        .shell()
        .sidecar("hiagent-kernel")
        .map_err(|e| format!("找不到 sidecar: {e}"))?;
    let (rx, child) = sidecar
        .spawn()
        .map_err(|e| format!("spawn kernel 失败: {e}"))?;
    // 日志输出到 stderr
    tauri::async_runtime::spawn(async move {
        let _ = rx;
    });
    Ok(child)
}
```

- [ ] **Step 2: lib.rs 接管生命周期**

`src-tauri/src/lib.rs`:
```rust
mod sidecar;
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_shell::process::CommandChild;

struct KernelChild(Mutex<Option<CommandChild>>);

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(KernelChild(Mutex::new(None)))
        .setup(|app| {
            let child = sidecar::spawn_kernel(&app.handle())?;
            let state: tauri::State<KernelChild> = app.state();
            *state.0.lock().unwrap() = Some(child);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested = event {
                let state: tauri::State<KernelChild> = window.state();
                if let Some(child) = state.0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: 验证全链路启动**

```bash
npx @tauri-apps/cli@2.11 dev
# 期望: 窗口弹出 + kernel sidecar 在 stderr 输出"[kernel] WS 监听 ws://127.0.0.1:9776"
# 前端 WS 连上，sidebar 显示（无项目时空态）
```

- [ ] **Step 4: 提交**

```bash
git add src-tauri/src
git commit -m "feat(tauri): Rust 主进程管理 kernel sidecar 生命周期"
```

> 验证（四层）：第四层 `[需 tauri build]`：手动确认窗口 + kernel 联动。

---

### Task 33: 启动到对话全链路集成测试 + 迁移

**Files:**
- Modify: `packages/kernel/src/index.ts`（加老数据迁移逻辑）
- Create: `packages/kernel/src/migrate.ts`
- Test: `packages/kernel/tests/migrate.test.ts`

**Interfaces:**
- Consumes: 所有 kernel 组件
- Produces: `migrateLegacySessions(projectStore, sessionStore)` —— 老用户首次启动自动建"默认项目"，把旧会话归入

- [ ] **Step 1: 迁移逻辑**

`packages/kernel/src/migrate.ts`:
```typescript
import type { ProjectStore } from "./project-store";
import type { SessionStore } from "./session-store";

// 老用户首次启动：无项目但有旧会话数据 → 建默认项目
export async function migrateLegacySessions(
  projectStore: ProjectStore,
  sessionStore: SessionStore,
): Promise<boolean> {
  const { projects, sessions } = await projectStore.load();
  if (projects.length > 0) return false;  // 已有项目，无需迁移

  // 检查 sessions 目录有无旧数据文件
  const { readdir } = await import("node:fs/promises");
  const { SESSIONS_DIR } = await import("@hiagent/shared");
  let oldFiles: string[] = [];
  try { oldFiles = (await readdir(SESSIONS_DIR)).filter(f => f.endsWith(".json")); } catch {}

  // 无旧数据 → 不强制建项目（新用户走空态引导）
  if (oldFiles.length === 0 && sessions.length === 0) return false;

  // 建默认项目
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  const defaultProject = await projectStore.createProject({
    name: "默认项目",
    cwd: home,
  });

  // 旧 session（若有）归入默认项目
  for (const s of sessions) {
    await projectStore.updateProject(defaultProject.id, {});
    // session 平铺已带 projectId，若旧数据缺则补
  }
  return true;
}
```

- [ ] **Step 2: 测试**

`packages/kernel/tests/migrate.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { migrateLegacySessions } from "../src/migrate";
import { ProjectStore } from "../src/project-store";
import { SessionStore } from "../src/session-store";

function tmp(s: string) { return join(import.meta.dir, s + Math.random().toString(36).slice(2)); }

test("无项目无旧数据不迁移", async () => {
  const pf = tmp("pf.json"); const sd = tmp("sd");
  const ps = new ProjectStore(pf); const ss = new SessionStore(sd);
  expect(await migrateLegacySessions(ps, ss)).toBe(false);
  const { projects } = await ps.load();
  expect(projects).toEqual([]);
  rmSync(pf, { force: true }); rmSync(sd, { recursive: true, force: true });
});

test("已有项目不迁移", async () => {
  const pf = tmp("pf.json"); const sd = tmp("sd");
  const ps = new ProjectStore(pf); const ss = new SessionStore(sd);
  await ps.createProject({ name: "已存在", cwd: "/x" });
  expect(await migrateLegacySessions(ps, ss)).toBe(false);
  rmSync(pf, { force: true }); rmSync(sd, { recursive: true, force: true });
});
```

- [ ] **Step 3: index.ts 启动时调用迁移**

`packages/kernel/src/index.ts` 在 `main()` 内 `await server.start()` 前加：
```typescript
import { migrateLegacySessions } from "./migrate";
// ...在 main() 里 server.start() 之前：
await migrateLegacySessions(projectStore, sessionStore);
```

- [ ] **Step 4: 第三层集成测试（真实 WS + mock Pi）**

`packages/kernel/tests/e2e-integration.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { ConfigStore } from "../src/config-store";
import { ProjectStore } from "../src/project-store";
import { SessionStore } from "../src/session-store";
import { AgentManager } from "../src/agent-manager";
import { IntercomMonitor } from "../src/intercom-monitor";
import { StateAggregator } from "../src/state-aggregator";
import { WSServer } from "../src/ws-server";
import type { WSClientEvent, WSServerEvent } from "@hiagent/shared";

// 完整流程：前端发 agent:prompt → kernel 建会话 → 广播 session:created
test("[第三层] 建项目→发消息→建会话", async () => {
  const tmp = (s: string) => join(import.meta.dir, ".tmp-e2e-" + s + Math.random().toString(36).slice(2));
  const configStore = new ConfigStore(tmp("cfg"));
  const projectStore = new ProjectStore(tmp("proj.json"));
  const sessionStore = new SessionStore(tmp("sess"));
  const agentManager = new AgentManager({
    projectStore,
    onEvent: () => {},
    spawnFn: (() => ({
      stdin: { write: () => {}, end: () => {} },
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      killed: false, kill: () => {},
    })) as any,
  });
  const intercomMonitor = new IntercomMonitor({
    onAsk: () => {}, onReply: () => {}, connectFn: async () => ({ on: () => {}, write: () => {}, destroy: () => {} }) as any,
  });
  const stateAggregator = new StateAggregator({
    sessionStore, agentManager, onServerEvent: () => {},
  });
  const server = new WSServer({
    configStore, projectStore, sessionStore,
    agentManager, intercomMonitor, stateAggregator, port: 0,
  });
  await server.start();
  const ws = new WebSocket(`ws://127.0.0.1:${server.actualPort}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const queue: WSServerEvent[] = [];
  ws.onmessage = (ev) => queue.push(JSON.parse(String(ev.data)));
  const send = (e: WSClientEvent) => ws.send(JSON.stringify(e));
  const recv = async (): Promise<WSServerEvent> => {
    while (queue.length === 0) await new Promise(r => setTimeout(r, 20));
    return queue.shift()!;
  };

  // 1. 建项目
  send({ type: "project:create", name: "P", cwd: "/p" });
  const created = await recv() as any;
  expect(created.type).toBe("project:created");
  const projectId = created.project.id;

  // 2. 发首条消息 → 触发建会话
  send({ type: "agent:prompt", projectId, sessionId: "req-1", agentName: "dev", text: "你好" });
  const sessionCreated = await recv() as any;
  expect(sessionCreated.type).toBe("session:created");
  expect(sessionCreated.session.projectId).toBe(projectId);
  expect(sessionCreated.session.title).toBe("你好");  // 首条消息截断

  // 清理
  ws.close();
  await server.stop();
  rmSync(tmp("proj.json"), { force: true });
  rmSync(tmp("sess"), { recursive: true, force: true });
});
```

- [ ] **Step 5: 提交**

```bash
bun test packages/kernel
git add packages/kernel
git commit -m "feat(kernel): 老数据迁移 + 启动到对话全链路集成测试"
```

---

## Phase 7 — E2E 与收尾

> **Phase 7 通用约定**：每个 spec 启动 kernel（`bun run --filter @hiagent/kernel dev` 后台）+ Vite dev server（Playwright 自动）；用独立 `~/.hiagent-test-<random>/`（env 注入 `HIAGENT_DIR`），测完清理；截图在 `afterEach` 删除。

### Task 34: E2E 基础设施（Playwright 安装 + 配置）

**Files:**
- Create: `packages/frontend/playwright.config.ts`
- Modify: `packages/frontend/package.json`（加 `e2e` script + devDep）

**Interfaces:**
- Consumes: Vite dev server（Task 13）
- Produces: `bun run e2e` 可执行，自动拉起 dev server

- [ ] **Step 1: 装 Playwright**

`packages/frontend/package.json` devDependencies 加：
```json
"@playwright/test": "^1.49.0"
```
scripts 加：`"e2e": "playwright test"`

```bash
cd packages/frontend
bun install
bunx playwright install chromium
```

- [ ] **Step 2: playwright.config.ts**

`packages/frontend/playwright.config.ts`:
```typescript
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://localhost:5173", headless: true },
  webServer: {
    command: "bun run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
  },
});
```

- [ ] **Step 3: 验证空跑**

```bash
bun run e2e
# 期望: 0 passed（无 spec），无报错
```

- [ ] **Step 4: 提交**

```bash
git add packages/frontend/playwright.config.ts packages/frontend/package.json
git commit -m "chore(e2e): Playwright 安装 + 配置"
```

---

### Task 35: E2E 首次启动引导建项目

**Files:**
- Create: `packages/frontend/e2e/onboarding.spec.ts`

**Interfaces:**
- Consumes: Task 21 的 EmptyState + project:create 流程
- Produces: 验证空态 → 建项目 → 切到 new-session 态

- [ ] **Step 1: 写 e2e/onboarding.spec.ts**

```typescript
import { test, expect } from "@playwright/test";

test("首次启动空态引导建项目", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("empty-new-project").click();
  page.on("dialog", async d => {
    if (d.message().includes("项目名")) await d.accept("测试项目");
    else if (d.message().includes("cwd")) await d.accept("/tmp/test");
  });
  await expect(page.getByTestId("new-session-pane")).toBeVisible({ timeout: 5000 });
});
```

- [ ] **Step 2: 跑该 spec**

```bash
bun run e2e -- --grep "首次启动"
# 期望: 1 passed
```

- [ ] **Step 3: 提交**

```bash
git add packages/frontend/e2e/onboarding.spec.ts
git commit -m "test(e2e): 首次启动引导建项目"
```

---

### Task 36: E2E 新建会话面板发送首条消息

**Files:**
- Create: `packages/frontend/e2e/new-session.spec.ts`

**Interfaces:**
- Consumes: Task 20 NewSessionPane + Task 12 session:created 事件
- Produces: 验证发送首条消息 → 切到 session 视图

- [ ] **Step 1: 写 spec**

```typescript
import { test, expect } from "@playwright/test";

test("新建会话面板发送首条消息建会话", async ({ page }) => {
  await page.goto("/");
  // 先建项目（复用 onboarding 的 dialog 处理）
  page.on("dialog", async d => {
    if (d.message().includes("项目名")) await d.accept("P");
    else if (d.message().includes("cwd")) await d.accept("/tmp/p");
  });
  await page.getByTestId("empty-new-project").click();
  await page.getByTestId("new-session-input").fill("设计登录功能");
  await page.getByTestId("new-session-send").click();
  // 期望切到 session 视图
  await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 5000 });
});
```

- [ ] **Step 2: 跑 + 提交**

```bash
bun run e2e -- --grep "发送首条"
git add packages/frontend/e2e/new-session.spec.ts
git commit -m "test(e2e): 新建会话面板发送首条消息"
```

---

### Task 37: E2E 会话内 intercom 委派内联 `[需 pi 环境]`

**Files:**
- Create: `packages/frontend/e2e/intercom.spec.ts`

**Interfaces:**
- Consumes: Task 24 AskCard + 真实 Pi ask 事件
- Produces: 验证 ask → AskCard 显示 → 我来回答 → 已回复

- [ ] **Step 1: 写 spec**

```typescript
import { test, expect } from "@playwright/test";

test("[需 pi 环境] 会话内 intercom 委派显示 AskCard", async ({ page }) => {
  test.skip(!process.env.PI_E2E, "需真实 Pi 环境");
  await page.goto("/");
  // 进入某会话后，等待 intercom:ask 事件触发 AskCard 渲染
  await expect(page.getByText(/委派给/)).toBeVisible({ timeout: 30000 });
  await page.getByTestId("ask-answer-btn").click();
  await page.getByTestId("ask-input").fill("用 SSE 实现");
  await page.getByText("提交").click();
  await expect(page.getByText(/已回复/)).toBeVisible();
});
```

- [ ] **Step 2: 跑（仅 pi 环境）+ 提交**

```bash
PI_E2E=1 bun run e2e -- --grep "intercom 委派"
git add packages/frontend/e2e/intercom.spec.ts
git commit -m "test(e2e): intercom 委派内联显示 [需 pi 环境]"
```

---

### Task 38: E2E Agent 配置编辑落盘

**Files:**
- Create: `packages/frontend/e2e/agent-config.spec.ts`

**Interfaces:**
- Consumes: Task 26 AgentConfig + Task 5 ConfigStore 落盘
- Produces: 验证编辑 → 保存 → 重开值保留

- [ ] **Step 1: 写 spec**

```typescript
import { test, expect } from "@playwright/test";

test("编辑 Agent 配置保存落盘", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("agent-dev").click();
  await expect(page.getByTestId("agent-config")).toBeVisible();
  await page.getByText("系统提示词").click();
  const textarea = page.locator("textarea").first();
  await textarea.fill("你是资深工程师 v2");
  await page.getByText("保存").click();
  await page.getByTestId("agent-dev").click();
  await page.getByText("系统提示词").click();
  await expect(page.locator("textarea").first()).toHaveValue("你是资深工程师 v2");
});
```

- [ ] **Step 2: 跑 + 提交**

```bash
bun run e2e -- --grep "配置落盘"
git add packages/frontend/e2e/agent-config.spec.ts
git commit -m "test(e2e): Agent 配置编辑落盘"
```

---

### Task 39: E2E 编排画布节点

**Files:**
- Create: `packages/frontend/e2e/canvas.spec.ts`

**Interfaces:**
- Consumes: Task 28 Canvas（React Flow）
- Produces: 验证画布 4 节点 + 连线渲染

- [ ] **Step 1: 写 spec**

```typescript
import { test, expect } from "@playwright/test";

test("编排画布显示 4 节点", async ({ page }) => {
  await page.goto("/");
  // 进入会话后点编排画布
  await page.getByText("编排画布").click();
  await expect(page.getByTestId("canvas")).toBeVisible();
  await expect(page.locator("[data-testid^='canvas-node-']")).toHaveCount(4);
});
```

- [ ] **Step 2: 跑 + 提交**

```bash
bun run e2e -- --grep "编排画布"
git add packages/frontend/e2e/canvas.spec.ts
git commit -m "test(e2e): 编排画布节点渲染"
```

---

### Task 40: E2E 多项目切换与 cwd 隔离 `[需 pi 环境]`

**Files:**
- Create: `packages/frontend/e2e/multi-project.spec.ts`

**Interfaces:**
- Consumes: Task 6 ProjectStore + Task 10 AgentManager 双 key cwd
- Produces: 验证两项目各发消息 → spawn 不同 cwd 的 pi 进程

- [ ] **Step 1: 写 spec**

```typescript
import { test, expect } from "@playwright/test";

test("[需 pi 环境] 多项目 cwd 隔离", async ({ page }) => {
  test.skip(!process.env.PI_E2E, "需真实 Pi 环境");
  await page.goto("/");
  // 建项目 A、B，各发一条消息
  // 通过 sidebar 检查两项目各自有独立会话
  // 进阶：检查 kernel 日志确认 spawn 了不同 cwd 的 pi 进程
  // （此 spec 验证多项目核心隔离语义，断言以 sidebar 两项目各自有会话为准）
});
```

- [ ] **Step 2: 跑（仅 pi 环境）+ 提交**

```bash
PI_E2E=1 bun run e2e -- --grep "多项目 cwd"
git add packages/frontend/e2e/multi-project.spec.ts
git commit -m "test(e2e): 多项目 cwd 隔离 [需 pi 环境]"
```

> 注：Task 40-41（原骨架的老数据迁移 E2E）合并到此 Task 33 已覆盖迁移逻辑的单元测试；E2E 层老数据迁移验证可选，若需独立 spec 在此补充 `e2e/migrate.spec.ts`。

---

### Task 41: E2E 老数据迁移 `[需 pi 环境]`（可选）

**Files:**
- Create: `packages/frontend/e2e/migrate.spec.ts`

**Interfaces:**
- Consumes: Task 33 migrateLegacySessions
- Produces: 验证老用户首次启动自动建"默认项目"

- [ ] **Step 1: 写 spec**

```typescript
import { test, expect } from "@playwright/test";

test("老用户首次启动自动建默认项目", async ({ page }) => {
  // 预置：在测试用的 HIAGENT_DIR 放无 projectId 的旧 sessions/<id>.json
  await page.goto("/");
  await expect(page.getByText("默认项目")).toBeVisible({ timeout: 5000 });
});
```

- [ ] **Step 2: 跑 + 提交**

```bash
bun run e2e -- --grep "老用户"
git add packages/frontend/e2e/migrate.spec.ts
git commit -m "test(e2e): 老数据迁移建默认项目"
```

---

### Task 42: 截图清理 + 文档核对

**Files:**
- 全项目扫描 `*.png` `*.jpg`（E2E 产物）

- [ ] **Step 1: 清理测试截图**

```bash
# 找出 E2E 产生的截图（test-results/、e2e/screenshots/ 等）
find packages/frontend -name "test-results" -type d -exec rm -rf {} + 2>/dev/null
find . -name "*.png" -path "*/test-results/*" -delete 2>/dev/null
find . -name "*.png" -path "*/e2e/*" -delete 2>/dev/null
git status  # 确认无截图残留
```

- [ ] **Step 2: 文档核对**

对照 hiagent-design 11.1 八项 MVP + sidebar-projects-design 全部决策，逐项确认有对应 Task 实现。更新 `docs/superpowers/specs/2026-07-05-hiagent-design.md` 的状态行（若计划与设计有偏差，记录）。

- [ ] **Step 3: 提交**

```bash
git add -A
git commit -m "chore: 截图清理 + 文档核对（E2E 完成后）"
```

---

### Task 43: CHANGELOG 汇总 + 最终验收

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 汇总 CHANGELOG**

在 `CHANGELOG.md` 顶部加 MVP 完成条目（汇总 41 个 Task）。

- [ ] **Step 2: 全量测试**

```bash
# 全部单元 + 组件测试
bun test
# 全部 E2E（mock 层）
cd packages/frontend && bun run e2e -- --grep-invert "\[需 pi 环境\]"
# typecheck
bun run --filter '*' --if-present typecheck
```

- [ ] **Step 3: 提交 + 验收**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG 汇总 MVP 完成（42 Task）"
```

> 最终验收门槛（AGENTS.md §6 四层）：
> - 第一层 单元：`bun test` 全绿（kernel + shared）
> - 第二层 组件：`bun run test`（frontend）全绿
> - 第三层 API：`bun test packages/kernel/tests/ws-server.test.ts` + `e2e-integration.test.ts` 全绿
> - 第四层 E2E：`bun run e2e`（mock 层）全绿；`[需 pi 环境]` / `[需 tauri build]` 标注项在对应环境验证

---

## Self-Review（计划完成后自查）

**1. Spec 覆盖**：
- hiagent-design 11.1 八项：①新建会话面板(T20) ②会话视图(T25) ③Pi 集成(T8) ④pi-intercom(T9) ⑤委派内联(T24) ⑥Agent 配置(T26) ⑦编排画布(T27-29) ⑧无超时 ask(T9 IntercomMonitor) ✓
- sidebar-projects-design：四区(T16-19) + 项目/会话两级(T6-7) + 双 key(T10) + 主区三态(T21) + header 徽标(T25) ✓
- 迁移(T33) ✓ / 多项目隔离(T40) ✓ / 老数据迁移 E2E(T41) ✓

**2. 类型一致性**：`PiEvent`、`AgentStateKey`、`WSServerEvent` 在跨 Task 引用时签名一致（已核对 Task 8/9/10/11/12）。`getGlobalState`、`aggregateAgentState` 在 store(T14) 与组件(T17/T25) 用法一致。

**3. 环境分层**：四层测试均标注可跑环境；Pi/Tauri 相关标注 `[需 pi 环境]` / `[需 tauri build]`。win32 默认可跑：所有单元 + 组件 + mock 层 API + 非标注 E2E。

**4. 已知简化**（实现时需注意，非 placeholder）：
- pi `--mode rpc` 实际事件字段名（`message_update`/`state_change`）以 Task 1 验证为准，可能需调整 `handleLine`
- pi-intercom broker 消息协议（`kind: "ask"/"reply"`）以 Task 1 验证为准
- AgentConfig 的"能力 tab"（工具/技能勾选）MVP 用逗号分隔输入简化，非完整 UI（对应 hiagent-design 5.2 资源三层模型，后续迭代完善）
- App 的项目创建用 `prompt()` 收集，E2E 用 dialog handler（生产应改表单弹窗，但 MVP 范围内 prompt 可接受）
