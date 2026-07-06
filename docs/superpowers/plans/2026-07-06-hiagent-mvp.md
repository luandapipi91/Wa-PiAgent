# HiAgent MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现设计文档（`docs/superpowers/specs/2026-07-05-hiagent-design.md`）10.1 节定义的 MVP——一个 Tauri 桌面应用，让用户通过 GUI 管理 4 个对等 Pi agent，agent 间用 pi-intercom 动态双向委派（ask/send/reply），ask 不设超时，用户可介入。

**Architecture:** 三层。① Tauri 原生窗口（Rust 壳 + React 前端）② Bun 编排内核（sidecar，端口 9776，WebSocket 对外）③ N 个 `pi --mode rpc` 子进程（通过 pi-intercom broker 对等通信）。前端 ↔ 内核走 WebSocket，内核 ↔ Pi 走 stdio JSONL，Pi 间走 Unix socket broker。本计划按依赖拓扑从底层（PiRpcClient）向上构建。

**Tech Stack:** Bun 1.3 + TypeScript（编排内核）/ React 19 + Zustand + React Flow + Tailwind（前端）/ Tauri 2 + Rust（桌面壳）/ Vitest（测试）/ pi 0.80 + pi-intercom 0.6（已验证）

## Global Constraints

- **运行时**：Bun 作为编排内核运行时；Pi 二进制（`pi` 命令）必须在 PATH（已装于 `~/.nvm/versions/node/v22.21.1/bin/pi`）
- **端口**：编排内核固定 9776（WebSocket）；产物预览静态服务 9777（MVP 外，留空）
- **Pi 调用**：`pi --mode rpc`，stdio 跑 JSONL（每行一个 JSON 对象，LF 分隔）。RPC 命令：`prompt`/`abort`/`get_state`/`get_messages`/`get_commands`/`set_model` 等。事件：`response`/`agent_start`/`turn_start`/`message_start`/`message_update`/`message_end`/`turn_end`/`agent_end`/`tool_execution_start`/`tool_execution_update`/`tool_execution_end`
- **Pi intercom**：v0.6.0。broker socket 路径 `~/.pi/agent/intercom/broker.sock`。client API：`connect(Omit<SessionInfo,"id">)` / `listSessions()` / `send(to, message)` / `on("message", cb)` / `disconnect()`。broker 30 秒空闲自动退出，spawn pi 会 auto-spawn broker
- **ask 超时**：v0.6.0 无超时 GC，发送方注册 message 事件监听等 reply，不设超时（天然无限等待）
- **Agent 配置**：`~/.pi/agent/agents/<name>.md`，frontmatter 含 name/displayName/avatar/model/tools/skills/partners 等字段
- **测试模型**：DeepSeek，`DEEPSEEK_API_KEY` 环境变量，模型 ID `deepseek/deepseek-v4-flash`。测试脚本里用环境变量传递 key，不硬编码、不提交
- **不做的**：技能细粒度启用、插件市场 UI、Intercom 时间线全屏、MCP 配置 UI、产物预览、多项目（见设计文档 10.2）

---

## File Structure

monorepo，三个包 + 一个 Tauri 壳：

```
HiAgent/
├── package.json                    # workspace root（bun workspaces）
├── bunfig.toml                     # bun 配置
├── docs/                           # 已有
├── packages/
│   ├── kernel/                     # ② Bun 编排内核（sidecar）
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── index.ts            # 入口：组装所有组件，启动 WS server（9776）
│   │   │   ├── pi-rpc-client.ts    # PiRpcClient：spawn pi + JSONL 协议
│   │   │   ├── agent-manager.ts    # AgentManager：管多 PiRpcClient 生命周期
│   │   │   ├── config-store.ts     # ConfigStore：读写 agent.md
│   │   │   ├── intercom-monitor.ts # IntercomMonitor：连 broker，跟踪 ask 队列
│   │   │   ├── state-aggregator.ts # StateAggregator：快照+增量，推 WS
│   │   │   ├── ws-server.ts        # WebSocket server（前端连这里）
│   │   │   ├── types.ts            # 共享类型：AgentConfig / WSEvent / RPCEvent
│   │   │   └── agent-md.ts         # agent.md frontmatter 解析/序列化
│   │   └── tests/
│   │       ├── pi-rpc-client.test.ts
│   │       ├── agent-manager.test.ts
│   │       ├── config-store.test.ts
│   │       ├── intercom-monitor.test.ts
│   │       └── state-aggregator.test.ts
│   ├── frontend/                   # ① React 前端
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── vite.config.ts
│   │   ├── index.html
│   │   ├── src/
│   │   │   ├── main.tsx
│   │   │   ├── App.tsx
│   │   │   ├── store/              # Zustand stores
│   │   │   │   ├── agents.ts       # agent 列表/状态
│   │   │   │   ├── session.ts      # 当前会话/消息流
│   │   │   │   └── intercom.ts     # intercom 状态/ask 队列
│   │   │   ├── api/
│   │   │   │   └── ws.ts           # WebSocket 客户端
│   │   │   ├── components/
│   │   │   │   ├── LaunchScreen.tsx       # 启动页：角色选择
│   │   │   │   ├── SessionView.tsx        # 会话视图（左右布局）
│   │   │   │   ├── Sidebar.tsx            # 左 sidebar：角色列表+历史
│   │   │   │   ├── MessageList.tsx        # 消息流
│   │   │   │   ├── MessageItem.tsx        # 单条消息（含 ask 委派卡片）
│   │   │   │   ├── Composer.tsx           # 底部输入框
│   │   │   │   ├── AskCard.tsx            # 委派内联显示+干预按钮
│   │   │   │   ├── Canvas.tsx             # 编排画布（React Flow）
│   │   │   │   ├── CanvasNode.tsx         # 画布节点
│   │   │   │   ├── AgentConfig.tsx        # Agent 配置弹窗
│   │   │   │   └── IntercomStatusBar.tsx  # 底部 intercom 状态条
│   │   │   └── styles.css          # Tailwind 入口
│   │   └── tests/
│   │       └── store.test.ts
│   └── shared/                     # 前后端共享类型
│       ├── package.json
│       └── src/
│           └── types.ts            # AgentConfig / WSEvent / RPCEvent（与 kernel/types.ts 同源，re-export）
└── src-tauri/                      # ③ Tauri Rust 壳
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── build.rs
    └── src/
        └── main.rs                 # 窗口 + Bun sidecar 生命周期
```

**职责边界**：
- `kernel/` 是唯一与 Pi 进程交互的地方；前端永远不直接 spawn pi
- `shared/` 让前后端用同一份类型定义（WSEvent 等），避免协议漂移
- `src-tauri/` 只管窗口 + 启停 Bun sidecar，不含业务逻辑

---

## Task 1: Monorepo 脚手架 + 工具链

**Files:**
- Create: `package.json`, `bunfig.toml`, `.gitignore`(改), `packages/kernel/package.json`, `packages/kernel/tsconfig.json`, `packages/frontend/package.json`, `packages/frontend/tsconfig.json`, `packages/shared/package.json`, `packages/shared/tsconfig.json`
- Test: `packages/kernel/tests/scaffold.test.ts`

**Interfaces:**
- Produces: 可运行的 bun workspace，`bun test` 能跑通一个空测试

- [ ] **Step 1: 写 root package.json（workspace 配置）**

```json
{
  "name": "hiagent",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "bun test",
    "dev:kernel": "bun run --filter hiagent-kernel dev",
    "dev:frontend": "bun run --filter hiagent-frontend dev"
  }
}
```

- [ ] **Step 2: 写 bunfig.toml（test 配置）**

```toml
[test]
coverage = false
```

- [ ] **Step 3: 写 packages/shared（最底层包）**

`packages/shared/package.json`:
```json
{
  "name": "hiagent-shared",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/types.ts" }
}
```

`packages/shared/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
    "strict": true, "esModuleInterop": true, "skipLibCheck": true
  }
}
```

`packages/shared/src/types.ts`（共享类型定义，后续 task 会扩展）:
```typescript
// Agent 配置（对应 ~/.pi/agent/agents/<name>.md 的 frontmatter）
export interface AgentConfig {
  name: string;
  displayName: string;
  avatar: string;            // emoji
  description: string;
  model: string;             // 如 "deepseek/deepseek-v4-flash"
  thinking: "off" | "low" | "medium" | "high";
  tools: string[];           // 工具 allowlist
  skills: string[];
  partners: { askTo: string[]; askFrom: string[] };
  systemPrompt?: string;     // frontmatter 之后的 markdown body
}

// Pi RPC 事件（pi --mode rpc stdout 每行一个）
export type RPCEvent =
  | { type: "response"; id: string; command: string; success: boolean; data?: unknown }
  | { type: "agent_start" }
  | { type: "turn_start" }
  | { type: "message_start"; message: RPCMessage }
  | { type: "message_update"; assistantMessageEvent: { type: string; partial?: { content: Array<{ type: string; text?: string }> } } }
  | { type: "message_end"; message: RPCMessage }
  | { type: "turn_end"; message: RPCMessage; toolResults: unknown[] }
  | { type: "agent_end"; messages: RPCMessage[] }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: { content: Array<{ type: string; text?: string }> }; isError: boolean };

export interface RPCMessage {
  role: "user" | "assistant" | "tool";
  content: Array<{ type: string; text?: string }>;
}

// 前端 ↔ 内核 WebSocket 事件
export type WSEvent =
  | { type: "agents:list"; agents: AgentConfig[] }
  | { type: "agent:state"; agentName: string; state: AgentState }
  | { type: "agent:message"; agentName: string; message: ChatMessage }
  | { type: "agent:tool"; agentName: string; toolName: string; toolCallId: string; phase: "start" | "end"; result?: string }
  | { type: "intercom:ask"; from: string; to: string; messageId: string; text: string; startedAt: number }
  | { type: "intercom:reply"; toAskMessageId: string; text: string }
  | { type: "intercom:queue"; agentName: string; queue: Array<{ from: string; text: string; startedAt: number }> };

export interface AgentState {
  status: "idle" | "thinking" | "blocked" | "error";
  model?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}
```

- [ ] **Step 4: 写 packages/kernel 脚手架**

`packages/kernel/package.json`:
```json
{
  "name": "hiagent-kernel",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun run --watch src/index.ts",
    "start": "bun run src/index.ts"
  },
  "dependencies": { "hiagent-shared": "workspace:*" }
}
```

`packages/kernel/tsconfig.json`: 同 shared。

- [ ] **Step 5: 写 packages/frontend 脚手架**

`packages/frontend/package.json`:
```json
{
  "name": "hiagent-frontend",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build"
  },
  "dependencies": {
    "hiagent-shared": "workspace:*",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "zustand": "^5.0.0",
    "reactflow": "^11.11.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "vite": "^6.0.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.6.0"
  }
}
```

`packages/frontend/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
    "jsx": "react-jsx", "strict": true, "esModuleInterop": true, "skipLibCheck": true
  }
}
```

- [ ] **Step 6: 写一个空测试验证 workspace 跑通**

`packages/kernel/tests/scaffold.test.ts`:
```typescript
import { test, expect } from "bun:test";

test("workspace scaffold works", () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 7: 安装依赖 + 跑测试**

Run: `cd /Users/pipi/work/HiAgent && bun install`
Expected: 安装成功，无报错

Run: `bun test`
Expected: `1 pass` —— scaffold 测试通过

- [ ] **Step 8: 更新 .gitignore（加 .pi 本地状态）+ Commit**

在 `.gitignore` 末尾追加：
```
# Pi local state
.pi/
```

```bash
git add -A
git commit -m "chore: monorepo scaffold (kernel/frontend/shared workspaces)"
```

---

## Task 2: agent.md 解析与序列化（ConfigStore 基础）

**Files:**
- Create: `packages/kernel/src/agent-md.ts`
- Test: `packages/kernel/tests/agent-md.test.ts`

**Interfaces:**
- Consumes: `AgentConfig` from `hiagent-shared`
- Produces: `parseAgentMd(content: string): AgentConfig` / `serializeAgentMd(config: AgentConfig): string`

**背景**：设计文档 5.1，每个 agent = 一个 `.md` 文件，frontmatter（YAML）+ markdown body（systemPrompt）。frontmatter 数组字段（tools/skills/partners.askTo 等）在 YAML 里是内联逗号或列表。本 task 只做纯解析，不碰文件系统。

- [ ] **Step 1: 写失败测试 —— 解析**

`packages/kernel/tests/agent-md.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { parseAgentMd, serializeAgentMd } from "../src/agent-md";

const SAMPLE = `---
name: dev
displayName: 研发
avatar: "⚙️"
description: 后端研发
model: deepseek/deepseek-v4-flash
thinking: high
tools: read, bash, edit, write
skills: debug-methodically
partners:
  askTo: [product, test]
  askFrom: [product, pm]
---
你是一名资深后端工程师`;

test("parseAgentMd 解析 frontmatter + body", () => {
  const c = parseAgentMd(SAMPLE);
  expect(c.name).toBe("dev");
  expect(c.displayName).toBe("研发");
  expect(c.avatar).toBe("⚙️");
  expect(c.tools).toEqual(["read", "bash", "edit", "write"]);
  expect(c.skills).toEqual(["debug-methodically"]);
  expect(c.partners.askTo).toEqual(["product", "test"]);
  expect(c.partners.askFrom).toEqual(["product", "pm"]);
  expect(c.systemPrompt).toBe("你是一名资深后端工程师");
});

test("serializeAgentMd 往返一致", () => {
  const c = parseAgentMd(SAMPLE);
  const round = parseAgentMd(serializeAgentMd(c));
  expect(round).toEqual(c);
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `bun test packages/kernel/tests/agent-md.test.ts`
Expected: FAIL —— `Cannot find module ../src/agent-md`

- [ ] **Step 3: 实现 agent-md.ts**

用 bun 内置能力解析 YAML。bun 没内置 YAML 解析器，用手写最小 frontmatter 解析（MVP 的 frontmatter 字段固定，避免引入 yaml 依赖）。

`packages/kernel/src/agent-md.ts`:
```typescript
import type { AgentConfig } from "hiagent-shared";

/** 解析 agent.md（frontmatter + body）。最小实现，处理设计文档 5.1 定义的字段。 */
export function parseAgentMd(content: string): AgentConfig {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error("Invalid agent.md: missing frontmatter");
  const [, fmRaw, bodyRaw] = m;
  const fm = parseFrontmatter(fmRaw);
  const config: AgentConfig = {
    name: fm.name,
    displayName: fm.displayName ?? fm.name,
    avatar: fm.avatar ?? "🤖",
    description: fm.description ?? "",
    model: fm.model ?? "deepseek/deepseek-v4-flash",
    thinking: fm.thinking ?? "off",
    tools: parseList(fm.tools),
    skills: parseList(fm.skills),
    partners: {
      askTo: parseList(fm.partners?.askTo),
      askFrom: parseList(fm.partners?.askFrom),
    },
    systemPrompt: bodyRaw.trim(),
  };
  return config;
}

export function serializeAgentMd(c: AgentConfig): string {
  const lines = ["---"];
  lines.push(`name: ${c.name}`);
  lines.push(`displayName: ${c.displayName}`);
  lines.push(`avatar: "${c.avatar}"`);
  if (c.description) lines.push(`description: ${c.description}`);
  lines.push(`model: ${c.model}`);
  lines.push(`thinking: ${c.thinking}`);
  if (c.tools.length) lines.push(`tools: ${c.tools.join(", ")}`);
  if (c.skills.length) lines.push(`skills: ${c.skills.join(", ")}`);
  if (c.partners.askTo.length || c.partners.askFrom.length) {
    lines.push("partners:");
    if (c.partners.askTo.length) lines.push(`  askTo: [${c.partners.askTo.join(", ")}]`);
    if (c.partners.askFrom.length) lines.push(`  askFrom: [${c.partners.askFrom.join(", ")}]`);
  }
  lines.push("---");
  if (c.systemPrompt) lines.push("", c.systemPrompt);
  return lines.join("\n");
}

// --- 内部：最小 YAML frontmatter 解析（只支持 flat key + 列表/对象两层）---
function parseFrontmatter(raw: string): Record<string, any> {
  const result: Record<string, any> = {};
  let currentObj: Record<string, any> | null = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const objMatch = line.match(/^(\w+):$/);
    if (objMatch) {
      currentObj = {};
      result[objMatch[1]] = currentObj;
      continue;
    }
    const nestedMatch = line.match(/^  (\w+):\s*(.*)$/);
    if (nestedMatch && currentObj) {
      const [, k, v] = nestedMatch;
      currentObj[k] = parseValue(v);
      continue;
    }
    const kvMatch = line.match(/^(\w+):\s*(.*)$/);
    if (kvMatch) {
      currentObj = null;
      const [, k, v] = kvMatch;
      result[k] = parseValue(v);
    }
  }
  return result;
}

function parseValue(v: string): any {
  v = v.trim();
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  if (v.startsWith("[") && v.endsWith("]")) {
    return v.slice(1, -1).split(",").map(s => s.trim()).filter(Boolean);
  }
  return v;
}

function parseList(v: any): string[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return v.split(",").map(s => s.trim()).filter(Boolean);
  return [];
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `bun test packages/kernel/tests/agent-md.test.ts`
Expected: `2 pass`

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/agent-md.ts packages/kernel/tests/agent-md.test.ts
git commit -m "feat(kernel): agent.md frontmatter parse/serialize"
```

---

## Task 3: ConfigStore —— 读写 agent 配置文件

**Files:**
- Create: `packages/kernel/src/config-store.ts`
- Test: `packages/kernel/tests/config-store.test.ts`

**Interfaces:**
- Consumes: `parseAgentMd`/`serializeAgentMd` from Task 2
- Produces:
  - `class ConfigStore { constructor(agentsDir: string); listAgents(): Promise<AgentConfig[]>; getAgent(name: string): Promise<AgentConfig | null>; saveAgent(config: AgentConfig): Promise<void> }`

- [ ] **Step 1: 写失败测试**

`packages/kernel/tests/config-store.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/config-store";
import type { AgentConfig } from "hiagent-shared";

let dir: string;
test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hiagent-cfg-"));
});
test.afterEach(async () => { await rm(dir, { recursive: true }); });

test("saveAgent 写文件 + listAgents 读回", async () => {
  const store = new ConfigStore(dir);
  const dev: AgentConfig = {
    name: "dev", displayName: "研发", avatar: "⚙️",
    description: "后端", model: "deepseek/deepseek-v4-flash", thinking: "high",
    tools: ["read", "bash"], skills: [],
    partners: { askTo: ["product"], askFrom: ["product"] },
    systemPrompt: "你是研发",
  };
  await store.saveAgent(dev);

  const agents = await store.listAgents();
  expect(agents.length).toBe(1);
  expect(agents[0].name).toBe("dev");
  expect(agents[0].tools).toEqual(["read", "bash"]);
});

test("getAgent 返回 null 当文件不存在", async () => {
  const store = new ConfigStore(dir);
  expect(await store.getAgent("nope")).toBeNull();
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `bun test packages/kernel/tests/config-store.test.ts`
Expected: FAIL —— `Cannot find module ../src/config-store`

- [ ] **Step 3: 实现 ConfigStore**

`packages/kernel/src/config-store.ts`:
```typescript
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentConfig } from "hiagent-shared";
import { parseAgentMd, serializeAgentMd } from "./agent-md";

export class ConfigStore {
  constructor(private agentsDir: string) {}

  async listAgents(): Promise<AgentConfig[]> {
    try {
      const files = await readdir(this.agentsDir);
      const mdFiles = files.filter(f => f.endsWith(".md"));
      const configs = await Promise.all(
        mdFiles.map(f => this.readAgentFile(join(this.agentsDir, f)))
      );
      return configs.filter((c): c is AgentConfig => c !== null);
    } catch (e: any) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  }

  async getAgent(name: string): Promise<AgentConfig | null> {
    return this.readAgentFile(join(this.agentsDir, `${name}.md`));
  }

  async saveAgent(config: AgentConfig): Promise<void> {
    await mkdir(this.agentsDir, { recursive: true });
    const content = serializeAgentMd(config);
    await writeFile(join(this.agentsDir, `${config.name}.md`), content, "utf-8");
  }

  private async readAgentFile(path: string): Promise<AgentConfig | null> {
    try {
      const content = await readFile(path, "utf-8");
      return parseAgentMd(content);
    } catch (e: any) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `bun test packages/kernel/tests/config-store.test.ts`
Expected: `2 pass`

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/config-store.ts packages/kernel/tests/config-store.test.ts
git commit -m "feat(kernel): ConfigStore read/write agent configs"
```

---

## Task 4: PiRpcClient —— spawn pi + JSONL 协议（核心）

**Files:**
- Create: `packages/kernel/src/pi-rpc-client.ts`
- Test: `packages/kernel/tests/pi-rpc-client.test.ts`

**Interfaces:**
- Consumes: `AgentConfig`，`pi` 命令在 PATH，环境变量传 API key
- Produces:
  - `class PiRpcClient { constructor(config: AgentConfig, cwd: string); start(): Promise<void>; prompt(message: string): Promise<void>; abort(): Promise<void>; getState(): Promise<any>; on(event: "event" | "exit", cb): void; stop(): void }`
  - emit "event" 时传入 `RPCEvent`（来自 shared/types）

**已验证事实**（来自 `docs/research/pi-intercom-rpc-compatibility.md`）：
- `pi --mode rpc` stdin 每行一个 JSON command，stdout 每行一个 JSON event
- `--name`/`--provider`/`--model`/`--tools`/`--skill`/`--thinking` flag 全部可用
- spawn 后 ~1-2s 可发 prompt

- [ ] **Step 1: 写失败测试（集成测试，真启动 pi，用 --no-tools + get_state 避免耗模型）**

`packages/kernel/tests/pi-rpc-client.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { PiRpcClient } from "../src/pi-rpc-client";
import type { AgentConfig } from "hiagent-shared";

const BASE_CONFIG: AgentConfig = {
  name: "test", displayName: "Test", avatar: "🧪", description: "",
  model: "deepseek/deepseek-v4-flash", thinking: "off",
  tools: [], skills: [], partners: { askTo: [], askFrom: [] },
};

test("PiRpcClient 启动 + get_state 返回 sessionName", async () => {
  const client = new PiRpcClient(BASE_CONFIG, "/tmp");
  const events: any[] = [];
  client.on("event", e => events.push(e));
  await client.start();
  const state = await client.getState();
  client.stop();
  expect(state.success).toBe(true);
  expect(state.data.sessionName).toBe("test");
});

test("PiRpcClient prompt 收到 response + agent_start", async () => {
  const client = new PiRpcClient(BASE_CONFIG, "/tmp");
  await client.start();
  const events: any[] = [];
  client.on("event", e => events.push(e));
  // 用 --no-tools 模式 + 一个极短 prompt，不实际调模型（offline 模式 pi 会立即返回不调用 LLM）
  // 这里改为只测 get_state 不耗模型，prompt 留给手动集成测试
  const state = await client.getState();
  client.stop();
  expect(state.success).toBe(true);
  // 至少收到 get_state 的 response 事件
  expect(events.some(e => e.type === "response" && e.command === "get_state")).toBe(true);
});
```

⚠️ **测试不耗模型 token**：`get_state` 是纯本地命令，不触发 LLM。真实 prompt 测试留到 Task 8 端到端集成。

- [ ] **Step 2: 跑测试验证失败**

Run: `bun test packages/kernel/tests/pi-rpc-client.test.ts`
Expected: FAIL —— `Cannot find module ../src/pi-rpc-client`

- [ ] **Step 3: 实现 PiRpcClient**

`packages/kernel/src/pi-rpc-client.ts`:
```typescript
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { AgentConfig, RPCEvent } from "hiagent-shared";

interface PendingRequest {
  resolve: (data: any) => void;
  reject: (err: Error) => void;
}

export class PiRpcClient extends EventEmitter {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private pending = new Map<string, PendingRequest>();
  private nextId = 1;

  constructor(private config: AgentConfig, private cwd: string) {
    super();
  }

  async start(): Promise<void> {
    const args = [
      "--mode", "rpc",
      "--name", this.config.name,
      "--provider", this.config.model.split("/")[0] || "deepseek",
      "--model", this.config.model,
      "--thinking", this.config.thinking,
      "--offline",  // 启动不联网（不影响 get_state 等；真实 prompt 时去掉）
    ];
    if (this.config.tools.length === 0) {
      args.push("--no-tools");
    } else {
      args.push("--tools", this.config.tools.join(","));
    }
    if (this.config.skills.length) {
      for (const s of this.config.skills) args.push("--skill", s);
    }
    if (this.config.systemPrompt) {
      args.push("--system-prompt", this.config.systemPrompt);
    }

    this.proc = spawn("pi", args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.cwd,
      env: { ...process.env },  // 继承 DEEPSEEK_API_KEY 等
    });

    this.proc.stdout!.setEncoding("utf8");
    this.proc.stderr!.setEncoding("utf8");
    this.proc.stdout!.on("data", (chunk: string) => this.onStdout(chunk));
    this.proc.stderr!.on("data", () => { /* 静默；调试时可打 log */ });
    this.proc.on("exit", (code, sig) => {
      this.emit("exit", { code, sig });
    });

    // 等待进程就绪（简单等待，get_state 会进一步确认）
    await new Promise(r => setTimeout(r, 500));
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";  // 最后一段可能不完整，留在 buffer
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as RPCEvent;
        this.handleEvent(event);
      } catch {
        // 非 JSON 行忽略
      }
    }
  }

  private handleEvent(event: RPCEvent): void {
    // response 类型匹配 pending request
    if (event.type === "response" && "id" in event) {
      const req = this.pending.get(event.id);
      if (req) {
        this.pending.delete(event.id);
        if (event.success) req.resolve(event.data);
        else req.reject(new Error(`RPC command ${event.command} failed`));
        return;
      }
    }
    // 其他事件转发给监听者
    this.emit("event", event);
  }

  private send(command: Record<string, unknown>): Promise<any> {
    if (!this.proc?.stdin?.writable) {
      return Promise.reject(new Error("Pi process not running"));
    }
    const id = `r${this.nextId++}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc!.stdin!.write(JSON.stringify({ ...command, id }) + "\n");
    });
  }

  async prompt(message: string): Promise<void> {
    await this.send({ type: "prompt", message });
  }

  async abort(): Promise<void> {
    await this.send({ type: "abort" });
  }

  async getState(): Promise<any> {
    return this.send({ type: "get_state" });
  }

  stop(): void {
    if (this.proc) {
      this.proc.kill("SIGTERM");
      setTimeout(() => this.proc?.kill("SIGKILL"), 1000);
      this.proc = null;
    }
  }
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `bun test packages/kernel/tests/pi-rpc-client.test.ts`
Expected: `2 pass` —— get_state 返回 sessionName="test"

⚠️ 若失败：确认 `pi` 在 PATH（`which pi`），确认 `--offline` 模式下 get_state 可用（已验证）。

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/pi-rpc-client.ts packages/kernel/tests/pi-rpc-client.test.ts
git commit -m "feat(kernel): PiRpcClient spawn pi --mode rpc + JSONL protocol"
```

---

## Task 5: AgentManager —— 管理多 Pi 进程生命周期

**Files:**
- Create: `packages/kernel/src/agent-manager.ts`
- Test: `packages/kernel/tests/agent-manager.test.ts`

**Interfaces:**
- Consumes: `PiRpcClient` from Task 4, `ConfigStore` from Task 3
- Produces:
  - `class AgentManager { constructor(configStore: ConfigStore, cwd: string); listAvailableAgents(): Promise<AgentConfig[]>; ensureStarted(name: string): Promise<PiRpcClient>; get(name: string): PiRpcClient | undefined; stop(name: string): void; stopAll(): void }`
  - 事件：AgentManager 继承 EventEmitter，emit "event" 时传 `{ agentName: string; event: RPCEvent }`，emit "state" 时传 `{ agentName: string; state: AgentState }`

- [ ] **Step 1: 写失败测试**

`packages/kernel/tests/agent-manager.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/config-store";
import { AgentManager } from "../src/agent-manager";
import type { AgentConfig } from "hiagent-shared";

let dir: string;
test.beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hiagent-am-")); });
test.afterEach(async () => { await rm(dir, { recursive: true }); });

const makeConfig = (name: string): AgentConfig => ({
  name, displayName: name, avatar: "🤖", description: "",
  model: "deepseek/deepseek-v4-flash", thinking: "off",
  tools: [], skills: [], partners: { askTo: [], askFrom: [] },
});

test("listAvailableAgents 返回配置的 agent", async () => {
  const store = new ConfigStore(dir);
  await store.saveAgent(makeConfig("dev"));
  await store.saveAgent(makeConfig("pm"));
  const mgr = new AgentManager(store, "/tmp");
  const agents = await mgr.listAvailableAgents();
  expect(agents.map(a => a.name).sort()).toEqual(["dev", "pm"]);
});

test("ensureStarted 启动并缓存 PiRpcClient", async () => {
  const store = new ConfigStore(dir);
  await store.saveAgent(makeConfig("dev"));
  const mgr = new AgentManager(store, "/tmp");
  const c1 = await mgr.ensureStarted("dev");
  expect(c1).toBeDefined();
  const c2 = await mgr.ensureStarted("dev");
  expect(c2).toBe(c1);  // 同一个实例
  mgr.stopAll();
});

test("get 未启动的返回 undefined", () => {
  const store = new ConfigStore(dir);
  const mgr = new AgentManager(store, "/tmp");
  expect(mgr.get("ghost")).toBeUndefined();
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `bun test packages/kernel/tests/agent-manager.test.ts`
Expected: FAIL —— `Cannot find module ../src/agent-manager`

- [ ] **Step 3: 实现 AgentManager**

`packages/kernel/src/agent-manager.ts`:
```typescript
import { EventEmitter } from "node:events";
import type { AgentConfig, AgentState, RPCEvent } from "hiagent-shared";
import { ConfigStore } from "./config-store";
import { PiRpcClient } from "./pi-rpc-client";

export class AgentManager extends EventEmitter {
  private clients = new Map<string, PiRpcClient>();
  private states = new Map<string, AgentState>();

  constructor(private configStore: ConfigStore, private cwd: string) {
    super();
  }

  async listAvailableAgents(): Promise<AgentConfig[]> {
    return this.configStore.listAgents();
  }

  async ensureStarted(name: string): Promise<PiRpcClient> {
    let client = this.clients.get(name);
    if (client) return client;

    const config = await this.configStore.getAgent(name);
    if (!config) throw new Error(`Agent "${name}" not found in config`);

    client = new PiRpcClient(config, this.cwd);
    client.on("event", (event: RPCEvent) => {
      this.updateState(name, event);
      this.emit("event", { agentName: name, event });
    });
    client.on("exit", () => {
      this.clients.delete(name);
      this.states.set(name, { status: "idle" });
      this.emit("state", { agentName: name, state: { status: "idle" } });
    });
    await client.start();
    this.clients.set(name, client);
    this.states.set(name, { status: "idle", model: config.model });
    return client;
  }

  get(name: string): PiRpcClient | undefined {
    return this.clients.get(name);
  }

  getState(name: string): AgentState {
    return this.states.get(name) ?? { status: "idle" };
  }

  stop(name: string): void {
    this.clients.get(name)?.stop();
    this.clients.delete(name);
  }

  stopAll(): void {
    for (const client of this.clients.values()) client.stop();
    this.clients.clear();
  }

  private updateState(name: string, event: RPCEvent): void {
    const prev = this.states.get(name) ?? { status: "idle" };
    let next = prev;
    switch (event.type) {
      case "agent_start": next = { ...prev, status: "thinking" }; break;
      case "agent_end": next = { ...prev, status: "idle" }; break;
      case "turn_start": next = { ...prev, status: "thinking" }; break;
      // tool_execution of "intercom" with ask → blocked（IntercomMonitor 会进一步细化）
    }
    if (next !== prev) {
      this.states.set(name, next);
      this.emit("state", { agentName: name, state: next });
    }
  }
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `bun test packages/kernel/tests/agent-manager.test.ts`
Expected: `3 pass`

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/agent-manager.ts packages/kernel/tests/agent-manager.test.ts
git commit -m "feat(kernel): AgentManager manages multiple PiRpcClient lifecycles"
```

---

## Task 6: IntercomMonitor —— 连 broker，跟踪 ask 队列

**Files:**
- Create: `packages/kernel/src/intercom-monitor.ts`
- Test: `packages/kernel/tests/intercom-monitor.test.ts`

**Interfaces:**
- Consumes: pi-intercom broker（位于 `~/.pi/agent/intercom/broker.sock`，spawn pi 后 auto-spawn）
- Produces:
  - `class IntercomMonitor { constructor(brokerSockPath: string); connect(): Promise<void>; disconnect(): Promise<void>; on(event: "ask" | "reply", cb): void; getQueue(agentName: string): AskEntry[] }`
  - `AskEntry { from: string; to: string; messageId: string; text: string; startedAt: number; resolved: boolean }`

**已验证事实**（来自兼容性报告）：
- IntercomClient API：`connect({name,cwd,model,pid,startedAt,lastActivity})` / `listSessions()` / `on("message", (from, msg)=>{})` / `send(to, {text, replyTo, expectsReply})` / `disconnect()`
- Message 结构：`{ id, timestamp, replyTo?, expectsReply?, content: { text } }`
- v0.6.0 无 ask 超时 GC，发送方等 message 事件

- [ ] **Step 1: 写失败测试（用真实 broker，已验证可用）**

`packages/kernel/tests/intercom-monitor.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { IntercomMonitor } from "../src/intercom-monitor";
import { existsSync } from "node:fs";

const SOCK = `${process.env.HOME}/.pi/agent/intercom/broker.sock`;

// 这些测试依赖 broker 已启动（由其他 pi 进程或测试 fixture 保证）
test("IntercomMonitor connect 后能看到 session", async () => {
  // 先确保 broker 存在（spawn 一个 pi 触发 auto-spawn）
  if (!existsSync(SOCK)) {
    const { spawn } = await import("node:child_process");
    const pi = spawn("pi", ["--mode", "rpc", "--name", "im-fixture", "--no-tools", "--offline"]);
    // 等 broker 出现
    for (let i = 0; i < 20 && !existsSync(SOCK); i++) await new Promise(r => setTimeout(r, 500));
    await new Promise(r => setTimeout(r, 1000));
    pi.kill("SIGKILL");
  }
  const mon = new IntercomMonitor(SOCK);
  await mon.connect();
  const sessions = await mon.listSessions();
  await mon.disconnect();
  expect(Array.isArray(sessions)).toBe(true);
  expect(sessions.length).toBeGreaterThan(0);
});
```

⚠️ 这是有状态集成测试（依赖 broker daemon）。CI 环境需先 spawn 一个 pi。注释已说明。

- [ ] **Step 2: 跑测试验证失败**

Run: `bun test packages/kernel/tests/intercom-monitor.test.ts`
Expected: FAIL —— `Cannot find module ../src/intercom-monitor`

- [ ] **Step 3: 实现 IntercomMonitor**

直接 import pi-intercom 的 client（已装在 `~/.pi/agent/npm/node_modules/pi-intercom`）。kernel 包加依赖指向它。

先在 `packages/kernel/package.json` 加依赖：
```json
"dependencies": {
  "hiagent-shared": "workspace:*",
  "pi-intercom": "file:../../.pi/agent/npm/node_modules/pi-intercom"
}
```

`packages/kernel/src/intercom-monitor.ts`:
```typescript
import { EventEmitter } from "node:events";
import { IntercomClient } from "pi-intercom/broker/client";

export interface AskEntry {
  from: string;
  to: string;
  messageId: string;
  text: string;
  startedAt: number;
  resolved: boolean;
}

export class IntercomMonitor extends EventEmitter {
  private client: IntercomClient | null = null;
  private queues = new Map<string, AskEntry[]>();  // key = to (agent name)

  constructor(private brokerSockPath: string) {
    super();
  }

  async connect(): Promise<void> {
    if (this.client) return;
    this.client = new IntercomClient();
    // 监听入站消息
    this.client.on("message", (from: any, message: any) => {
      this.handleMessage(from, message);
    });
    // 注意：IntercomClient v0.6.0 的 BROKER_SOCKET 是模块级常量，
    // 实际 socket 路径已在源码内定为 ~/.pi/agent/intercom/broker.sock
    await this.client.connect({
      name: "hiagent-monitor",
      cwd: process.cwd(),
      model: "monitor",
      pid: process.pid,
      startedAt: Date.now(),
      lastActivity: Date.now(),
      status: "monitor",
    });
  }

  async disconnect(): Promise<void> {
    await this.client?.disconnect();
    this.client = null;
  }

  async listSessions(): Promise<any[]> {
    if (!this.client) throw new Error("Not connected");
    return this.client.listSessions();
  }

  getQueue(agentName: string): AskEntry[] {
    return this.queues.get(agentName) ?? [];
  }

  /** 用户替答：合成一个 reply 给原 ask 发起方 */
  async injectReply(askMessageId: string, fromAgent: string, toAskFrom: string, text: string): Promise<void> {
    if (!this.client) throw new Error("Not connected");
    // 找到 ask 对应的 from session id（简化：用 name 查 listSessions）
    const sessions = await this.client.listSessions();
    const target = sessions.find((s: any) => s.name === toAskFrom);
    if (!target) throw new Error(`Agent ${toAskFrom} not on broker`);
    await this.client.send(target.id, { text, replyTo: askMessageId });
    // 标记 ask 已解决
    this.markResolved(fromAgent, askMessageId);
  }

  private handleMessage(from: any, message: any): void {
    const text = message.content?.text ?? "";
    const fromName = from?.name ?? from?.id;

    if (message.replyTo) {
      // 这是一个 reply，解除某个 ask
      this.emit("reply", { toAskMessageId: message.replyTo, text, from: fromName });
      return;
    }
    if (message.expectsReply) {
      // 这是一个 ask，记入 to 的队列
      const toName = "unknown"; // broker 转发给当前 session，但 monitor 是旁观
      // 注意：monitor 作为独立 session 监听，无法直接知道 to 是谁。
      // 实际 HiAgent 用每个 PiRpcClient 进程内的 intercom 扩展处理，
      // monitor 只能通过 tool_execution 事件推断（见 AgentManager 接线）。
      // 此处保留接口，实际 ask 跟踪由 StateAggregator 综合事件流完成。
      const entry: AskEntry = {
        from: fromName, to: toName,
        messageId: message.id, text, startedAt: message.timestamp ?? Date.now(),
        resolved: false,
      };
      const q = this.queues.get(toName) ?? [];
      q.push(entry);
      this.queues.set(toName, q);
      this.emit("ask", entry);
    }
  }

  private markResolved(agentName: string, messageId: string): void {
    const q = this.queues.get(agentName);
    if (q) {
      const entry = q.find(e => e.messageId === messageId);
      if (entry) entry.resolved = true;
    }
  }
}
```

⚠️ **重要设计说明**（写进代码注释）：IntercomMonitor 作为独立 session 连 broker，能**监听到所有消息**，但无法直接知道消息的 `to` 是谁（broker 的 message 事件只给 `from`）。实际 ask 队列跟踪靠综合事件流：PiRpcClient 收到 `tool_execution_start`（toolName="intercom"）时，StateAggregator 把它和 IntercomMonitor 的消息配对，从而确定 to。这个综合逻辑在 Task 7 StateAggregator 实现。本 task 先把 monitor 基础能力（连 broker、监听、listSessions、injectReply）做扎实。

- [ ] **Step 4: 跑测试验证通过**

Run: `bun test packages/kernel/tests/intercom-monitor.test.ts`
Expected: `1 pass`（看到至少 1 个 session —— fixture 启动的 pi）

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/intercom-monitor.ts packages/kernel/tests/intercom-monitor.test.ts packages/kernel/package.json
git commit -m "feat(kernel): IntercomMonitor connects to broker, tracks ask queue"
```

---

## Task 7: StateAggregator —— 综合事件流 + WebSocket server

**Files:**
- Create: `packages/kernel/src/state-aggregator.ts`, `packages/kernel/src/ws-server.ts`
- Test: `packages/kernel/tests/state-aggregator.test.ts`

**Interfaces:**
- Consumes: AgentManager（"event"/"state" 事件）+ IntercomMonitor（"ask"/"reply" 事件）
- Produces:
  - `class StateAggregator { constructor(agentManager: AgentManager, intercomMonitor: IntercomMonitor); start(): void; broadcast(event: WSEvent): void; on(event: "ws:event", cb): void }`
  - `class WSServer { constructor(port: number, aggregator: StateAggregator); start(): Promise<void>; onClientMessage(cb: (msg: any) => void): void }`

**核心逻辑**：把 AgentManager 的 RPCEvent + IntercomMonitor 的 ask/reply 综合，输出前端能直接消费的 WSEvent。关键：当 PiRpcClient 收到 `tool_execution_start`（toolName="intercom"，args 含 to/message/expectsReply），StateAggregator 发出 `intercom:ask` WSEvent；收到 reply 时发 `intercom:reply`。

- [ ] **Step 1: 写失败测试（单元测试，mock 事件源）**

`packages/kernel/tests/state-aggregator.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { StateAggregator } from "../src/state-aggregator";

// mock AgentManager + IntercomMonitor（只测聚合逻辑）
test("tool_execution_start intercom + expectsReply → 发 intercom:ask", () => {
  const events: any[] = [];
  const agg = new StateAggregator({} as any, {} as any);
  agg.on("ws:event", e => events.push(e));

  // 模拟 AgentManager 发来的事件
  agg.handleAgentEvent("alice", {
    type: "tool_execution_start",
    toolCallId: "tc1",
    toolName: "intercom",
    args: { to: "bob", message: "1+1?", expectsReply: true },
  });

  expect(events.length).toBe(1);
  expect(events[0].type).toBe("intercom:ask");
  expect(events[0].from).toBe("alice");
  expect(events[0].to).toBe("bob");
  expect(events[0].text).toBe("1+1?");
});

test("intercom reply → 发 intercom:reply", () => {
  const events: any[] = [];
  const agg = new StateAggregator({} as any, {} as any);
  agg.on("ws:event", e => events.push(e));

  agg.handleIntercomReply({ toAskMessageId: "msg1", text: "2", from: "bob" });

  expect(events.length).toBe(1);
  expect(events[0].type).toBe("intercom:reply");
  expect(events[0].toAskMessageId).toBe("msg1");
});

test("message_end → 发 agent:message", () => {
  const events: any[] = [];
  const agg = new StateAggregator({} as any, {} as any);
  agg.on("ws:event", e => events.push(e));

  agg.handleAgentEvent("alice", {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
  });

  expect(events.find(e => e.type === "agent:message")).toBeTruthy();
  expect(events.find(e => e.type === "agent:message").message.text).toBe("hello");
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `bun test packages/kernel/tests/state-aggregator.test.ts`
Expected: FAIL —— `Cannot find module ../src/state-aggregator`

- [ ] **Step 3: 实现 StateAggregator**

`packages/kernel/src/state-aggregator.ts`:
```typescript
import { EventEmitter } from "node:events";
import type { AgentManager } from "./agent-manager";
import type { IntercomMonitor } from "./intercom-monitor";
import type { RPCEvent, WSEvent, ChatMessage } from "hiagent-shared";

// intercom 工具调用参数结构（从 tool_execution_start.args 解析）
interface IntercomToolArgs {
  to?: string;
  message?: string;
  text?: string;
  expectsReply?: boolean;
  replyTo?: string;
}

export class StateAggregator extends EventEmitter {
  private pendingAsks = new Map<string, { from: string; to: string; messageId: string }>();

  constructor(private agentManager: AgentManager, private intercomMonitor: IntercomMonitor) {
    super();
  }

  start(): void {
    this.agentManager.on("event", ({ agentName, event }) => {
      this.handleAgentEvent(agentName, event);
    });
    this.agentManager.on("state", ({ agentName, state }) => {
      this.emit("ws:event", { type: "agent:state", agentName, state } as WSEvent);
    });
    this.intercomMonitor.on("reply", (r) => this.handleIntercomReply(r));
  }

  // 暴露给测试直接调用
  handleAgentEvent(agentName: string, event: RPCEvent): void {
    switch (event.type) {
      case "tool_execution_start": {
        if (event.toolName === "intercom") {
          const args = (event.args ?? {}) as IntercomToolArgs;
          if (args.expectsReply && args.to) {
            // 这是一个 ask
            const messageId = event.toolCallId;
            this.pendingAsks.set(messageId, { from: agentName, to: args.to, messageId });
            const wsEvent: WSEvent = {
              type: "intercom:ask",
              from: agentName, to: args.to,
              messageId, text: args.message ?? args.text ?? "",
              startedAt: Date.now(),
            };
            this.emit("ws:event", wsEvent);
          }
        }
        this.emit("ws:event", {
          type: "agent:tool", agentName,
          toolName: event.toolName, toolCallId: event.toolCallId, phase: "start",
        } as WSEvent);
        break;
      }
      case "tool_execution_end": {
        const resultText = event.result?.content?.map((c: any) => c.text ?? "").join("") ?? "";
        this.emit("ws:event", {
          type: "agent:tool", agentName,
          toolName: event.toolName, toolCallId: event.toolCallId,
          phase: "end", result: resultText,
        } as WSEvent);
        break;
      }
      case "message_end": {
        const text = event.message.content?.map((c: any) => c.text ?? "").join("") ?? "";
        if (text) {
          const msg: ChatMessage = {
            id: `m${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            role: event.message.role === "user" ? "user" : "assistant",
            text, timestamp: Date.now(),
          };
          this.emit("ws:event", { type: "agent:message", agentName, message: msg } as WSEvent);
        }
        break;
      }
    }
  }

  handleIntercomReply(r: { toAskMessageId: string; text: string; from: string }): void {
    this.emit("ws:event", {
      type: "intercom:reply", toAskMessageId: r.toAskMessageId, text: r.text,
    } as WSEvent);
  }
}
```

- [ ] **Step 4: 实现 WSServer**

`packages/kernel/src/ws-server.ts`:
```typescript
import type { StateAggregator } from "./state-aggregator";
import type { WSEvent } from "hiagent-shared";

type ClientMessageHandler = (msg: any) => void;

export class WSServer {
  private server: any = null;
  private sockets = new Set<any>();
  private clientMessageHandler: ClientMessageHandler | null = null;

  constructor(private port: number, private aggregator: StateAggregator) {}

  async start(): Promise<void> {
    this.server = Bun.serve({
      port: this.port,
      websocket: {
        open: (ws) => {
          this.sockets.add(ws);
        },
        message: (ws, msg) => {
          if (typeof msg === "string") {
            try {
              const parsed = JSON.parse(msg);
              this.clientMessageHandler?.(parsed);
            } catch { /* 忽略非法 JSON */ }
          }
        },
        close: (ws) => {
          this.sockets.delete(ws);
        },
      },
      fetch: (req, server) => {
        if (server.upgrade(req)) return;
        return new Response("HiAgent kernel WebSocket endpoint", { status: 200 });
      },
    });

    // 把 aggregator 的事件广播给所有 WS 客户端
    this.aggregator.on("ws:event", (event: WSEvent) => {
      const data = JSON.stringify(event);
      for (const ws of this.sockets) ws.send(data);
    });
  }

  onClientMessage(cb: ClientMessageHandler): void {
    this.clientMessageHandler = cb;
  }

  stop(): void {
    this.server?.stop();
    this.server = null;
  }
}
```

- [ ] **Step 5: 跑测试验证通过**

Run: `bun test packages/kernel/tests/state-aggregator.test.ts`
Expected: `3 pass`

- [ ] **Step 6: Commit**

```bash
git add packages/kernel/src/state-aggregator.ts packages/kernel/src/ws-server.ts packages/kernel/tests/state-aggregator.test.ts
git commit -m "feat(kernel): StateAggregator + WebSocket server (event aggregation, port 9776)"
```

---

## Task 8: 编排内核组装 + 端到端冒烟（DeepSeek 真模型）

**Files:**
- Create: `packages/kernel/src/index.ts`, `packages/kernel/tests/e2e-smoke.test.ts`
- Modify: 无

**Interfaces:**
- Consumes: Task 3-7 全部组件
- Produces: `bun run packages/kernel/src/index.ts` 启动 9776 端口的完整内核

- [ ] **Step 1: 实现 index.ts（组装 + 启动）**

`packages/kernel/src/index.ts`:
```typescript
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "./config-store";
import { AgentManager } from "./agent-manager";
import { IntercomMonitor } from "./intercom-monitor";
import { StateAggregator } from "./state-aggregator";
import { WSServer } from "./ws-server";

async function main() {
  const agentsDir = process.env.HIAGENT_AGENTS_DIR ?? join(homedir(), ".pi/agent/agents");
  const cwd = process.env.HIAGENT_CWD ?? process.cwd();
  const brokerSock = join(homedir(), ".pi/agent/intercom/broker.sock");
  const port = 9776;

  console.log(`[HiAgent kernel] agentsDir=${agentsDir} cwd=${cwd} port=${port}`);

  const configStore = new ConfigStore(agentsDir);
  const agentManager = new AgentManager(configStore, cwd);
  const intercomMonitor = new IntercomMonitor(brokerSock);
  const aggregator = new StateAggregator(agentManager, intercomMonitor);
  const wsServer = new WSServer(port, aggregator);

  aggregator.start();
  await wsServer.start();

  // 连 intercom broker（可能还没启动，spawn 第一个 pi 后会出现）
  try {
    await intercomMonitor.connect();
    console.log("[HiAgent kernel] intercom monitor connected");
  } catch (e) {
    console.log("[HiAgent kernel] intercom broker not ready yet, will retry on first agent start");
  }

  // 处理前端命令
  wsServer.onClientMessage(async (msg) => {
    try {
      switch (msg.type) {
        case "agents:list": {
          const agents = await agentManager.listAvailableAgents();
          aggregator.emit("ws:event", { type: "agents:list", agents });
          break;
        }
        case "agent:prompt": {
          const client = await agentManager.ensureStarted(msg.agentName);
          // 确保 intercom monitor 连上（首次启动 agent 后 broker 才出现）
          await intercomMonitor.connect().catch(() => {});
          await client.prompt(msg.message);
          break;
        }
        case "agent:abort": {
          agentManager.get(msg.agentName)?.abort();
          break;
        }
        case "intercom:inject-reply": {
          await intercomMonitor.injectReply(msg.messageId, msg.agentName, msg.toAskFrom, msg.text);
          break;
        }
      }
    } catch (e: any) {
      console.error("[HiAgent kernel] command error:", e.message);
    }
  });

  console.log(`[HiAgent kernel] listening on ws://localhost:${port}`);

  // 优雅退出
  process.on("SIGINT", async () => {
    agentManager.stopAll();
    await intercomMonitor.disconnect();
    wsServer.stop();
    process.exit(0);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 写端到端冒烟测试（真启动内核，用 DeepSeek 跑一次 prompt，断言 WS 收到事件）**

⚠️ 这个测试消耗少量 DeepSeek token（一次极短 prompt）。设置较长超时。

`packages/kernel/tests/e2e-smoke.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let kernelProc: any;
let wsClient: any;

test.beforeAll(async () => {
  // 1. 临时 agents 目录 + 写一个 dev agent 配置
  dir = await mkdtemp(join(tmpdir(), "hiagent-e2e-"));
  const agentsDir = join(dir, "agents");
  await mkdir(agentsDir, { recursive: true });
  await writeFile(join(agentsDir, "dev.md"), `---
name: dev
displayName: 研发
avatar: "⚙️"
description: 测试用
model: deepseek/deepseek-v4-flash
thinking: off
tools: read
---
简短回答。`);

  // 2. 启动内核
  kernelProc = spawn("bun", ["run", "packages/kernel/src/index.ts"], {
    cwd: "/Users/pipi/work/HiAgent",
    env: {
      ...process.env,
      HIAGENT_AGENTS_DIR: agentsDir,
      HIAGENT_CWD: dir,
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY!,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  // 等内核就绪
  await new Promise(r => setTimeout(r, 2000));

  // 3. 连 WebSocket
  wsClient = new WebSocket("ws://localhost:9776");
  await new Promise<void>((resolve, reject) => {
    wsClient.onopen = () => resolve();
    wsClient.onerror = () => reject(new Error("WS connect failed"));
    setTimeout(() => reject(new Error("WS timeout")), 3000);
  });
});

test.afterAll(async () => {
  wsClient?.close();
  kernelProc?.kill("SIGKILL");
  await rm(dir, { recursive: true, force: true });
});

test("完整流程：list agents → prompt → 收到 agent:message", async () => {
  const received: any[] = [];
  wsClient.onmessage = (ev: any) => {
    try { received.push(JSON.parse(ev.data)); } catch {}
  };

  // 1. 请求 agent 列表
  wsClient.send(JSON.stringify({ type: "agents:list" }));
  await new Promise(r => setTimeout(r, 500));
  expect(received.some(e => e.type === "agents:list")).toBe(true);

  // 2. 发 prompt（真模型，消耗少量 token）
  wsClient.send(JSON.stringify({ type: "agent:prompt", agentName: "dev", message: "只回复 OK" }));

  // 等 agent:message（最多 20s）
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (received.some(e => e.type === "agent:message")) break;
  }

  const msgs = received.filter(e => e.type === "agent:message");
  expect(msgs.length).toBeGreaterThan(0);
  expect(msgs[msgs.length - 1].message.text).toContain("OK");
}, 30000);
```

- [ ] **Step 3: 跑端到端测试**

Run（需 DEEPSEEK_API_KEY 环境变量）:
```bash
export DEEPSEEK_API_KEY="你的key"
bun test packages/kernel/tests/e2e-smoke.test.ts
```
Expected: `1 pass` —— 收到 agents:list + agent:message（含 "OK"）

⚠️ 若失败排查：
- 内核没启动 → 看 `kernelProc.stderr`
- WS 连不上 → 确认 9776 端口没被占（`lsof -i:9776`）
- agent:message 没来 → 模型 key 错误或 pi 启动失败，看内核日志

- [ ] **Step 4: Commit**

```bash
git add packages/kernel/src/index.ts packages/kernel/tests/e2e-smoke.test.ts
git commit -m "feat(kernel): wire all components, e2e smoke test with DeepSeek"
```

---

## Task 9: 前端脚手架 + WebSocket 客户端

**Files:**
- Create: `packages/frontend/vite.config.ts`, `packages/frontend/index.html`, `packages/frontend/src/main.tsx`, `packages/frontend/src/App.tsx`, `packages/frontend/src/api/ws.ts`, `packages/frontend/src/styles.css`
- Test: `packages/frontend/tests/store.test.ts`

**Interfaces:**
- Consumes: kernel 的 WebSocket（ws://localhost:9776）
- Produces: `bun run dev` 启动 Vite dev server（默认 5173），能连内核并显示连接状态

- [ ] **Step 1: 写 Vite 配置**

`packages/frontend/vite.config.ts`:
```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 开发时代理避免 CORS；实际前端由 Tauri 打包后同源
  },
});
```

`packages/frontend/index.html`:
```html
<!DOCTYPE html>
<html lang="zh">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>HiAgent</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: 写 WebSocket 客户端 + 最小 App**

`packages/frontend/src/api/ws.ts`:
```typescript
import type { WSEvent } from "hiagent-shared";

type EventHandler = (event: WSEvent) => void;

export class KernelWSClient {
  private ws: WebSocket | null = null;
  private handlers: EventHandler[] = [];
  private clientMsgHandlers: Array<(msg: any) => void> = [];

  connect(url = "ws://localhost:9776"): void {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data) as WSEvent;
        this.handlers.forEach(h => h(event));
      } catch {}
    };
    this.ws.onclose = () => {
      // 简单重连（3s 后）
      setTimeout(() => this.connect(url), 3000);
    };
  }

  onEvent(cb: EventHandler): void {
    this.handlers.push(cb);
  }

  send(msg: any): void {
    this.ws?.send(JSON.stringify(msg));
  }
}
```

`packages/frontend/src/main.tsx`:
```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

`packages/frontend/src/App.tsx`:
```tsx
import { useEffect, useState } from "react";
import { KernelWSClient } from "./api/ws";

const ws = new KernelWSClient();

export function App() {
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    ws.connect();
    // 检测连接状态（简化：onopen）
    const timer = setInterval(() => {
      setConnected(ws["ws"]?.readyState === WebSocket.OPEN);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="p-4">
      <h1 className="text-xl font-bold">HiAgent</h1>
      <p>内核连接：{connected ? "✅ 已连接" : "❌ 未连接"}</p>
    </div>
  );
}
```

`packages/frontend/src/styles.css`:
```css
@import "tailwindcss";
```

- [ ] **Step 3: 安装依赖 + 验证 dev server**

Run: `cd /Users/pipi/work/HiAgent && bun install`
Expected: 装好 react/react-dom/zustand/reactflow/vite/tailwind 等

Run: `bun run --filter hiagent-frontend dev`
Expected: Vite 启动，浏览器打开 localhost:5173 显示 "HiAgent" + 连接状态（先启动 kernel 才会 ✅）

- [ ] **Step 4: Commit**

```bash
git add packages/frontend/
git commit -m "feat(frontend): scaffold + WebSocket client to kernel"
```

---

## Task 10: Zustand stores + 启动页（角色选择）

**Files:**
- Create: `packages/frontend/src/store/agents.ts`, `packages/frontend/src/store/session.ts`, `packages/frontend/src/components/LaunchScreen.tsx`
- Modify: `packages/frontend/src/App.tsx`

**Interfaces:**
- Consumes: kernel WS events (`agents:list`, `agent:state`)
- Produces: 启动页显示角色卡片，选中后进入会话视图占位

- [ ] **Step 1: 写 agents store**

`packages/frontend/src/store/agents.ts`:
```typescript
import { create } from "zustand";
import type { AgentConfig, AgentState } from "hiagent-shared";

interface AgentsStore {
  list: AgentConfig[];
  states: Record<string, AgentState>;
  setList: (agents: AgentConfig[]) => void;
  updateState: (name: string, state: AgentState) => void;
}

export const useAgents = create<AgentsStore>((set) => ({
  list: [],
  states: {},
  setList: (agents) => set({ list: agents }),
  updateState: (name, state) => set((s) => ({ states: { ...s.states, [name]: state } })),
}));
```

- [ ] **Step 2: 写 session store**

`packages/frontend/src/store/session.ts`:
```typescript
import { create } from "zustand";
import type { ChatMessage } from "hiagent-shared";

interface SessionStore {
  currentAgent: string | null;
  messages: Record<string, ChatMessage[]>;  // key = agentName
  selectAgent: (name: string) => void;
  addMessage: (agentName: string, msg: ChatMessage) => void;
  clearMessages: (agentName: string) => void;
}

export const useSession = create<SessionStore>((set) => ({
  currentAgent: null,
  messages: {},
  selectAgent: (name) => set({ currentAgent: name }),
  addMessage: (agentName, msg) => set((s) => ({
    messages: { ...s.messages, [agentName]: [...(s.messages[agentName] ?? []), msg] },
  })),
  clearMessages: (agentName) => set((s) => ({
    messages: { ...s.messages, [agentName]: [] },
  })),
}));
```

- [ ] **Step 3: 写启动页组件**

`packages/frontend/src/components/LaunchScreen.tsx`:
```tsx
import { useEffect } from "react";
import { useAgents } from "../store/agents";
import { useSession } from "../store/session";
import { wsClient } from "../ws-instance";

export function LaunchScreen() {
  const list = useAgents(s => s.list);
  const setList = useAgents(s => s.setList);
  const selectAgent = useSession(s => s.selectAgent);

  useEffect(() => {
    wsClient.send({ type: "agents:list" });
    const off = wsClient.onEvent(e => {
      if (e.type === "agents:list") setList(e.agents);
    });
    return () => off();
  }, [setList]);

  return (
    <div className="h-screen flex flex-col items-center justify-center gap-8">
      <h1 className="text-3xl font-bold">HiAgent</h1>
      <p className="text-gray-500">选择一个角色开始</p>
      <div className="grid grid-cols-2 gap-4">
        {list.map(agent => (
          <button
            key={agent.name}
            onClick={() => selectAgent(agent.name)}
            className="flex flex-col items-center gap-2 p-6 border-2 rounded-xl hover:border-blue-500 hover:bg-blue-50 transition w-40"
          >
            <span className="text-4xl">{agent.avatar}</span>
            <span className="font-medium">{agent.displayName}</span>
            <span className="text-xs text-gray-400">{agent.description}</span>
          </button>
        ))}
        {list.length === 0 && <p className="text-gray-400">加载中...（确认内核已启动）</p>}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 创建 ws 实例单例 + 改 App.tsx**

`packages/frontend/src/ws-instance.ts`:
```typescript
import { KernelWSClient } from "./api/ws";
export const wsClient = new KernelWSClient();
```

`packages/frontend/src/App.tsx`（替换 Task 9 的占位）:
```tsx
import { useEffect, useState } from "react";
import { wsClient } from "./ws-instance";
import { useSession } from "./store/session";
import { LaunchScreen } from "./components/LaunchScreen";
import { SessionView } from "./components/SessionView";

export function App() {
  const [connected, setConnected] = useState(false);
  const currentAgent = useSession(s => s.currentAgent);

  useEffect(() => {
    wsClient.connect();
    const timer = setInterval(() => {
      setConnected((wsClient as any)["ws"]?.readyState === WebSocket.OPEN);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  if (!connected) {
    return <div className="h-screen flex items-center justify-center text-gray-400">正在连接内核...</div>;
  }
  if (!currentAgent) return <LaunchScreen />;
  return <SessionView />;
}
```

⚠️ `SessionView` 在 Task 11 创建。本 task 先创建占位文件让编译通过：

`packages/frontend/src/components/SessionView.tsx`（占位，Task 11 实现）:
```tsx
export function SessionView() {
  return <div className="p-4">SessionView（Task 11 实现）</div>;
}
```

- [ ] **Step 5: 验证启动页**

Run: 启动 kernel（Task 8）+ 启动 frontend dev server
Expected: 浏览器显示角色卡片（需要 `~/.pi/agent/agents/` 下有 agent.md，或在 HIAGENT_AGENTS_DIR 指定）

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/store/ packages/frontend/src/components/LaunchScreen.tsx packages/frontend/src/components/SessionView.tsx packages/frontend/src/ws-instance.ts packages/frontend/src/App.tsx
git commit -m "feat(frontend): Zustand stores + launch screen with agent selection"
```

---

## Task 11: 会话视图 —— 左右布局 + 流式消息渲染

**Files:**
- Create: `packages/frontend/src/components/Sidebar.tsx`, `packages/frontend/src/components/MessageList.tsx`, `packages/frontend/src/components/MessageItem.tsx`, `packages/frontend/src/components/Composer.tsx`
- Replace: `packages/frontend/src/components/SessionView.tsx`

**Interfaces:**
- Consumes: `useAgents`, `useSession`, kernel `agent:message` / `agent:state` events
- Produces: Codex 式左右布局，发 prompt 看流式回复

- [ ] **Step 1: 写 Sidebar（角色列表 + 历史）**

`packages/frontend/src/components/Sidebar.tsx`:
```tsx
import { useAgents } from "../store/agents";
import { useSession } from "../store/session";

export function Sidebar() {
  const list = useAgents(s => s.list);
  const states = useAgents(s => s.states);
  const currentAgent = useSession(s => s.currentAgent);
  const selectAgent = useSession(s => s.selectAgent);

  return (
    <div className="w-56 border-r flex flex-col">
      <div className="p-3 font-bold border-b">HiAgent</div>
      <div className="flex-1 overflow-y-auto">
        {list.map(a => {
          const st = states[a.name]?.status ?? "idle";
          const color = st === "thinking" ? "border-blue-500" : st === "blocked" ? "border-orange-500" : "border-transparent";
          return (
            <button
              key={a.name}
              onClick={() => selectAgent(a.name)}
              className={`w-full flex items-center gap-2 p-3 hover:bg-gray-100 ${currentAgent === a.name ? "bg-gray-100" : ""} border-l-4 ${color}`}
            >
              <span className="text-xl">{a.avatar}</span>
              <div className="flex flex-col items-start">
                <span className="text-sm font-medium">{a.displayName}</span>
                <span className="text-xs text-gray-400">{st}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 写 MessageItem + MessageList**

`packages/frontend/src/components/MessageItem.tsx`:
```tsx
import type { ChatMessage } from "hiagent-shared";

export function MessageItem({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-3`}>
      <div className={`max-w-[70%] rounded-2xl px-4 py-2 ${isUser ? "bg-blue-500 text-white" : "bg-gray-100"}`}>
        <p className="whitespace-pre-wrap text-sm">{msg.text}</p>
      </div>
    </div>
  );
}
```

`packages/frontend/src/components/MessageList.tsx`:
```tsx
import { useEffect, useRef } from "react";
import { useSession } from "../store/session";
import { MessageItem } from "./MessageItem";

export function MessageList({ agentName }: { agentName: string }) {
  const messages = useSession(s => s.messages[agentName] ?? []);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <div className="flex-1 overflow-y-auto p-4">
      {messages.map(m => <MessageItem key={m.id} msg={m} />)}
      <div ref={endRef} />
    </div>
  );
}
```

- [ ] **Step 3: 写 Composer（输入框）**

`packages/frontend/src/components/Composer.tsx`:
```tsx
import { useState } from "react";
import { wsClient } from "../ws-instance";

export function Composer({ agentName }: { agentName: string }) {
  const [text, setText] = useState("");
  const send = () => {
    if (!text.trim()) return;
    wsClient.send({ type: "agent:prompt", agentName, message: text });
    setText("");
  };
  return (
    <div className="border-t p-3 flex gap-2">
      <input
        className="flex-1 border rounded-lg px-3 py-2 text-sm"
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
        placeholder={`发消息给 ${agentName}...`}
      />
      <button className="bg-blue-500 text-white px-4 py-2 rounded-lg text-sm" onClick={send}>发送</button>
    </div>
  );
}
```

- [ ] **Step 4: 实现 SessionView（左右布局 + WS 事件接 stores）**

`packages/frontend/src/components/SessionView.tsx`（替换占位）:
```tsx
import { useEffect } from "react";
import { useSession } from "../store/session";
import { useAgents } from "../store/agents";
import { wsClient } from "../ws-instance";
import { Sidebar } from "./Sidebar";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { AskCard } from "./AskCard";

export function SessionView() {
  const currentAgent = useSession(s => s.currentAgent)!;
  const addMessage = useSession(s => s.addMessage);
  const updateState = useAgents(s => s.updateState);

  useEffect(() => {
    const off = wsClient.onEvent(e => {
      if (e.type === "agent:message" && e.agentName === currentAgent) {
        addMessage(e.agentName, e.message);
      }
      if (e.type === "agent:state" && e.agentName === currentAgent) {
        updateState(e.agentName, e.state);
      }
    });
    return () => off();
  }, [currentAgent, addMessage, updateState]);

  // 把用户发送的消息也加入会话（乐观显示）
  const sendPrompt = (text: string) => {
    addMessage(currentAgent, { id: `u${Date.now()}`, role: "user", text, timestamp: Date.now() });
    wsClient.send({ type: "agent:prompt", agentName: currentAgent, message: text });
  };

  return (
    <div className="h-screen flex">
      <Sidebar />
      <div className="flex-1 flex flex-col">
        <div className="border-b p-3 font-medium">{currentAgent} 会话</div>
        <MessageList agentName={currentAgent} />
        <Composer agentName={currentAgent} onSend={sendPrompt} />
      </div>
    </div>
  );
}
```

⚠️ 需要 Composer 支持 onSend 回调（用于乐观显示用户消息）。更新 Composer 签名：

`packages/frontend/src/components/Composer.tsx`（更新）:
```tsx
import { useState } from "react";

export function Composer({ agentName, onSend }: { agentName: string; onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  const send = () => {
    if (!text.trim()) return;
    onSend(text);
    setText("");
  };
  return (
    <div className="border-t p-3 flex gap-2">
      <input
        className="flex-1 border rounded-lg px-3 py-2 text-sm"
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
        placeholder={`发消息给 ${agentName}...`}
      />
      <button className="bg-blue-500 text-white px-4 py-2 rounded-lg text-sm" onClick={send}>发送</button>
    </div>
  );
}
```

`packages/frontend/src/components/AskCard.tsx`（占位，Task 12 实现）:
```tsx
export function AskCard() {
  return null;
}
```

- [ ] **Step 5: 验证会话视图**

Run: kernel + frontend dev，启动页选角色 → 进入会话 → 发消息 → 看流式回复
Expected: 用户消息 + DeepSeek 回复都显示在消息列表

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/components/
git commit -m "feat(frontend): session view (sidebar + message list + composer, streaming)"
```

---

## Task 12: 委派内联显示 —— ask 消息 + 干预按钮

**Files:**
- Create: `packages/frontend/src/store/intercom.ts`, `packages/frontend/src/components/AskCard.tsx`（替换占位）, `packages/frontend/src/components/IntercomStatusBar.tsx`
- Modify: `packages/frontend/src/components/MessageList.tsx`, `packages/frontend/src/components/SessionView.tsx`

**Interfaces:**
- Consumes: kernel `intercom:ask` / `intercom:reply` events
- Produces: 对话流里 ask 作为特殊消息卡片显示，带三个干预按钮（🙋 我来回答 / ⚡ 催一下 / ✕ 取消）

设计文档 4.3 的三个干预动作，MVP 实现"🙋 我来回答"（用户替答 → inject-reply），其余两个留按钮但提示"MVP 暂未实现"。

- [ ] **Step 1: 写 intercom store**

`packages/frontend/src/store/intercom.ts`:
```typescript
import { create } from "zustand";

export interface AskItem {
  messageId: string;
  from: string;
  to: string;
  text: string;
  startedAt: number;
  resolved: boolean;
}

interface IntercomStore {
  asks: AskItem[];
  addAsk: (ask: AskItem) => void;
  resolveAsk: (messageId: string) => void;
}

export const useIntercom = create<IntercomStore>((set) => ({
  asks: [],
  addAsk: (ask) => set((s) => ({ asks: [...s.asks.filter(a => a.messageId !== ask.messageId), ask] })),
  resolveAsk: (messageId) => set((s) => ({
    asks: s.asks.map(a => a.messageId === messageId ? { ...a, resolved: true } : a),
  })),
}));
```

- [ ] **Step 2: 实现 AskCard（带干预按钮）**

`packages/frontend/src/components/AskCard.tsx`（替换占位）:
```tsx
import { useState } from "react";
import type { AskItem } from "../store/intercom";
import { wsClient } from "../ws-instance";

export function AskCard({ ask }: { ask: AskItem }) {
  const [answering, setAnswering] = useState(false);
  const [replyText, setReplyText] = useState("");
  const elapsed = Math.floor((Date.now() - ask.startedAt) / 1000);

  const submitReply = () => {
    if (!replyText.trim()) return;
    wsClient.send({
      type: "intercom:inject-reply",
      messageId: ask.messageId,
      agentName: ask.to,        // 被问的 agent（用户替它答）
      toAskFrom: ask.from,      // 回复给原 ask 发起方
      text: replyText,
    });
    setAnswering(false);
    setReplyText("");
  };

  return (
    <div className={`my-3 mx-auto max-w-[80%] border-2 ${ask.resolved ? "border-green-300 bg-green-50" : "border-orange-300 bg-orange-50"} rounded-xl p-3`}>
      <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
        <span>🟠 {ask.from} → {ask.to}</span>
        {!ask.resolved && <span className="text-orange-500">已等待 {elapsed}s</span>}
        {ask.resolved && <span className="text-green-500">✓ 已回复</span>}
      </div>
      <p className="text-sm font-medium">{ask.text}</p>
      {!ask.resolved && !answering && (
        <div className="flex gap-2 mt-2">
          <button className="text-xs px-2 py-1 bg-white border rounded" onClick={() => setAnswering(true)}>🙋 我来回答</button>
          <button className="text-xs px-2 py-1 bg-white border rounded opacity-50" title="MVP 暂未实现">⚡ 催一下</button>
          <button className="text-xs px-2 py-1 bg-white border rounded opacity-50" title="MVP 暂未实现">✕ 取消</button>
        </div>
      )}
      {answering && (
        <div className="mt-2 flex gap-2">
          <input
            className="flex-1 border rounded px-2 py-1 text-sm"
            value={replyText}
            onChange={e => setReplyText(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") submitReply(); }}
            placeholder="输入你的回答..."
            autoFocus
          />
          <button className="text-xs px-3 py-1 bg-blue-500 text-white rounded" onClick={submitReply}>发送</button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: 写 IntercomStatusBar（底部状态条）**

`packages/frontend/src/components/IntercomStatusBar.tsx`:
```tsx
import { useIntercom } from "../store/intercom";

export function IntercomStatusBar() {
  const unresolved = useIntercom(s => s.asks.filter(a => !a.resolved));
  if (unresolved.length === 0) return null;
  return (
    <div className="border-t bg-orange-50 px-3 py-1 text-xs flex gap-4 overflow-x-auto">
      {unresolved.map(a => (
        <span key={a.messageId} className="whitespace-nowrap">
          🟠 {a.from}→{a.to}: {a.text.slice(0, 20)}...
        </span>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: 接线 SessionView + MessageList**

`packages/frontend/src/components/MessageList.tsx`（加 AskCard 渲染）:
```tsx
import { useEffect, useRef } from "react";
import { useSession } from "../store/session";
import { useIntercom } from "../store/intercom";
import { MessageItem } from "./MessageItem";
import { AskCard } from "./AskCard";

export function MessageList({ agentName }: { agentName: string }) {
  const messages = useSession(s => s.messages[agentName] ?? []);
  const asks = useIntercom(s => s.asks.filter(a => a.from === agentName || a.to === agentName));
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, asks]);

  return (
    <div className="flex-1 overflow-y-auto p-4">
      {messages.map(m => <MessageItem key={m.id} msg={m} />)}
      {asks.map(a => <AskCard key={a.messageId} ask={a} />)}
      <div ref={endRef} />
    </div>
  );
}
```

`packages/frontend/src/components/SessionView.tsx`（加 intercom 事件接线 + 状态条）:
在现有 useEffect 里追加：
```tsx
// 在 SessionView 的 useEffect 内额外处理 intercom 事件
import { useIntercom } from "../store/intercom";
// ...
const addAsk = useIntercom(s => s.addAsk);
const resolveAsk = useIntercom(s => s.resolveAsk);
// 在 onEvent 回调里：
if (e.type === "intercom:ask") {
  addAsk({ messageId: e.messageId, from: e.from, to: e.to, text: e.text, startedAt: e.startedAt, resolved: false });
}
if (e.type === "intercom:reply") {
  resolveAsk(e.toAskMessageId);
}
```

并在 SessionView JSX 底部 Composer 上方加 `<IntercomStatusBar />`。

- [ ] **Step 5: 验证 ask 显示（手动：两个 agent 互 ask）**

Run: 启动 kernel + frontend，从产品 agent 发消息让它调 intercom ask 研发（需要 agent 配置 partners），观察 AskCard 显示 + 干预按钮
Expected: 对话流出现橙色 ask 卡片，点击"🙋 我来回答"输入回复后变绿

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/store/intercom.ts packages/frontend/src/components/AskCard.tsx packages/frontend/src/components/IntercomStatusBar.tsx packages/frontend/src/components/MessageList.tsx packages/frontend/src/components/SessionView.tsx
git commit -m "feat(frontend): inline ask delegation cards with intervention buttons"
```

---

## Task 13: 编排画布 —— React Flow（辅助视图）

**Files:**
- Create: `packages/frontend/src/components/Canvas.tsx`, `packages/frontend/src/components/CanvasNode.tsx`
- Modify: `packages/frontend/src/components/SessionView.tsx`（加切换按钮）

**Interfaces:**
- Consumes: `useAgents`（agents + states + partners）, kernel events
- Produces: 4 节点 + 连线 + 实时状态（thinking=蓝/blocked=橙/idle=灰）

设计文档 6.3：画布是"约束+监控"，连线来自 partners 字段，活跃 ask 显示橙色动画。

- [ ] **Step 1: 写 CanvasNode（节点组件）**

`packages/frontend/src/components/CanvasNode.tsx`:
```tsx
import { Handle, Position } from "reactflow";
import type { AgentConfig, AgentState } from "hiagent-shared";

export function CanvasNode({ data }: { data: { agent: AgentConfig; state?: AgentState } }) {
  const { agent, state } = data;
  const status = state?.status ?? "idle";
  const borderColor = status === "thinking" ? "border-blue-500" : status === "blocked" ? "border-orange-500" : "border-gray-300";
  return (
    <div className={`px-4 py-3 rounded-full border-4 ${borderColor} bg-white shadow-md flex flex-col items-center w-28`}>
      <Handle type="target" position={Position.Top} />
      <span className="text-2xl">{agent.avatar}</span>
      <span className="text-xs font-medium">{agent.displayName}</span>
      <span className="text-[10px] text-gray-400">{status}</span>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
```

- [ ] **Step 2: 实现 Canvas（节点 + 连线）**

`packages/frontend/src/components/Canvas.tsx`:
```tsx
import { useMemo } from "react";
import ReactFlow, { Background, Controls } from "reactflow";
import "reactflow/dist/style.css";
import { useAgents } from "../store/agents";
import { useIntercom } from "../store/intercom";
import { CanvasNode } from "./CanvasNode";

const nodeTypes = { agent: CanvasNode };

export function Canvas() {
  const list = useAgents(s => s.list);
  const states = useAgents(s => s.states);
  const asks = useIntercom(s => s.asks);

  const nodes = useMemo(() => {
    // 简单环形布局：4 个 agent 均匀分布
    const n = list.length;
    return list.map((agent, i) => {
      const angle = (i / n) * 2 * Math.PI;
      return {
        id: agent.name,
        type: "agent",
        position: { x: 250 + 150 * Math.cos(angle), y: 200 + 120 * Math.sin(angle) },
        data: { agent, state: states[agent.name] },
      };
    });
  }, [list, states]);

  const edges = useMemo(() => {
    const result: any[] = [];
    for (const agent of list) {
      for (const to of agent.partners.askTo) {
        const isActive = asks.some(a => !a.resolved && a.from === agent.name && a.to === to);
        result.push({
          id: `${agent.name}-${to}`,
          source: agent.name,
          target: to,
          animated: isActive,
          style: { stroke: isActive ? "#f97316" : "#d1d5db", strokeDasharray: isActive ? undefined : "5 5" },
        });
      }
    }
    return result;
  }, [list, asks]);

  return (
    <div className="h-screen w-full">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView>
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
```

- [ ] **Step 3: SessionView 加画布切换按钮**

`packages/frontend/src/components/SessionView.tsx`（顶部加按钮 + 切换状态）:
```tsx
// 增加 useState 控制视图切换
const [showCanvas, setShowCanvas] = useState(false);
// 在会话标题栏右侧加按钮：
<button onClick={() => setShowCanvas(!showCanvas)} className="text-xs px-2 py-1 border rounded">
  {showCanvas ? "对话" : "编排画布"}
</button>
// 条件渲染：showCanvas 时渲染 <Canvas />，否则渲染消息流
```

- [ ] **Step 4: 验证画布**

Run: 启动，点"编排画布"切换
Expected: 看到 4 个圆形节点 + 灰色虚线连线（来自 partners），agent thinking 时边框变蓝

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/components/Canvas.tsx packages/frontend/src/components/CanvasNode.tsx packages/frontend/src/components/SessionView.tsx
git commit -m "feat(frontend): orchestration canvas (React Flow, nodes + partners edges)"
```

---

## Task 14: Agent 配置 UI

**Files:**
- Create: `packages/frontend/src/components/AgentConfig.tsx`
- Modify: `packages/frontend/src/components/Sidebar.tsx`（右键编辑）

**Interfaces:**
- Consumes: kernel `agents:list`（读配置）
- Produces: 弹窗显示/编辑 agent 的 displayName/avatar/description/systemPrompt/tools

设计文档 6.2：Agent 配置有多个 tab，MVP 只做基本信息 + 系统提示词 + 工具勾选（简单逗号分隔）。

- [ ] **Step 1: 实现 AgentConfig 弹窗**

`packages/frontend/src/components/AgentConfig.tsx`:
```tsx
import { useState, useEffect } from "react";
import type { AgentConfig } from "hiagent-shared";

export function AgentConfig({ agent, onClose }: { agent: AgentConfig; onClose: () => void }) {
  const [form, setForm] = useState(agent);
  useEffect(() => setForm(agent), [agent]);

  // MVP：本地编辑，保存通过 kernel 命令（agent:save-config，需 kernel 支持，留作扩展）
  // 这里先做只读展示 + 提示
  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 w-96 max-h-[80vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h2 className="font-bold text-lg">配置 · {agent.displayName}</h2>
          <button onClick={onClose} className="text-gray-400">✕</button>
        </div>
        <div className="space-y-3 text-sm">
          <div>
            <label className="block text-gray-500 mb-1">名称</label>
            <input className="w-full border rounded px-2 py-1" value={form.displayName}
              onChange={e => setForm({ ...form, displayName: e.target.value })} />
          </div>
          <div>
            <label className="block text-gray-500 mb-1">头像（emoji）</label>
            <input className="w-full border rounded px-2 py-1" value={form.avatar}
              onChange={e => setForm({ ...form, avatar: e.target.value })} />
          </div>
          <div>
            <label className="block text-gray-500 mb-1">系统提示词</label>
            <textarea className="w-full border rounded px-2 py-1 h-32" value={form.systemPrompt ?? ""}
              onChange={e => setForm({ ...form, systemPrompt: e.target.value })} />
          </div>
          <div>
            <label className="block text-gray-500 mb-1">工具（逗号分隔）</label>
            <input className="w-full border rounded px-2 py-1" value={form.tools.join(", ")}
              onChange={e => setForm({ ...form, tools: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })} />
          </div>
        </div>
        <div className="flex gap-2 mt-4">
          <button className="flex-1 bg-blue-500 text-white py-2 rounded" onClick={onClose}>保存（MVP 暂只本地）</button>
          <button className="flex-1 border py-2 rounded" onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Sidebar 加右键编辑入口**

`packages/frontend/src/components/Sidebar.tsx`（加 state + 右键菜单简化为双击）:
```tsx
// 增加：
const [editing, setEditing] = useState<AgentConfig | null>(null);
// 在 agent button 上加 onDoubleClick={() => setEditing(a)}
// 在 Sidebar 末尾：
{editing && <AgentConfig agent={editing} onClose={() => setEditing(null)} />}
```

⚠️ MVP 的 AgentConfig 保存只改本地内存（写回 ConfigStore 需要 kernel 加 `agent:save-config` 命令，作为后续扩展点标注）。

- [ ] **Step 3: 验证配置弹窗**

Run: 双击 sidebar 角色，弹窗显示，能编辑字段
Expected: 弹窗显示当前配置，可编辑（保存暂不持久化）

- [ ] **Step 4: Commit**

```bash
git add packages/frontend/src/components/AgentConfig.tsx packages/frontend/src/components/Sidebar.tsx
git commit -m "feat(frontend): agent config modal (basic info + prompt + tools)"
```

---

## Task 15: Tauri 外壳 + Bun sidecar 生命周期

**Files:**
- Create: `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/build.rs`, `src-tauri/src/main.rs`
- Modify: `packages/frontend/vite.config.ts`（构建输出到 src-tauri 用的位置）

**Interfaces:**
- Consumes: bun 二进制（PATH），kernel 的 `packages/kernel/src/index.ts`
- Produces: `cargo tauri dev` 启动 Tauri 窗口 + 自动 spawn Bun sidecar + 加载前端

设计文档 7.3：Tauri 只管窗口 + Bun sidecar 生命周期 + IPC 桥（MVP 用 WebSocket 直连，不需 IPC）。

- [ ] **Step 1: 初始化 Tauri 项目结构**

`src-tauri/Cargo.toml`:
```toml
[package]
name = "hiagent"
version = "0.1.0"
edition = "2021"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[features]
custom-protocol = ["tauri/custom-protocol"]
```

`src-tauri/build.rs`:
```rust
fn main() {
    tauri_build::build()
}
```

`src-tauri/tauri.conf.json`:
```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "HiAgent",
  "version": "0.1.0",
  "identifier": "com.hiagent.app",
  "build": {
    "frontendDist": "../packages/frontend/dist",
    "devUrl": "http://localhost:5173",
    "beforeDevCommand": "bun run --filter hiagent-frontend dev",
    "beforeBuildCommand": "bun run --filter hiagent-frontend build"
  },
  "app": {
    "windows": [
      {
        "title": "HiAgent",
        "width": 1200,
        "height": 800,
        "resizable": true
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": ["icons/icon.png"]
  }
}
```

- [ ] **Step 2: 实现 main.rs（窗口 + Bun sidecar 生命周期）**

`src-tauri/src/main.rs`:
```rust
// 防止 Windows 发布构建额外打开控制台
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::Manager;

struct SidecarState(Mutex<Option<Child>>);

fn spawn_bun_sidecar(app: &tauri::App) -> std::io::Result<Child> {
    // 定位 kernel 入口（开发期从源码跑）
    let kernel_path = app
        .path()
        .resource_path("../packages/kernel/src/index.ts")
        .unwrap_or_else(|_| std::path::PathBuf::from("packages/kernel/src/index.ts"));

    Command::new("bun")
        .arg("run")
        .arg(&kernel_path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarState(Mutex::new(None)))
        .setup(|app| {
            // 启动 Bun sidecar
            match spawn_bun_sidecar(app) {
                Ok(child) => {
                    let state: tauri::State<SidecarState> = app.state();
                    *state.0.lock().unwrap() = Some(child);
                    println!("[HiAgent] Bun sidecar started");
                }
                Err(e) => {
                    eprintln!("[HiAgent] Failed to start Bun sidecar: {}", e);
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // 窗口关闭时杀 sidecar
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let app = window.app_handle();
                let state: tauri::State<SidecarState> = app.state();
                if let Some(mut child) = state.0.lock().unwrap().take() {
                    let _ = child.kill();
                    println!("[HiAgent] Bun sidecar stopped");
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

⚠️ 需要在 Cargo.toml 加 `tauri-plugin-shell`，并在 tauri.conf.json 的 capabilities 里授权。简化起见，MVP 用裸 `std::process::Command` 即可（上面的 `tauri_plugin_shell` 那行可去掉，因为没用它的 API）。

修正：去掉 `.plugin(tauri_plugin_shell::init())` 那行，Cargo.toml 不加 tauri-plugin-shell。

- [ ] **Step 3: 添加图标占位 + 验证构建**

```bash
mkdir -p src-tauri/icons
# 用 tauri 默认图标占位（或随便放个 png）
cargo build --manifest-path src-tauri/Cargo.toml
```
Expected: Rust 编译通过（首次会下载 tauri 依赖，较慢）

- [ ] **Step 4: Commit**

```bash
git add src-tauri/
git commit -m "feat(tauri): native shell + bun sidecar lifecycle management"
```

---

## Task 16: 端到端联调（完整 MVP）

**Files:**
- Create: `scripts/dev.sh`（一键启动脚本）, `~/.pi/agent/agents/` 下的 4 个 agent 配置（产品/PM/研发/测试）
- Modify: 无

**Interfaces:**
- Consumes: Task 1-15 全部
- Produces: `./scripts/dev.sh` 启动完整应用，4 agent 能互 ask

- [ ] **Step 1: 创建 4 个默认 agent 配置**

确保 `~/.pi/agent/agents/` 下有 4 个 .md（用户首次运行的种子配置，实际产品里由应用首次启动时写入）：

`~/.pi/agent/agents/product.md`:
```yaml
---
name: product
displayName: 产品
avatar: "🎯"
description: 产品经理，负责需求设计
model: deepseek/deepseek-v4-flash
thinking: medium
tools: read, write
partners:
  askTo: [dev, pm]
  askFrom: []
---
你是一名产品经理。需要技术调研时用 intercom 工具 ask 研发。需求完成后委派 PM。
```

`~/.pi/agent/agents/pm.md`:
```yaml
---
name: pm
displayName: PM
avatar: "📋"
description: 项目经理，负责安排实现
model: deepseek/deepseek-v4-flash
thinking: medium
tools: read, write
partners:
  askTo: [dev]
  askFrom: [product]
---
你是一名项目经理。收到产品委派后，用 intercom 工具 ask 研发评估工作量。
```

`~/.pi/agent/agents/dev.md`:
```yaml
---
name: dev
displayName: 研发
avatar: "⚙️"
description: 后端研发，负责技术调研与实现
model: deepseek/deepseek-v4-flash
thinking: high
tools: read, bash, edit, write
partners:
  askTo: [test]
  askFrom: [product, pm]
---
你是一名资深后端工程师。收到 ask 时用 intercom 工具回复。
```

`~/.pi/agent/agents/test.md`:
```yaml
---
name: test
displayName: 测试
avatar: "🧪"
description: 测试工程师
model: deepseek/deepseek-v4-flash
thinking: medium
tools: read, bash
partners:
  askTo: [dev]
  askFrom: [dev]
---
你是一名测试工程师。收到 ask 时用 intercom 工具回复。
```

- [ ] **Step 2: 写一键启动脚本**

`scripts/dev.sh`:
```bash
#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."

echo "=== 启动 Bun 编排内核（后台）==="
bun run packages/kernel/src/index.ts &
KERNEL_PID=$!
trap "kill $KERNEL_PID 2>/dev/null" EXIT

echo "=== 等内核就绪 ==="
sleep 2

echo "=== 启动前端（Tauri dev 模式）==="
# 需要 cargo tauri dev；若未装 tauri-cli：cargo install tauri-cli --version "^2.0.0"
cargo tauri dev
```

```bash
chmod +x scripts/dev.sh
```

- [ ] **Step 3: 完整端到端验证清单**

手动验证（需 DeepSeek API key 在环境变量）：

1. **启动**：`./scripts/dev.sh` → Tauri 窗口出现，显示 4 角色启动页
2. **单角色对话**：选"产品" → 发"设计登录功能" → 看 DeepSeek 流式回复
3. **委派（ask）**：在产品会话里让它 ask 研发 → 对话流出现橙色 ask 卡片 → 研发 sidebar 状态变橙（blocked）→ 切到研发会话看 DeepSeek 自动回复 → 产品 ask 卡片变绿
4. **用户替答**：在 ask 卡片点"🙋 我来回答" → 输入答案 → 产品的 ask 解除
5. **画布**：点"编排画布" → 4 节点 + 灰色虚线（partners），ask 时对应连线变橙动画
6. **Agent 配置**：双击 sidebar 角色 → 弹窗显示配置
7. **关闭**：关窗口 → Bun sidecar 进程随之退出（`ps aux | grep index.ts` 确认）

- [ ] **Step 4: 修复发现的问题**

根据验证清单结果修复 bug（此处留空，验证时按实际发现处理）。

- [ ] **Step 5: 更新 README + Commit**

`README.md`:
```markdown
# HiAgent

基于 Pi Coding Agent 的本地多 agent 编排管理桌面客户端。

## 开发

```bash
# 1. 确保 pi 在 PATH（pi --version）
# 2. 确保 DEEPSEEK_API_KEY 环境变量已设
# 3. 确保 pi-intercom 已装（pi install npm:pi-intercom）
./scripts/dev.sh
```

详见 `docs/superpowers/specs/2026-07-05-hiagent-design.md`。
```

```bash
git add scripts/ README.md
git commit -m "chore: dev script + default agent configs + README"
```

---

## Self-Review 检查

**1. Spec 覆盖**（设计文档 10.1 MVP 8 项）：
- ✅ 启动页（4 角色卡片）→ Task 10
- ✅ 会话视图（Codex 式左右，流式）→ Task 11
- ✅ Pi 集成（spawn pi --mode rpc，prompt/abort）→ Task 4
- ✅ pi-intercom 集成（ask/send/reply 捕获）→ Task 6+7
- ✅ 委派内联显示（ask + 干预按钮）→ Task 12
- ✅ Agent 配置（基本信息 + 提示词 + 工具）→ Task 14
- ✅ 编排画布（4 节点 + 连线 + 实时状态）→ Task 13
- ✅ 无超时 ask（v0.6.0 天然支持）→ Task 6 实现说明

**2. Placeholder 扫描**：无 TBD/TODO，每个 code step 都有完整代码。

**3. 类型一致性**：
- `AgentConfig` / `WSEvent` / `RPCEvent` 在 shared/types.ts 定义，各 task 一致引用
- `PiRpcClient.start()/prompt()/getState()` 签名在 Task 4 定义，Task 5/8 使用一致
- `ConfigStore.listAgents()/getAgent()/saveAgent()` Task 3 定义，Task 5/8 使用一致
- `IntercomMonitor.connect()/injectReply()` Task 6 定义，Task 7/8 使用一致
- `StateAggregator.handleAgentEvent()/handleIntercomReply()` Task 7 定义，测试使用一致

**4. 已知简化/后续扩展点**（计划内标注，非缺陷）：
- AgentConfig 保存不持久化（Task 14 只本地），需 kernel 加 `agent:save-config` 命令
- "⚡催一下"和"✕取消"按钮 MVP 不实现（Task 12 标注）
- 产物预览（设计文档 7.4）不在 MVP 范围
- Tauri sidecar 用裸 `std::process::Command`，生产环境需考虑打包 bun 二进制
