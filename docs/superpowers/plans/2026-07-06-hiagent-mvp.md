# HiAgent MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现设计文档（`docs/superpowers/specs/2026-07-05-hiagent-design.md`）11.1 节定义的 MVP——一个 Tauri 桌面应用，让用户通过 GUI 管理 4 个对等 Pi agent，agent 间用 pi-intercom 动态双向委派（ask/send/reply），ask 不设超时，用户可介入。

**Architecture:** 四层（见 spec 3.1 架构图）。① Tauri 原生窗口（Rust 壳 + React 前端）② Bun 编排内核（sidecar，端口 9776，WebSocket 对外）③ N 个 `pi --mode rpc` 子进程（通过 pi-intercom broker 对等通信）④ 文件系统持久化。前端 ↔ 内核走 WebSocket，内核 ↔ Pi 走 stdio JSONL，Pi 间走 Unix socket broker。本计划按依赖拓扑从底层（PiRpcClient）向上构建。

**Tech Stack:** Bun 1.3 + TypeScript（编排内核）/ React 19 + Zustand + React Flow + Tailwind v4（前端）/ Tauri 2 + Rust（桌面壳）/ pi 0.80 + pi-intercom 0.6（已验证，见 `docs/research/pi-intercom-rpc-compatibility.md`）

## Global Constraints

- **运行时**：Bun 作为编排内核运行时；Pi 二进制（`pi` 命令）必须在 PATH（已装于 `~/.nvm/versions/node/v22.21.1/bin/pi`，v0.80.3）
- **端口**：编排内核固定 9776（WebSocket）
- **Pi 调用**：`pi --mode rpc`，stdio 跑 JSONL（每行一个 JSON 对象，LF 分隔，**非 JSON-RPC**）。RPC 命令：`prompt`/`abort`/`get_state`/`get_messages`/`get_commands`/`set_model` 等。事件：`response`/`agent_start`/`turn_start`/`message_start`/`message_update`/`message_end`/`turn_end`/`agent_end`/`tool_execution_start`/`tool_execution_end`
- **Pi intercom**：v0.6.0。broker socket 路径 `~/.pi/agent/intercom/broker.sock`。client API：`connect(Omit<SessionInfo,"id">)` / `listSessions()` / `send(to, message)` / `on("message", cb)` / `disconnect()`。broker 30 秒空闲自动退出，spawn pi 会 auto-spawn broker（约 4s 出现 socket）
- **ask 超时**：v0.6.0 无超时 GC，发送方注册 message 事件监听等 reply，不设超时（天然无限等待，见 spec 4.1）
- **Agent 配置**：`~/.pi/agent/agents/<name>.md`，frontmatter 含 name/displayName/avatar/model/thinking/tools/skills/partners 等字段（见 spec 5.1）
- **设计系统**：前端严格遵循 spec 6.0（Catppuccin Mocha 配色 + 四角色渐变 + 排印间距），用 Tailwind 自定义主题实现。所有 hex 值、emoji、文案以 spec 6.0-6.7 和 `docs/superpowers/mockups/` 原型为准
- **测试模型**：DeepSeek，`DEEPSEEK_API_KEY` 环境变量，模型 ID `deepseek/deepseek-v4-flash`。测试脚本里用环境变量传递 key，不硬编码、不提交
- **不做的**（spec 11.2）：技能细粒度启用、插件市场 UI、Intercom 时间线全屏、MCP 配置 UI、产物预览、多项目

---

## File Structure

monorepo，三个包 + 一个 Tauri 壳：

```
HiAgent/
├── package.json                    # workspace root（bun workspaces）
├── bunfig.toml                     # bun 配置
├── docs/                           # 已有（spec/research/mockups）
├── packages/
│   ├── shared/                     # 前后端共享类型（最底层）
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/types.ts            # AgentConfig / WSEvent / RPCEvent / ChatMessage / AgentState
│   ├── kernel/                     # ② Bun 编排内核（sidecar）
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── index.ts            # 入口：组装所有组件，启动 WS server（9776）
│   │   │   ├── pi-rpc-client.ts    # PiRpcClient：spawn pi + JSONL 协议
│   │   │   ├── agent-manager.ts    # AgentManager：管多 PiRpcClient 生命周期
│   │   │   ├── config-store.ts     # ConfigStore：读写 agent.md
│   │   │   ├── intercom-monitor.ts # IntercomMonitor：连 broker，跟踪 ask 队列
│   │   │   ├── state-aggregator.ts # StateAggregator：事件聚合 → WS 推送
│   │   │   ├── ws-server.ts        # WebSocket server（前端连这里）
│   │   │   └── agent-md.ts         # agent.md frontmatter 解析/序列化
│   │   └── tests/
│   │       ├── agent-md.test.ts
│   │       ├── config-store.test.ts
│   │       ├── pi-rpc-client.test.ts
│   │       ├── agent-manager.test.ts
│   │       ├── intercom-monitor.test.ts
│   │       ├── state-aggregator.test.ts
│   │       └── e2e-smoke.test.ts
│   └── frontend/                   # ① React 前端
│       ├── package.json
│       ├── tsconfig.json
│       ├── vite.config.ts
│       ├── index.html
│       ├── src/
│       │   ├── main.tsx
│       │   ├── App.tsx
│       │   ├── styles.css              # Tailwind v4 入口 + Catppuccin 主题
│       │   ├── ws-instance.ts          # WebSocket 客户端单例
│       │   ├── api/ws.ts               # KernelWSClient
│       │   ├── store/
│       │   │   ├── agents.ts           # agent 列表/状态
│       │   │   ├── session.ts          # 当前会话/消息流
│       │   │   └── intercom.ts         # intercom ask 队列
│       │   ├── theme/agents.ts         # 四角色配色映射（spec 6.0）
│       │   └── components/
│       │       ├── LaunchScreen.tsx    # 启动页：4 角色卡片 (spec 6.1)
│       │       ├── SessionView.tsx     # 会话视图左右布局 (spec 6.1)
│       │       ├── Sidebar.tsx         # 左 sidebar (spec 6.1)
│       │       ├── MessageList.tsx     # 消息流
│       │       ├── MessageItem.tsx     # 气泡（圆角方向）(spec 6.1)
│       │       ├── Composer.tsx        # 底部输入框
│       │       ├── AskCard.tsx         # 委派卡片+三按钮 (spec 6.5)
│       │       ├── IntercomStatusBar.tsx # 底部状态条 (spec 6.1)
│       │       ├── Canvas.tsx          # 编排画布 (spec 6.3)
│       │       ├── CanvasNode.tsx      # 画布节点
│       │       ├── AgentConfig.tsx     # Agent 配置 (spec 6.6)
│       │       └── PartnerPanel.tsx    # 合作伙伴面板 (spec 6.6)
│       └── tests/
│           └── store.test.ts
└── src-tauri/                      # ③ Tauri Rust 壳
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── build.rs
    └── src/main.rs                 # 窗口 + Bun sidecar 生命周期
```

**职责边界**：
- `kernel/` 是唯一与 Pi 进程交互的地方；前端永远不直接 spawn pi
- `shared/` 让前后端用同一份类型定义（WSEvent 等），避免协议漂移
- `frontend/theme/agents.ts` 集中四角色配色（spec 6.0），组件引用不散落 hex
- `src-tauri/` 只管窗口 + 启停 Bun sidecar，不含业务逻辑

---

## Task 1: Monorepo 脚手架 + shared 类型包

**Files:**
- Create: `package.json`, `bunfig.toml`, `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/types.ts`, `packages/kernel/package.json`, `packages/kernel/tsconfig.json`, `packages/frontend/package.json`, `packages/frontend/tsconfig.json`
- Test: `packages/shared/tests/types.test.ts`

**Interfaces:**
- Produces: 可运行的 bun workspace；`hiagent-shared` 包导出全部共享类型

- [ ] **Step 1: root package.json（workspace）**

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

- [ ] **Step 2: bunfig.toml**

```toml
[test]
coverage = false
```

- [ ] **Step 3: packages/shared（共享类型，最底层）**

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

`packages/shared/src/types.ts`（核心类型定义，后续所有 task 引用）:
```typescript
// ===== Agent 配置（对应 ~/.pi/agent/agents/<name>.md frontmatter，spec 5.1）=====
export interface AgentConfig {
  name: string;
  displayName: string;
  avatar: string;            // emoji，如 "⚙️"
  description: string;
  model: string;             // "deepseek/deepseek-v4-flash"
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  tools: string[];           // 工具 allowlist
  skills: string[];
  partners: { askTo: string[]; askFrom: string[] };
  systemPrompt?: string;     // frontmatter 之后的 markdown body
}

// ===== Pi RPC 事件（pi --mode rpc stdout 每行一个，已验证）=====
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

// ===== 前端 ↔ 内核 WebSocket 事件 =====
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

- [ ] **Step 4: packages/kernel + frontend 脚手架 package.json/tsconfig**

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
  "dependencies": {
    "hiagent-shared": "workspace:*",
    "pi-intercom": "file:../../.pi/agent/npm/node_modules/pi-intercom"
  }
}
```

`packages/kernel/tsconfig.json`: 同 shared。

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
    "@tailwindcss/vite": "^4.0.0",
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

- [ ] **Step 5: 写类型守卫测试验证 types.ts 无语法错误**

`packages/shared/tests/types.test.ts`:
```typescript
import { test, expect } from "bun:test";
import type { AgentConfig, WSEvent, RPCEvent } from "../src/types";

test("AgentConfig 类型可构造", () => {
  const c: AgentConfig = {
    name: "dev", displayName: "研发", avatar: "⚙️",
    description: "后端", model: "deepseek/deepseek-v4-flash", thinking: "high",
    tools: ["read"], skills: [],
    partners: { askTo: ["product"], askFrom: ["product"] },
  };
  expect(c.name).toBe("dev");
});

test("WSEvent 联合类型可区分", () => {
  const e: WSEvent = { type: "agent:state", agentName: "dev", state: { status: "thinking" } };
  expect(e.type).toBe("agent:state");
});
```

- [ ] **Step 6: 安装依赖 + 跑测试**

Run: `cd /Users/pipi/work/HiAgent && bun install`
Expected: 安装成功

Run: `bun test`
Expected: `2 pass`

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: monorepo scaffold + shared types package"
```

---

## Task 2: agent.md 解析与序列化

**Files:**
- Create: `packages/kernel/src/agent-md.ts`
- Test: `packages/kernel/tests/agent-md.test.ts`

**Interfaces:**
- Consumes: `AgentConfig` from `hiagent-shared`
- Produces: `parseAgentMd(content: string): AgentConfig` / `serializeAgentMd(config: AgentConfig): string`

spec 5.1：每个 agent = 一个 `.md` 文件，frontmatter（YAML）+ markdown body（systemPrompt）。

- [ ] **Step 1: 写失败测试**

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
  expect(parseAgentMd(serializeAgentMd(c))).toEqual(c);
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `bun test packages/kernel/tests/agent-md.test.ts`
Expected: FAIL — `Cannot find module ../src/agent-md`

- [ ] **Step 3: 实现（最小 frontmatter 解析，不引入 yaml 依赖）**

`packages/kernel/src/agent-md.ts`:
```typescript
import type { AgentConfig } from "hiagent-shared";

export function parseAgentMd(content: string): AgentConfig {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error("Invalid agent.md: missing frontmatter");
  const [, fmRaw, bodyRaw] = m;
  const fm = parseFrontmatter(fmRaw);
  return {
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

function parseFrontmatter(raw: string): Record<string, any> {
  const result: Record<string, any> = {};
  let currentObj: Record<string, any> | null = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const objMatch = line.match(/^(\w+):$/);
    if (objMatch) { currentObj = {}; result[objMatch[1]] = currentObj; continue; }
    const nestedMatch = line.match(/^  (\w+):\s*(.*)$/);
    if (nestedMatch && currentObj) { currentObj[nestedMatch[1]] = parseValue(nestedMatch[2]); continue; }
    const kvMatch = line.match(/^(\w+):\s*(.*)$/);
    if (kvMatch) { currentObj = null; result[kvMatch[1]] = parseValue(kvMatch[2]); }
  }
  return result;
}

function parseValue(v: string): any {
  v = v.trim();
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  if (v.startsWith("[") && v.endsWith("]")) return v.slice(1, -1).split(",").map(s => s.trim()).filter(Boolean);
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
- Produces: `class ConfigStore { constructor(agentsDir: string); listAgents(): Promise<AgentConfig[]>; getAgent(name: string): Promise<AgentConfig | null>; saveAgent(config: AgentConfig): Promise<void> }`

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
test.beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hiagent-cfg-")); });
test.afterEach(async () => { await rm(dir, { recursive: true }); });

const makeConfig = (name: string): AgentConfig => ({
  name, displayName: name, avatar: "🤖", description: "",
  model: "deepseek/deepseek-v4-flash", thinking: "off",
  tools: ["read"], skills: [], partners: { askTo: [], askFrom: [] },
});

test("saveAgent 写文件 + listAgents 读回", async () => {
  const store = new ConfigStore(dir);
  await store.saveAgent(makeConfig("dev"));
  const agents = await store.listAgents();
  expect(agents.length).toBe(1);
  expect(agents[0].name).toBe("dev");
  expect(agents[0].tools).toEqual(["read"]);
});

test("getAgent 返回 null 当文件不存在", async () => {
  const store = new ConfigStore(dir);
  expect(await store.getAgent("nope")).toBeNull();
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `bun test packages/kernel/tests/config-store.test.ts`
Expected: FAIL — `Cannot find module ../src/config-store`

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
      const configs = await Promise.all(
        files.filter(f => f.endsWith(".md")).map(f => this.readAgentFile(join(this.agentsDir, f)))
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
    await writeFile(join(this.agentsDir, `${config.name}.md`), serializeAgentMd(config), "utf-8");
  }

  private async readAgentFile(path: string): Promise<AgentConfig | null> {
    try { return parseAgentMd(await readFile(path, "utf-8")); }
    catch (e: any) { if (e.code === "ENOENT") return null; throw e; }
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

## Task 4: PiRpcClient —— spawn pi + JSONL 协议

**Files:**
- Create: `packages/kernel/src/pi-rpc-client.ts`
- Test: `packages/kernel/tests/pi-rpc-client.test.ts`

**Interfaces:**
- Consumes: `AgentConfig`，`pi` 在 PATH
- Produces: `class PiRpcClient extends EventEmitter { constructor(config: AgentConfig, cwd: string); start(): Promise<void>; prompt(message: string): Promise<void>; abort(): Promise<void>; getState(): Promise<any>; on(event: "event" | "exit", cb): void; stop(): void }`

已验证事实（`docs/research/pi-intercom-rpc-compatibility.md`）：`pi --mode rpc` stdin 每行一个 JSON command，stdout 每行一个 JSON event；`--name`/`--provider`/`--model`/`--tools`/`--thinking` flag 可用；get_state 不耗模型 token。

- [ ] **Step 1: 写失败测试（真启动 pi，用 get_state 避免耗模型）**

`packages/kernel/tests/pi-rpc-client.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { PiRpcClient } from "../src/pi-rpc-client";
import type { AgentConfig } from "hiagent-shared";

const CFG: AgentConfig = {
  name: "test", displayName: "Test", avatar: "🧪", description: "",
  model: "deepseek/deepseek-v4-flash", thinking: "off",
  tools: [], skills: [], partners: { askTo: [], askFrom: [] },
};

test("PiRpcClient 启动 + get_state 返回 sessionName", async () => {
  const client = new PiRpcClient(CFG, "/tmp");
  const events: any[] = [];
  client.on("event", e => events.push(e));
  await client.start();
  const state = await client.getState();
  client.stop();
  expect(state.success).toBe(true);
  expect(state.data.sessionName).toBe("test");
  expect(events.some(e => e.type === "response" && e.command === "get_state")).toBe(true);
});
```

⚠️ 测试不耗模型 token：`get_state` 是纯本地命令。

- [ ] **Step 2: 跑测试验证失败**

Run: `bun test packages/kernel/tests/pi-rpc-client.test.ts`
Expected: FAIL — `Cannot find module ../src/pi-rpc-client`

- [ ] **Step 3: 实现 PiRpcClient**

`packages/kernel/src/pi-rpc-client.ts`:
```typescript
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { AgentConfig, RPCEvent } from "hiagent-shared";

interface PendingRequest { resolve: (data: any) => void; reject: (err: Error) => void; }

export class PiRpcClient extends EventEmitter {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private pending = new Map<string, PendingRequest>();
  private nextId = 1;

  constructor(private config: AgentConfig, private cwd: string) { super(); }

  async start(): Promise<void> {
    const [provider, ...modelParts] = this.config.model.split("/");
    const args = [
      "--mode", "rpc",
      "--name", this.config.name,
      "--provider", provider || "deepseek",
      "--model", modelParts.join("/") || this.config.model,
      "--thinking", this.config.thinking,
    ];
    if (this.config.tools.length === 0) args.push("--no-tools");
    else args.push("--tools", this.config.tools.join(","));
    for (const s of this.config.skills) args.push("--skill", s);
    if (this.config.systemPrompt) args.push("--system-prompt", this.config.systemPrompt);

    this.proc = spawn("pi", args, { stdio: ["pipe", "pipe", "pipe"], cwd: this.cwd, env: { ...process.env } });
    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", (chunk: string) => this.onStdout(chunk));
    this.proc.on("exit", (code, sig) => this.emit("exit", { code, sig }));
    await new Promise(r => setTimeout(r, 500)); // 等就绪
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try { this.handleEvent(JSON.parse(line) as RPCEvent); } catch {}
    }
  }

  private handleEvent(event: RPCEvent): void {
    if (event.type === "response" && "id" in event) {
      const req = this.pending.get(event.id);
      if (req) {
        this.pending.delete(event.id);
        event.success ? req.resolve(event) : req.reject(new Error(`RPC ${event.command} failed`));
        return;
      }
    }
    this.emit("event", event);
  }

  private send(command: Record<string, unknown>): Promise<any> {
    if (!this.proc?.stdin?.writable) return Promise.reject(new Error("Pi process not running"));
    const id = `r${this.nextId++}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc!.stdin!.write(JSON.stringify({ ...command, id }) + "\n");
    });
  }

  async prompt(message: string): Promise<void> { await this.send({ type: "prompt", message }); }
  async abort(): Promise<void> { await this.send({ type: "abort" }); }
  async getState(): Promise<any> { return this.send({ type: "get_state" }); }

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
Expected: `1 pass` — sessionName="test"

⚠️ 若失败：`which pi` 确认在 PATH。

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
- Consumes: `PiRpcClient` (Task 4), `ConfigStore` (Task 3)
- Produces: `class AgentManager extends EventEmitter { constructor(configStore: ConfigStore, cwd: string); listAvailableAgents(): Promise<AgentConfig[]>; ensureStarted(name: string): Promise<PiRpcClient>; get(name: string): PiRpcClient | undefined; getState(name: string): AgentState; stop(name: string): void; stopAll(): void }`。emit `"event"` 传 `{ agentName, event: RPCEvent }`，emit `"state"` 传 `{ agentName, state: AgentState }`。

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

test("listAvailableAgents 返回配置", async () => {
  const store = new ConfigStore(dir);
  await store.saveAgent(makeConfig("dev"));
  await store.saveAgent(makeConfig("pm"));
  const mgr = new AgentManager(store, "/tmp");
  expect((await mgr.listAvailableAgents()).map(a => a.name).sort()).toEqual(["dev", "pm"]);
});

test("ensureStarted 启动并缓存同一实例", async () => {
  const store = new ConfigStore(dir);
  await store.saveAgent(makeConfig("dev"));
  const mgr = new AgentManager(store, "/tmp");
  const c1 = await mgr.ensureStarted("dev");
  const c2 = await mgr.ensureStarted("dev");
  expect(c2).toBe(c1);
  mgr.stopAll();
});

test("get 未启动返回 undefined", () => {
  expect(new AgentManager(new ConfigStore(dir), "/tmp").get("ghost")).toBeUndefined();
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `bun test packages/kernel/tests/agent-manager.test.ts`
Expected: FAIL — `Cannot find module ../src/agent-manager`

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

  constructor(private configStore: ConfigStore, private cwd: string) { super(); }

  async listAvailableAgents(): Promise<AgentConfig[]> { return this.configStore.listAgents(); }

  async ensureStarted(name: string): Promise<PiRpcClient> {
    let client = this.clients.get(name);
    if (client) return client;
    const config = await this.configStore.getAgent(name);
    if (!config) throw new Error(`Agent "${name}" not found`);
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

  get(name: string): PiRpcClient | undefined { return this.clients.get(name); }
  getState(name: string): AgentState { return this.states.get(name) ?? { status: "idle" }; }
  stop(name: string): void { this.clients.get(name)?.stop(); this.clients.delete(name); }
  stopAll(): void { for (const c of this.clients.values()) c.stop(); this.clients.clear(); }

  private updateState(name: string, event: RPCEvent): void {
    const prev = this.states.get(name) ?? { status: "idle" };
    let next = prev;
    if (event.type === "agent_start" || event.type === "turn_start") next = { ...prev, status: "thinking" };
    else if (event.type === "agent_end") next = { ...prev, status: "idle" };
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

## Task 6: IntercomMonitor —— 连 broker，跟踪 ask + 用户替答注入

**Files:**
- Create: `packages/kernel/src/intercom-monitor.ts`
- Test: `packages/kernel/tests/intercom-monitor.test.ts`

**Interfaces:**
- Consumes: pi-intercom broker（`~/.pi/agent/intercom/broker.sock`）
- Produces: `class IntercomMonitor extends EventEmitter { connect(): Promise<void>; disconnect(): Promise<void>; listSessions(): Promise<any[]>; on(event: "message" | "reply", cb): void; injectReply(askMessageId: string, fromAgent: string, toAskFrom: string, text: string): Promise<void> }`

已验证事实：IntercomClient API `connect({name,cwd,model,pid,startedAt,lastActivity})` / `listSessions()` / `on("message",(from,msg)=>{})` / `send(to,{text,replyTo,expectsReply})`；Message 结构 `{id,replyTo?,expectsReply?,content:{text}}`。v0.6.0 无 ask 超时 GC（spec 4.1）。

- [ ] **Step 1: 写失败测试（依赖 broker，先 spawn pi 触发 auto-spawn）**

`packages/kernel/tests/intercom-monitor.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { IntercomMonitor } from "../src/intercom-monitor";

const SOCK = `${process.env.HOME}/.pi/agent/intercom/broker.sock`;

test("IntercomMonitor connect 后 listSessions 非空", async () => {
  if (!existsSync(SOCK)) {
    const pi = spawn("pi", ["--mode", "rpc", "--name", "im-fixture", "--no-tools"]);
    for (let i = 0; i < 20 && !existsSync(SOCK); i++) await new Promise(r => setTimeout(r, 500));
    await new Promise(r => setTimeout(r, 1000));
    pi.kill("SIGKILL");
  }
  const mon = new IntercomMonitor();
  await mon.connect();
  const sessions = await mon.listSessions();
  await mon.disconnect();
  expect(Array.isArray(sessions)).toBe(true);
  expect(sessions.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `bun test packages/kernel/tests/intercom-monitor.test.ts`
Expected: FAIL — `Cannot find module ../src/intercom-monitor`

- [ ] **Step 3: 实现 IntercomMonitor**

`packages/kernel/src/intercom-monitor.ts`:
```typescript
import { EventEmitter } from "node:events";
import { IntercomClient } from "pi-intercom/broker/client";

export class IntercomMonitor extends EventEmitter {
  private client: IntercomClient | null = null;

  async connect(): Promise<void> {
    if (this.client) return;
    this.client = new IntercomClient();
    this.client.on("message", (from: any, message: any) => {
      const text = message.content?.text ?? "";
      const fromName = from?.name ?? from?.id;
      if (message.replyTo) {
        this.emit("reply", { toAskMessageId: message.replyTo, text, from: fromName });
      } else {
        this.emit("message", { from: fromName, message });
      }
    });
    await this.client.connect({
      name: "hiagent-monitor", cwd: process.cwd(), model: "monitor",
      pid: process.pid, startedAt: Date.now(), lastActivity: Date.now(), status: "monitor",
    });
  }

  async disconnect(): Promise<void> { await this.client?.disconnect(); this.client = null; }
  async listSessions(): Promise<any[]> {
    if (!this.client) throw new Error("Not connected");
    return this.client.listSessions();
  }

  /** 用户替答（spec 4.3 🙋 我来回答）：合成 reply 给原 ask 发起方 */
  async injectReply(askMessageId: string, _fromAgent: string, toAskFrom: string, text: string): Promise<void> {
    if (!this.client) throw new Error("Not connected");
    const sessions = await this.client.listSessions();
    const target = sessions.find((s: any) => s.name === toAskFrom);
    if (!target) throw new Error(`Agent ${toAskFrom} not on broker`);
    await this.client.send(target.id, { text, replyTo: askMessageId });
  }
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `bun test packages/kernel/tests/intercom-monitor.test.ts`
Expected: `1 pass`

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/intercom-monitor.ts packages/kernel/tests/intercom-monitor.test.ts
git commit -m "feat(kernel): IntercomMonitor connects to broker, injectReply for user intervention"
```

---

## Task 7: StateAggregator + WebSocket Server

**Files:**
- Create: `packages/kernel/src/state-aggregator.ts`, `packages/kernel/src/ws-server.ts`
- Test: `packages/kernel/tests/state-aggregator.test.ts`

**Interfaces:**
- Consumes: AgentManager（"event"/"state"）+ IntercomMonitor（"reply"）
- Produces: `class StateAggregator extends EventEmitter { constructor(agentManager, intercomMonitor); start(): void; on(event: "ws:event", cb): void }` + `class WSServer { constructor(port: number, aggregator); start(): Promise<void>; onClientMessage(cb): void }`

核心逻辑（spec 6.5）：当 PiRpcClient 收到 `tool_execution_start`（toolName="intercom"，args 含 to/message/expectsReply），发 `intercom:ask` WSEvent。

- [ ] **Step 1: 写失败测试（单元测试，mock 事件源）**

`packages/kernel/tests/state-aggregator.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { StateAggregator } from "../src/state-aggregator";

test("tool_execution_start intercom + expectsReply → intercom:ask", () => {
  const events: any[] = [];
  const agg = new StateAggregator({} as any, {} as any);
  agg.on("ws:event", e => events.push(e));
  agg.handleAgentEvent("alice", {
    type: "tool_execution_start", toolCallId: "tc1", toolName: "intercom",
    args: { to: "bob", message: "1+1?", expectsReply: true },
  });
  expect(events[0].type).toBe("intercom:ask");
  expect(events[0]).toMatchObject({ from: "alice", to: "bob", text: "1+1?" });
});

test("intercom reply → intercom:reply", () => {
  const events: any[] = [];
  const agg = new StateAggregator({} as any, {} as any);
  agg.on("ws:event", e => events.push(e));
  agg.handleIntercomReply({ toAskMessageId: "msg1", text: "2", from: "bob" });
  expect(events[0]).toMatchObject({ type: "intercom:reply", toAskMessageId: "msg1", text: "2" });
});

test("message_end → agent:message", () => {
  const events: any[] = [];
  const agg = new StateAggregator({} as any, {} as any);
  agg.on("ws:event", e => events.push(e));
  agg.handleAgentEvent("alice", {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
  });
  expect(events.find(e => e.type === "agent:message").message.text).toBe("hello");
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `bun test packages/kernel/tests/state-aggregator.test.ts`
Expected: FAIL — `Cannot find module ../src/state-aggregator`

- [ ] **Step 3: 实现 StateAggregator**

`packages/kernel/src/state-aggregator.ts`:
```typescript
import { EventEmitter } from "node:events";
import type { AgentManager } from "./agent-manager";
import type { IntercomMonitor } from "./intercom-monitor";
import type { RPCEvent, WSEvent, ChatMessage } from "hiagent-shared";

interface IntercomToolArgs { to?: string; message?: string; text?: string; expectsReply?: boolean; replyTo?: string; }

export class StateAggregator extends EventEmitter {
  constructor(private agentManager: AgentManager, private intercomMonitor: IntercomMonitor) { super(); }

  start(): void {
    this.agentManager.on("event", ({ agentName, event }) => this.handleAgentEvent(agentName, event));
    this.agentManager.on("state", ({ agentName, state }) => {
      this.emit("ws:event", { type: "agent:state", agentName, state } as WSEvent);
    });
    this.intercomMonitor.on("reply", (r) => this.handleIntercomReply(r));
  }

  handleAgentEvent(agentName: string, event: RPCEvent): void {
    switch (event.type) {
      case "tool_execution_start":
        if (event.toolName === "intercom") {
          const args = (event.args ?? {}) as IntercomToolArgs;
          if (args.expectsReply && args.to) {
            this.emit("ws:event", {
              type: "intercom:ask", from: agentName, to: args.to,
              messageId: event.toolCallId, text: args.message ?? args.text ?? "", startedAt: Date.now(),
            } as WSEvent);
          }
        }
        this.emit("ws:event", { type: "agent:tool", agentName, toolName: event.toolName, toolCallId: event.toolCallId, phase: "start" } as WSEvent);
        break;
      case "tool_execution_end": {
        const resultText = event.result?.content?.map((c: any) => c.text ?? "").join("") ?? "";
        this.emit("ws:event", { type: "agent:tool", agentName, toolName: event.toolName, toolCallId: event.toolCallId, phase: "end", result: resultText } as WSEvent);
        break;
      }
      case "message_end": {
        const text = event.message.content?.map((c: any) => c.text ?? "").join("") ?? "";
        if (text) {
          const msg: ChatMessage = { id: `m${Date.now()}-${Math.random().toString(36).slice(2,6)}`, role: event.message.role === "user" ? "user" : "assistant", text, timestamp: Date.now() };
          this.emit("ws:event", { type: "agent:message", agentName, message: msg } as WSEvent);
        }
        break;
      }
    }
  }

  handleIntercomReply(r: { toAskMessageId: string; text: string; from: string }): void {
    this.emit("ws:event", { type: "intercom:reply", toAskMessageId: r.toAskMessageId, text: r.text } as WSEvent);
  }
}
```

- [ ] **Step 4: 实现 WSServer（Bun.serve websocket）**

`packages/kernel/src/ws-server.ts`:
```typescript
import type { StateAggregator } from "./state-aggregator";
import type { WSEvent } from "hiagent-shared";

export class WSServer {
  private server: any = null;
  private sockets = new Set<any>();
  private clientHandler: ((msg: any) => void) | null = null;

  constructor(private port: number, private aggregator: StateAggregator) {}

  async start(): Promise<void> {
    this.server = Bun.serve({
      port: this.port,
      websocket: {
        open: (ws) => { this.sockets.add(ws); },
        message: (ws, msg) => {
          if (typeof msg === "string") { try { this.clientHandler?.(JSON.parse(msg)); } catch {} }
        },
        close: (ws) => { this.sockets.delete(ws); },
      },
      fetch: (req, server) => { if (server.upgrade(req)) return; return new Response("HiAgent kernel WS", { status: 200 }); },
    });
    this.aggregator.on("ws:event", (event: WSEvent) => {
      const data = JSON.stringify(event);
      for (const ws of this.sockets) ws.send(data);
    });
  }

  onClientMessage(cb: (msg: any) => void): void { this.clientHandler = cb; }
  stop(): void { this.server?.stop(); this.server = null; }
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

**Interfaces:**
- Consumes: Task 3-7 全部
- Produces: `bun run packages/kernel/src/index.ts` 启动 9776 端口的完整内核

- [ ] **Step 1: 实现 index.ts（组装 + WS 命令分发）**

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
  const port = 9776;
  console.log(`[HiAgent kernel] agentsDir=${agentsDir} cwd=${cwd} port=${port}`);

  const configStore = new ConfigStore(agentsDir);
  const agentManager = new AgentManager(configStore, cwd);
  const intercomMonitor = new IntercomMonitor();
  const aggregator = new StateAggregator(agentManager, intercomMonitor);
  const wsServer = new WSServer(port, aggregator);

  aggregator.start();
  await wsServer.start();
  await intercomMonitor.connect().catch(() => console.log("[kernel] broker not ready, will retry"));

  wsServer.onClientMessage(async (msg) => {
    try {
      switch (msg.type) {
        case "agents:list":
          aggregator.emit("ws:event", { type: "agents:list", agents: await agentManager.listAvailableAgents() });
          break;
        case "agent:prompt":
          await intercomMonitor.connect().catch(() => {});
          await (await agentManager.ensureStarted(msg.agentName)).prompt(msg.message);
          break;
        case "agent:abort":
          agentManager.get(msg.agentName)?.abort();
          break;
        case "intercom:inject-reply":
          await intercomMonitor.injectReply(msg.messageId, msg.agentName, msg.toAskFrom, msg.text);
          break;
      }
    } catch (e: any) { console.error("[kernel] cmd error:", e.message); }
  });

  console.log(`[HiAgent kernel] listening on ws://localhost:${port}`);
  process.on("SIGINT", async () => { agentManager.stopAll(); await intercomMonitor.disconnect(); wsServer.stop(); process.exit(0); });
}
main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 写端到端冒烟测试（真启动内核，DeepSeek 跑一次 prompt，断言 WS 收到事件）**

⚠️ 消耗少量 DeepSeek token。

`packages/kernel/tests/e2e-smoke.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string, kernelProc: any, wsClient: any;

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "hiagent-e2e-"));
  const agentsDir = join(dir, "agents");
  await mkdir(agentsDir, { recursive: true });
  await writeFile(join(agentsDir, "dev.md"), `---
name: dev
displayName: 研发
avatar: "⚙️"
model: deepseek/deepseek-v4-flash
thinking: off
tools: read
---
简短回答。`);
  kernelProc = spawn("bun", ["run", "packages/kernel/src/index.ts"], {
    cwd: "/Users/pipi/work/HiAgent",
    env: { ...process.env, HIAGENT_AGENTS_DIR: agentsDir, HIAGENT_CWD: dir, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY! },
    stdio: ["pipe", "pipe", "pipe"],
  });
  await new Promise(r => setTimeout(r, 2000));
  wsClient = new WebSocket("ws://localhost:9776");
  await new Promise<void>((resolve, reject) => {
    wsClient.onopen = () => resolve();
    setTimeout(() => reject(new Error("WS timeout")), 3000);
  });
});

test.afterAll(async () => { wsClient?.close(); kernelProc?.kill("SIGKILL"); await rm(dir, { recursive: true, force: true }); });

test("完整流程：agents:list → prompt → agent:message", async () => {
  const received: any[] = [];
  wsClient.onmessage = (ev: any) => { try { received.push(JSON.parse(ev.data)); } catch {} };
  wsClient.send(JSON.stringify({ type: "agents:list" }));
  await new Promise(r => setTimeout(r, 500));
  expect(received.some(e => e.type === "agents:list")).toBe(true);
  wsClient.send(JSON.stringify({ type: "agent:prompt", agentName: "dev", message: "只回复 OK" }));
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

Run（需 DEEPSEEK_API_KEY）:
```bash
export DEEPSEEK_API_KEY="你的key"
bun test packages/kernel/tests/e2e-smoke.test.ts
```
Expected: `1 pass`

⚠️ 排查：内核没启动看 stderr；WS 连不上 `lsof -i:9776`；agent:message 没来看内核日志。

- [ ] **Step 4: Commit**

```bash
git add packages/kernel/src/index.ts packages/kernel/tests/e2e-smoke.test.ts
git commit -m "feat(kernel): wire all components, e2e smoke test with DeepSeek"
```

---

## Task 9: 前端脚手架 + Tailwind Catppuccin 主题（spec 6.0）

**Files:**
- Create: `packages/frontend/vite.config.ts`, `packages/frontend/index.html`, `packages/frontend/src/main.tsx`, `packages/frontend/src/styles.css`, `packages/frontend/src/theme/agents.ts`, `packages/frontend/src/api/ws.ts`, `packages/frontend/src/ws-instance.ts`, `packages/frontend/src/App.tsx`

**Interfaces:**
- Consumes: kernel WebSocket（ws://localhost:9776）
- Produces: `bun run --filter hiagent-frontend dev` 启动 Vite，显示连接状态。Tailwind 主题就绪，`bg-base`/`text-blue` 等语义 class 可用

**spec 6.0 配色映射**（Tailwind v4 用 `@theme` 定义，CSS-first 配置）：
- `--color-base: #1e1e2e` → `bg-base`
- `--color-mantle: #181825` → `bg-mantle`
- `--color-surface: #313244` → `bg-surface`
- `--color-surface2: #585b70` → `border-surface2`
- `--color-text: #cdd6f4` → `text-text`
- `--color-subtext: #a6adc8` → `text-subtext`
- `--color-overlay: #6c7086` → `text-overlay`
- `--color-blue: #89b4fa`、`--color-green: #a6e3a1`、`--color-peach: #fab387`、`--color-yellow: #f9e2af`、`--color-mauve: #cba6f7`、`--color-red: #f38ba8`、`--color-lavender: #b4befe`、`--color-maroon: #ebbc9e`、`--color-teal: #94e2d5`

- [ ] **Step 1: vite.config.ts（含 Tailwind v4 插件）**

`packages/frontend/vite.config.ts`:
```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173 },
});
```

`packages/frontend/index.html`:
```html
<!DOCTYPE html>
<html lang="zh">
  <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>HiAgent</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
```

- [ ] **Step 2: styles.css（Tailwind v4 @theme 定义 Catppuccin，spec 6.0）**

`packages/frontend/src/styles.css`:
```css
@import "tailwindcss";

@theme {
  /* spec 6.0 Catppuccin Mocha */
  --color-base: #1e1e2e;
  --color-mantle: #181825;
  --color-surface: #313244;
  --color-surface2: #585b70;
  --color-text: #cdd6f4;
  --color-subtext: #a6adc8;
  --color-overlay: #6c7086;
  --color-blue: #89b4fa;
  --color-green: #a6e3a1;
  --color-peach: #fab387;
  --color-yellow: #f9e2af;
  --color-mauve: #cba6f7;
  --color-red: #f38ba8;
  --color-lavender: #b4befe;
  --color-maroon: #ebbc9e;
  --color-teal: #94e2d5;
}

body {
  background: var(--color-base);
  color: var(--color-text);
  font-family: 'Segoe UI', -apple-system, sans-serif;
}

/* ask 阻塞节点的 pulse 动画（spec 6.0 状态语义） */
@keyframes hiagent-pulse {
  0%, 100% { box-shadow: 0 0 15px rgba(250,179,135,0.4); }
  50% { box-shadow: 0 0 25px rgba(250,179,135,0.7); }
}
.animate-hiagent-pulse { animation: hiagent-pulse 1.5s infinite; }
```

- [ ] **Step 3: theme/agents.ts（四角色配色映射，spec 6.0 四角色设定）**

`packages/frontend/src/theme/agents.ts`:
```typescript
import type { AgentConfig } from "hiagent-shared";

// spec 6.0 四角色：emoji + 渐变色 + 副文案
export const AGENT_THEME: Record<string, { gradient: [string, string]; subtitle: string }> = {
  product: { gradient: ["#89b4fa", "#b4befe"], subtitle: "需求设计" },
  pm:      { gradient: ["#f9e2af", "#ebbc9e"], subtitle: "项目管理" },
  dev:     { gradient: ["#fab387", "#f38ba8"], subtitle: "技术实现" },
  test:    { gradient: ["#a6e3a1", "#94e2d5"], subtitle: "质量验收" },
};

export function agentGradient(name: string): [string, string] {
  return AGENT_THEME[name]?.gradient ?? ["#6c7086", "#585b70"];
}

export function avatarStyle(name: string, size: number): React.CSSProperties {
  const [from, to] = agentGradient(name);
  return {
    width: size, height: size, borderRadius: "50%",
    background: `linear-gradient(135deg, ${from}, ${to})`,
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: size * 0.5, flexShrink: 0,
  };
}
```

- [ ] **Step 4: api/ws.ts + ws-instance.ts（WebSocket 客户端单例）**

`packages/frontend/src/api/ws.ts`:
```typescript
import type { WSEvent } from "hiagent-shared";

export class KernelWSClient {
  private ws: WebSocket | null = null;
  private handlers: Array<(e: WSEvent) => void> = [];

  connect(url = "ws://localhost:9776"): void {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev) => {
      try { this.handlers.forEach(h => h(JSON.parse(ev.data) as WSEvent)); } catch {}
    };
    this.ws.onclose = () => setTimeout(() => this.connect(url), 3000);
  }
  get readyState(): number { return this.ws?.readyState ?? 0; }
  onEvent(cb: (e: WSEvent) => void): () => void {
    this.handlers.push(cb);
    return () => { this.handlers = this.handlers.filter(h => h !== cb); };
  }
  send(msg: any): void { this.ws?.send(JSON.stringify(msg)); }
}
```

`packages/frontend/src/ws-instance.ts`:
```typescript
import { KernelWSClient } from "./api/ws";
export const wsClient = new KernelWSClient();
```

- [ ] **Step 5: main.tsx + App.tsx（连接状态占位）**

`packages/frontend/src/main.tsx`:
```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
```

`packages/frontend/src/App.tsx`:
```tsx
import { useEffect, useState } from "react";
import { wsClient } from "./ws-instance";

export function App() {
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    wsClient.connect();
    const t = setInterval(() => setConnected(wsClient.readyState === WebSocket.OPEN), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="h-screen flex items-center justify-center text-overlay">
      {connected ? "内核已连接 ✓（Task 10 实现）" : "正在连接内核..."}
    </div>
  );
}
```

- [ ] **Step 6: 安装依赖 + 验证 dev server**

Run: `cd /Users/pipi/work/HiAgent && bun install`
Run: `bun run --filter hiagent-frontend dev`
Expected: Vite 启动，localhost:5173 显示深色背景 + 连接状态

- [ ] **Step 7: Commit**

```bash
git add packages/frontend/
git commit -m "feat(frontend): scaffold + Tailwind Catppuccin theme (spec 6.0) + WS client"
```

---

## Task 10: Zustand stores + 启动页（4 角色卡片，spec 6.1）

**Files:**
- Create: `packages/frontend/src/store/agents.ts`, `packages/frontend/src/store/session.ts`, `packages/frontend/src/components/LaunchScreen.tsx`
- Modify: `packages/frontend/src/App.tsx`

**Interfaces:**
- Consumes: kernel `agents:list`/`agent:state` events
- Produces: 启动页显示 4 角色卡片（横排，选中态蓝边框+发光），选中后切到会话视图

spec 6.1 启动页：居中布局，"开始新会话"标题 + 4 角色卡片（min-width 100px，gap 12px）+ 输入框（左侧角色 emoji，placeholder "给XX描述你的需求，或 /命令..."）+ 底部提示。

- [ ] **Step 1: stores**

`packages/frontend/src/store/agents.ts`:
```typescript
import { create } from "zustand";
import type { AgentConfig, AgentState } from "hiagent-shared";

interface AgentsStore {
  list: AgentConfig[];
  states: Record<string, AgentState>;
  setList: (a: AgentConfig[]) => void;
  updateState: (n: string, s: AgentState) => void;
}
export const useAgents = create<AgentsStore>((set) => ({
  list: [], states: {},
  setList: (agents) => set({ list: agents }),
  updateState: (name, state) => set((s) => ({ states: { ...s.states, [name]: state } })),
}));
```

`packages/frontend/src/store/session.ts`:
```typescript
import { create } from "zustand";
import type { ChatMessage } from "hiagent-shared";

interface SessionStore {
  currentAgent: string | null;
  messages: Record<string, ChatMessage[]>;
  selectAgent: (n: string) => void;
  addMessage: (agentName: string, msg: ChatMessage) => void;
}
export const useSession = create<SessionStore>((set) => ({
  currentAgent: null, messages: {},
  selectAgent: (name) => set({ currentAgent: name }),
  addMessage: (agentName, msg) => set((s) => ({
    messages: { ...s.messages, [agentName]: [...(s.messages[agentName] ?? []), msg] },
  })),
}));
```

- [ ] **Step 2: LaunchScreen（4 角色卡片 + 输入框，精确对齐 09 原型）**

`packages/frontend/src/components/LaunchScreen.tsx`:
```tsx
import { useEffect, useState } from "react";
import { useAgents } from "../store/agents";
import { useSession } from "../store/session";
import { wsClient } from "../ws-instance";
import { AGENT_THEME } from "../theme/agents";
import type { AgentConfig } from "hiagent-shared";

function RoleCard({ agent, selected, onClick }: { agent: AgentConfig; selected: boolean; onClick: () => void }) {
  const [from, to] = AGENT_THEME[agent.name]?.gradient ?? ["#6c7086", "#585b70"];
  return (
    <div
      onClick={onClick}
      className="text-center cursor-pointer rounded-xl p-[14px_18px] min-w-[100px] border-2 transition"
      style={selected
        ? { borderColor: "#89b4fa", background: "rgba(137,180,250,0.15)", boxShadow: "0 0 20px rgba(137,180,250,0.2)" }
        : { borderColor: "transparent", background: "#313244" }}
    >
      <div className="w-11 h-11 rounded-full mx-auto mb-1.5 flex items-center justify-center text-[22px]"
           style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}>
        {agent.avatar}
      </div>
      <div className="font-semibold text-[12px]" style={{ color: selected ? "#89b4fa" : "#cdd6f4" }}>
        {agent.displayName}
      </div>
      <div className="text-[9px] text-overlay mt-0.5">{AGENT_THEME[agent.name]?.subtitle ?? agent.description}</div>
    </div>
  );
}

export function LaunchScreen() {
  const list = useAgents(s => s.list);
  const setList = useAgents(s => s.setList);
  const selectAgent = useSession(s => s.selectAgent);
  const [selected, setSelected] = useState<string | null>(null);
  const [text, setText] = useState("");

  useEffect(() => {
    wsClient.send({ type: "agents:list" });
    const off = wsClient.onEvent(e => { if (e.type === "agents:list") setList(e.agents); });
    return off;
  }, [setList]);

  const send = () => {
    if (!selected || !text.trim()) return;
    selectAgent(selected);
    // 进入会话视图后，SessionView 会接管发送；这里只触发选中
    setText("");
  };

  return (
    <div className="h-screen flex flex-col">
      {/* 顶栏：09原型 */}
      <div className="bg-mantle px-4 py-2 flex items-center justify-between border-b border-surface">
        <span className="font-semibold text-blue">HiAgent</span>
        <div className="flex gap-2.5">
          {["🗂 历史", "🧩 插件", "⚙ 设置"].map(t =>
            <span key={t} className="bg-surface px-2.5 py-[3px] rounded text-[10px] text-overlay cursor-pointer">{t}</span>
          )}
        </div>
      </div>
      {/* 居中区 */}
      <div className="flex-1 flex flex-col items-center justify-center p-10">
        <div className="text-[28px] font-bold text-text mb-2">开始新会话</div>
        <div className="text-overlay text-[13px] mb-8">选择一个角色，告诉它你要做什么</div>
        <div className="flex gap-3 mb-6">
          {list.map(a => (
            <RoleCard key={a.name} agent={a} selected={selected === a.name} onClick={() => setSelected(a.name)} />
          ))}
          {list.length === 0 && <div className="text-overlay">加载中...（确认内核已启动）</div>}
        </div>
        {/* 输入框 */}
        <div className="w-full max-w-[640px] bg-surface border border-surface2 rounded-xl p-[14px_16px]">
          <div className="flex items-start gap-2.5">
            {selected && <span className="text-blue text-[14px]">{list.find(a => a.name === selected)?.avatar}</span>}
            <input
              className="bg-transparent border-none text-text flex-1 text-[13px] outline-none"
              placeholder={selected ? `给${list.find(a => a.name === selected)?.displayName}描述你的需求，或 /命令...` : "先选择一个角色..."}
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            />
          </div>
          <div className="flex justify-between items-center mt-2.5">
            <div className="flex gap-1.5">
              <span className="bg-base px-2 py-[3px] rounded text-[10px] text-overlay cursor-pointer">📎 附件</span>
              <span className="bg-base px-2 py-[3px] rounded text-[10px] text-overlay cursor-pointer">🎨 模型</span>
            </div>
            <button onClick={send} disabled={!selected || !text.trim()}
              className="bg-blue text-base px-3.5 py-[5px] rounded-md text-[11px] font-semibold disabled:opacity-50">
              发送 →
            </button>
          </div>
        </div>
        <div className="mt-4 text-overlay text-[10px] text-center">
          💡 选好角色后直接打字发送即可开始。会话中 agent 可通过 intercom 委派给其他角色。
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: App.tsx（路由：未选角色→启动页，已选→会话视图）**

`packages/frontend/src/App.tsx`:
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
    const t = setInterval(() => setConnected(wsClient.readyState === WebSocket.OPEN), 1000);
    return () => clearInterval(t);
  }, []);
  if (!connected) return <div className="h-screen flex items-center justify-center text-overlay">正在连接内核...</div>;
  if (!currentAgent) return <LaunchScreen />;
  return <SessionView />;
}
```

⚠️ `SessionView` 在 Task 11 创建。先建占位让编译通过：`packages/frontend/src/components/SessionView.tsx`:
```tsx
export function SessionView() { return <div className="p-4 text-overlay">SessionView（Task 11 实现）</div>; }
```

- [ ] **Step 4: 验证启动页**

Run: kernel + frontend，浏览器显示 4 角色卡片（需 `~/.pi/agent/agents/` 有 .md 或 HIAGENT_AGENTS_DIR 指定）
Expected: 4 卡片横排，点击选中变蓝边框+发光，输入框出现角色 emoji

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/store/ packages/frontend/src/components/LaunchScreen.tsx packages/frontend/src/components/SessionView.tsx packages/frontend/src/App.tsx
git commit -m "feat(frontend): Zustand stores + launch screen with 4 role cards (spec 6.1)"
```

---

## Task 11: 会话视图 —— 左右布局 + 流式消息（spec 6.1）

**Files:**
- Create: `packages/frontend/src/components/Sidebar.tsx`, `packages/frontend/src/components/MessageList.tsx`, `packages/frontend/src/components/MessageItem.tsx`, `packages/frontend/src/components/Composer.tsx`, `packages/frontend/src/components/IntercomStatusBar.tsx`
- Replace: `packages/frontend/src/components/SessionView.tsx`

**Interfaces:**
- Consumes: `useAgents`, `useSession`, kernel `agent:message`/`agent:state`
- Produces: Codex 式左右布局，发 prompt 看流式回复

spec 6.1 会话视图：grid `260px 1fr`。气泡圆角方向（用户 `4 12 12 12`、assistant `12 4 12 12`）。sidebar 角色项选中态蓝左条+"当前"绿徽标。

- [ ] **Step 1: Sidebar（角色列表 + 历史 + 底部 intercom mini 状态）**

`packages/frontend/src/components/Sidebar.tsx`:
```tsx
import { useAgents } from "../store/agents";
import { useSession } from "../store/session";
import { avatarStyle } from "../theme/agents";

export function Sidebar() {
  const list = useAgents(s => s.list);
  const states = useAgents(s => s.states);
  const currentAgent = useSession(s => s.currentAgent);
  const selectAgent = useSession(s => s.selectAgent);

  return (
    <div className="w-[260px] bg-mantle border-r border-surface flex flex-col">
      <div className="p-2.5 border-b border-surface">
        <div className="bg-surface border border-dashed border-surface2 rounded-md py-2 text-center text-overlay text-[11px] cursor-pointer">+ 新会话</div>
      </div>
      <div className="p-2.5 border-b border-surface">
        <div className="text-overlay text-[9px] font-semibold mb-2 uppercase tracking-wider">角色</div>
        <div className="flex flex-col gap-1">
          {list.map(a => {
            const st = states[a.name]?.status ?? "idle";
            const isCurrent = currentAgent === a.name;
            const dotColor = st === "thinking" ? "#89b4fa" : st === "blocked" ? "#fab387" : "transparent";
            return (
              <div key={a.name} onClick={() => selectAgent(a.name)}
                className="py-1.5 px-2 rounded flex items-center gap-2 cursor-pointer"
                style={isCurrent ? { background: "rgba(137,180,250,0.15)", borderLeft: "2px solid #89b4fa" } : {}}>
                <div style={avatarStyle(a.name, 22)}>{a.avatar}</div>
                <div className={"text-[11px] font-semibold flex-1 " + (isCurrent ? "text-blue" : "text-text")}>{a.displayName}</div>
                {isCurrent && <span className="bg-green/20 text-green text-[8px] px-[5px] py-px rounded-md">当前</span>}
                {!isCurrent && st !== "idle" && <span className="text-[8px]" style={{ color: dotColor }}>●</span>}
              </div>
            );
          })}
        </div>
      </div>
      <div className="p-2.5 flex-1 overflow-y-auto">
        <div className="text-overlay text-[9px] font-semibold mb-2 uppercase tracking-wider">会话历史</div>
        {/* MVP：会话历史暂用占位 */}
        <div className="text-overlay text-[10px] italic">（MVP：历史功能后续迭代）</div>
      </div>
      <IntercomStatusBar />
    </div>
  );
}

function IntercomStatusBar() {
  // 底部 intercom mini 状态（spec 6.1）：MVP 先显示静态占位，Task 12 接真实 ask
  return (
    <div className="p-2 px-2.5 border-t border-surface" style={{ background: "rgba(250,179,135,0.06)" }}>
      <div className="text-[9px] text-overlay">📡 intercom 状态（Task 12 接线）</div>
    </div>
  );
}
```

- [ ] **Step 2: MessageItem（气泡圆角方向，spec 6.1）+ MessageList**

`packages/frontend/src/components/MessageItem.tsx`:
```tsx
import type { ChatMessage } from "hiagent-shared";
import { avatarStyle } from "../theme/agents";

export function MessageItem({ msg, agentAvatar, agentName, agentKey }: { msg: ChatMessage; agentAvatar: string; agentName: string; agentKey: string }) {
  const isUser = msg.role === "user";
  return (
    <div className="flex gap-2.5 items-start">
      <div className={"w-7 h-7 rounded-full flex items-center justify-center text-[12px] flexshrink-0 " + (isUser ? "bg-surface2 text-text" : "")}
           style={!isUser ? avatarStyle(agentKey, 28) : {}}>
        {isUser ? "你" : agentAvatar}
      </div>
      <div className="flex-1 max-w-[80%]">
        <div className="p-[10px_14px] text-[12px] leading-relaxed text-text"
             style={{ background: isUser ? "#313244" : "#181825",
                      borderRadius: isUser ? "4px 12px 12px 12px" : "12px 4px 12px 12px" }}>
          <p className="whitespace-pre-wrap">{msg.text}</p>
        </div>
        <div className="text-[9px] text-overlay mt-[3px]">{isUser ? "你" : agentName} · {new Date(msg.timestamp).toLocaleTimeString().slice(0,5)}</div>
      </div>
    </div>
  );
}
```

`packages/frontend/src/components/MessageList.tsx`:
```tsx
import { useEffect, useRef } from "react";
import { useSession } from "../store/session";
import { useAgents } from "../store/agents";
import { MessageItem } from "./MessageItem";

export function MessageList({ agentName }: { agentName: string }) {
  const messages = useSession(s => s.messages[agentName] ?? []);
  const agent = useAgents(s => s.list.find(a => a.name === agentName));
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);
  return (
    <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3.5">
      {messages.map(m => <MessageItem key={m.id} msg={m} agentAvatar={agent?.avatar ?? "🤖"} agentName={agent?.displayName ?? agentName} agentKey={agentName} />)}
      <div ref={endRef} />
    </div>
  );
}
```

- [ ] **Step 3: Composer（输入框，spec 6.1）**

`packages/frontend/src/components/Composer.tsx`:
```tsx
import { useState } from "react";

export function Composer({ agentName, agentAvatar, onSend }: { agentName: string; agentAvatar: string; onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  const send = () => { if (text.trim()) { onSend(text); setText(""); } };
  return (
    <div className="border-t border-surface p-3 bg-mantle">
      <div className="bg-surface border border-surface2 rounded-lg p-[10px_14px] flex items-center gap-2">
        <span className="text-blue text-[13px]">{agentAvatar}</span>
        <input
          className="bg-transparent border-none text-text flex-1 text-[12px] outline-none"
          placeholder={`给${agentName}发消息...`}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
        />
        <button onClick={send} className="bg-blue text-base px-2.5 py-[3px] rounded text-[10px] font-semibold">↩</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: SessionView（左右布局 + WS 接线 + 乐观显示用户消息）**

`packages/frontend/src/components/SessionView.tsx`（替换占位）:
```tsx
import { useEffect } from "react";
import { useSession } from "../store/session";
import { useAgents } from "../store/agents";
import { wsClient } from "../ws-instance";
import { avatarStyle } from "../theme/agents";
import { Sidebar } from "./Sidebar";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";

export function SessionView() {
  const currentAgent = useSession(s => s.currentAgent)!;
  const agent = useAgents(s => s.list.find(a => a.name === currentAgent));
  const addMessage = useSession(s => s.addMessage);
  const updateState = useAgents(s => s.updateState);

  useEffect(() => {
    const off = wsClient.onEvent(e => {
      if (e.type === "agent:message" && e.agentName === currentAgent) addMessage(e.agentName, e.message);
      if (e.type === "agent:state" && e.agentName === currentAgent) updateState(e.agentName, e.state);
    });
    return off;
  }, [currentAgent, addMessage, updateState]);

  const sendPrompt = (text: string) => {
    addMessage(currentAgent, { id: `u${Date.now()}`, role: "user", text, timestamp: Date.now() });
    wsClient.send({ type: "agent:prompt", agentName: currentAgent, message: text });
  };

  return (
    <div className="h-screen flex">
      <Sidebar />
      <div className="flex-1 flex flex-col">
        {/* 会话 header */}
        <div className="bg-mantle px-4 py-2.5 border-b border-surface flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center text-[14px]"
                 style={avatarStyle(currentAgent, 28)}>{agent?.avatar}</div>
            <div>
              <div className="font-semibold text-[12px] text-text">{agent?.displayName} 会话</div>
              <div className="text-[9px] text-overlay">{agent?.model} · {agent?.thinking}</div>
            </div>
          </div>
          <button className="bg-surface px-2.5 py-[3px] rounded text-[10px] text-overlay cursor-pointer">编排画布</button>
        </div>
        <MessageList agentName={currentAgent} />
        <Composer agentName={agent?.displayName ?? currentAgent} agentAvatar={agent?.avatar ?? "🤖"} onSend={sendPrompt} />
      </div>
    </div>
  );
}
```

- [ ] **Step 5: 验证会话视图**

Run: kernel + frontend，选角色 → 发消息 → 看 DeepSeek 流式回复
Expected: 用户消息（灰气泡 `4 12 12 12`）+ DeepSeek 回复（深气泡 `12 4 12 12`）

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/components/Sidebar.tsx packages/frontend/src/components/MessageItem.tsx packages/frontend/src/components/MessageList.tsx packages/frontend/src/components/Composer.tsx packages/frontend/src/components/SessionView.tsx
git commit -m "feat(frontend): session view (sidebar + message list with directional bubbles, spec 6.1)"
```

---

## Task 12: 委派卡片 + 干预按钮 + Intercom 状态条（spec 6.5）

**Files:**
- Create: `packages/frontend/src/store/intercom.ts`, `packages/frontend/src/components/AskCard.tsx`
- Modify: `packages/frontend/src/components/Sidebar.tsx`（IntercomStatusBar 接真实数据）, `packages/frontend/src/components/SessionView.tsx`（接 intercom 事件）, `packages/frontend/src/components/MessageList.tsx`（渲染 AskCard）

**Interfaces:**
- Consumes: kernel `intercom:ask`/`intercom:reply` events
- Produces: 对话流里 ask 卡片（橙色，三按钮：🙋我来回答/⚡催一下/查看队列），底部状态条实时显示 ask

spec 6.5：委派卡片 `rgba(250,179,135,0.1)` 背景 + `1px solid rgba(250,179,135,0.3)` 边框。三按钮精确文案。MVP 实现"🙋 我来回答"（inject-reply），其余标注暂不实现。

- [ ] **Step 1: intercom store**

`packages/frontend/src/store/intercom.ts`:
```typescript
import { create } from "zustand";

export interface AskItem {
  messageId: string; from: string; to: string; text: string; startedAt: number; resolved: boolean;
}
interface IntercomStore {
  asks: AskItem[];
  addAsk: (a: AskItem) => void;
  resolveAsk: (id: string) => void;
}
export const useIntercom = create<IntercomStore>((set) => ({
  asks: [],
  addAsk: (ask) => set((s) => ({ asks: [...s.asks.filter(a => a.messageId !== ask.messageId), ask] })),
  resolveAsk: (messageId) => set((s) => ({ asks: s.asks.map(a => a.messageId === messageId ? { ...a, resolved: true } : a) })),
}));
```

- [ ] **Step 2: AskCard（委派卡片 + 三按钮，spec 6.5 + 03 原型）**

`packages/frontend/src/components/AskCard.tsx`:
```tsx
import { useState, useEffect } from "react";
import type { AskItem } from "../store/intercom";
import { wsClient } from "../ws-instance";

export function AskCard({ ask }: { ask: AskItem }) {
  const [answering, setAnswering] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [elapsed, setElapsed] = useState(Math.floor((Date.now() - ask.startedAt) / 1000));

  useEffect(() => {
    if (ask.resolved) return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - ask.startedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [ask.resolved, ask.startedAt]);

  const submitReply = () => {
    if (!replyText.trim()) return;
    wsClient.send({ type: "intercom:inject-reply", messageId: ask.messageId, agentName: ask.to, toAskFrom: ask.from, text: replyText });
    setAnswering(false); setReplyText("");
  };

  return (
    <div className="flex gap-2.5 items-start my-1">
      <div className="w-7" />
      <div className="flex-1 max-w-[80%] rounded-lg p-[10px_14px]"
           style={{ background: "rgba(250,179,135,0.1)", border: "1px solid rgba(250,179,135,0.3)" }}>
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-peach text-[10px] font-semibold">↗ 委派给{ask.to}</span>
          {!ask.resolved
            ? <span className="text-peach text-[9px] px-[7px] py-px rounded-lg" style={{ background: "rgba(250,179,135,0.2)" }}>ask · 阻塞中 {elapsed}s</span>
            : <span className="text-green text-[9px]">✓ 已回复</span>}
        </div>
        <div className="text-text text-[12px] leading-relaxed">"{ask.text}"</div>
        {!ask.resolved && !answering && (
          <div className="flex gap-1.5 mt-2">
            <button onClick={() => setAnswering(true)} className="bg-surface px-2 py-0.5 rounded text-[9px] text-green cursor-pointer">🙋 我来回答</button>
            <button disabled className="bg-surface px-2 py-0.5 rounded text-[9px] text-subtext cursor-pointer opacity-50" title="MVP 暂未实现">⚡ 催一下</button>
            <button disabled className="px-2 py-0.5 rounded text-[9px] text-overlay cursor-pointer opacity-50" title="MVP 暂未实现">查看队列</button>
          </div>
        )}
        {answering && (
          <div className="mt-2 flex gap-2">
            <input autoFocus className="flex-1 bg-surface border border-surface2 rounded px-2 py-1 text-[12px] text-text outline-none"
              placeholder="输入你的回答..." value={replyText}
              onChange={e => setReplyText(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") submitReply(); }} />
            <button onClick={submitReply} className="bg-blue text-base px-3 py-1 rounded text-[11px]">发送</button>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: MessageList 渲染 AskCard + Sidebar 状态条接真实数据**

`packages/frontend/src/components/MessageList.tsx`（加 AskCard）— 在现有基础上追加 asks 渲染：
```tsx
import { useEffect, useRef } from "react";
import { useSession } from "../store/session";
import { useAgents } from "../store/agents";
import { useIntercom } from "../store/intercom";
import { MessageItem } from "./MessageItem";
import { AskCard } from "./AskCard";

export function MessageList({ agentName }: { agentName: string }) {
  const messages = useSession(s => s.messages[agentName] ?? []);
  const agent = useAgents(s => s.list.find(a => a.name === agentName));
  const asks = useIntercom(s => s.asks.filter(a => a.from === agentName || a.to === agentName));
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, asks]);
  return (
    <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3.5">
      {messages.map(m => <MessageItem key={m.id} msg={m} agentAvatar={agent?.avatar ?? "🤖"} agentName={agent?.displayName ?? agentName} agentKey={agentName} />)}
      {asks.map(a => <AskCard key={a.messageId} ask={a} />)}
      <div ref={endRef} />
    </div>
  );
}
```

Sidebar 的 `IntercomStatusBar` 改为接真实数据（替换 Task 11 占位）：
```tsx
import { useIntercom } from "../store/intercom";
function IntercomStatusBar() {
  const unresolved = useIntercom(s => s.asks.filter(a => !a.resolved));
  if (unresolved.length === 0) return null;
  return (
    <div className="p-2 px-2.5 border-t border-surface flex gap-4 overflow-x-auto" style={{ background: "rgba(250,179,135,0.06)" }}>
      {unresolved.map(a => (
        <span key={a.messageId} className="text-[9px] text-peach whitespace-nowrap">
          ● {a.from}→{a.to}: {a.text.slice(0, 20)}...
        </span>
      ))}
    </div>
  );
}
```

SessionView 接 intercom 事件（在 useEffect 内追加）：
```tsx
import { useIntercom } from "../store/intercom";
// 在 SessionView 的 onEvent 回调里追加：
const addAsk = useIntercom(s => s.addAsk);
const resolveAsk = useIntercom(s => s.resolveAsk);
// onEvent 内：
if (e.type === "intercom:ask") addAsk({ messageId: e.messageId, from: e.from, to: e.to, text: e.text, startedAt: e.startedAt, resolved: false });
if (e.type === "intercom:reply") resolveAsk(e.toAskMessageId);
```

- [ ] **Step 4: 验证 ask 显示**

Run: 启动，让产品 agent 调 intercom ask 研发（需 agent 配置 partners），观察橙色 ask 卡片 + 计时器 + 三按钮
Expected: 对话流出现橙色 ask 卡片，点击"🙋 我来回答"输入回复后变绿"✓ 已回复"

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/store/intercom.ts packages/frontend/src/components/AskCard.tsx packages/frontend/src/components/MessageList.tsx packages/frontend/src/components/Sidebar.tsx packages/frontend/src/components/SessionView.tsx
git commit -m "feat(frontend): inline ask cards with intervention buttons + intercom status bar (spec 6.5)"
```

---

## Task 13: 编排画布 —— React Flow（spec 6.3）

**Files:**
- Create: `packages/frontend/src/components/Canvas.tsx`, `packages/frontend/src/components/CanvasNode.tsx`
- Modify: `packages/frontend/src/components/SessionView.tsx`（加画布切换按钮）

**Interfaces:**
- Consumes: `useAgents`（agents + states + partners）, `useIntercom`（活跃 ask）
- Produces: 4 节点（圆角矩形）+ 连线（灰色虚线=partners，橙色动画=活跃 ask）+ 实时状态色

spec 6.3：节点圆角矩形（非圆形），`border-radius:10px`。状态色 thinking 蓝/blocked 橙+pulse/idle 灰。活跃 ask 连线橙色虚线动画。02 原型为参考。

- [ ] **Step 1: CanvasNode（节点组件，spec 6.3）**

`packages/frontend/src/components/CanvasNode.tsx`:
```tsx
import { Handle, Position } from "reactflow";
import type { AgentConfig, AgentState } from "hiagent-shared";

export function CanvasNode({ data }: { data: { agent: AgentConfig; state?: AgentState } }) {
  const { agent, state } = data;
  const status = state?.status ?? "idle";
  const borderColor = status === "thinking" ? "#89b4fa" : status === "blocked" ? "#fab387" : "#6c7086";
  return (
    <div className="relative">
      <Handle type="target" position={Position.Top} />
      <div className="bg-base rounded-[10px] border-2 p-[10px_14px] min-w-[90px] text-center"
           style={{ borderColor, boxShadow: status === "thinking" ? "0 0 20px rgba(137,180,250,0.3)" : status === "blocked" ? "0 0 15px rgba(250,179,135,0.4)" : "none" }}
           data-pulse={status === "blocked" ? "true" : undefined}>
        <div className="text-[22px]">{agent.avatar}</div>
        <div className="font-semibold text-[12px] mt-0.5" style={{ color: borderColor }}>{agent.displayName}</div>
        <div className="text-[9px] mt-0.5" style={{ color: borderColor }}>
          {status === "thinking" ? "● thinking" : status === "blocked" ? "⏸ 等待回复" : "○ idle"}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
```

在 `styles.css` 追加 blocked 节点的 pulse（复用 Task 9 定义的 keyframe，给 data-pulse 属性加动画）：
```css
[data-pulse="true"] { animation: hiagent-pulse 1.5s infinite; }
```

- [ ] **Step 2: Canvas（节点环形布局 + 连线，spec 6.3）**

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
    const n = list.length || 1;
    return list.map((agent, i) => {
      const angle = (i / n) * 2 * Math.PI;
      return {
        id: agent.name, type: "agent",
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
          id: `${agent.name}-${to}`, source: agent.name, target: to, animated: isActive,
          style: { stroke: isActive ? "#fab387" : "#6c7086", strokeWidth: isActive ? 2.5 : 2, strokeDasharray: isActive ? "6 4" : "4 3" },
        });
      }
    }
    return result;
  }, [list, asks]);

  return (
    <div className="h-screen w-full">
      {/* 画布 toolbar（spec 6.3） */}
      <div className="bg-mantle px-2.5 py-1.5 border-b border-surface flex items-center gap-2">
        <span className="font-semibold text-blue text-[12px]">编排画布</span>
        <span className="text-overlay text-[11px]">│ 拖拽添加 agent · 连线表示可通信</span>
      </div>
      <div className="h-[calc(100vh-40px)]">
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView>
          <Background color="#313244" gap={20} />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: SessionView 加画布切换**

`packages/frontend/src/components/SessionView.tsx` 修改：
```tsx
import { useState } from "react";
import { Canvas } from "./Canvas";
// ...在组件内：
const [showCanvas, setShowCanvas] = useState(false);
// header 的"编排画布"按钮改为切换：
<button onClick={() => setShowCanvas(!showCanvas)} className="bg-surface px-2.5 py-[3px] rounded text-[10px] text-overlay cursor-pointer">
  {showCanvas ? "对话" : "编排画布"}
</button>
// 在 return 内条件渲染：
if (showCanvas) return <Canvas />;
// 否则渲染原会话布局
```

- [ ] **Step 4: 验证画布**

Run: 进入会话，点"编排画布"
Expected: 4 圆角矩形节点环形排列，灰色虚线连线（来自 partners），thinking 节点蓝边框+发光，blocked 橙边框+pulse

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/components/Canvas.tsx packages/frontend/src/components/CanvasNode.tsx packages/frontend/src/components/SessionView.tsx packages/frontend/src/styles.css
git commit -m "feat(frontend): orchestration canvas with React Flow (spec 6.3)"
```

---

## Task 14: Agent 配置弹窗（spec 6.6）

**Files:**
- Create: `packages/frontend/src/components/AgentConfig.tsx`, `packages/frontend/src/components/PartnerPanel.tsx`
- Modify: `packages/frontend/src/components/Sidebar.tsx`（双击角色打开配置）

**Interfaces:**
- Consumes: `useAgents`（agent 列表）
- Produces: 弹窗显示基本信息 + 系统提示词 + 工具 chips + 合作伙伴面板（出向/入向）

spec 6.6：左右布局 `1fr 320px`。左表单（头像/名称/描述/模型/提示词/工具 chips/技能），右合作伙伴（出向橙/入向绿 + 迷你图 + 统计）。04b/07b 原型。MVP 保存仅本地内存（持久化留扩展点）。

- [ ] **Step 1: PartnerPanel（合作伙伴面板，spec 6.6 右栏）**

`packages/frontend/src/components/PartnerPanel.tsx`:
```tsx
import type { AgentConfig } from "hiagent-shared";
import { useAgents } from "../store/agents";
import { avatarStyle } from "../theme/agents";

export function PartnerPanel({ config }: { config: AgentConfig }) {
  const allAgents = useAgents(s => s.list);
  const outbound = allAgents.filter(a => config.partners.askTo.includes(a.name));
  const inbound = allAgents.filter(a => config.partners.askFrom.includes(a.name));

  const PartnerRow = ({ a, label }: { a: AgentConfig; label: string }) => (
    <div className="bg-surface rounded-lg p-2.5 flex items-center gap-2.5">
      <div style={avatarStyle(a.name, 36)}>{a.avatar}</div>
      <div className="flex-1">
        <div className="font-semibold text-[12px] text-text">{a.displayName}</div>
        <div className="text-[10px] text-overlay">{label}</div>
      </div>
      <span className="text-green text-[16px] cursor-pointer">✓</span>
    </div>
  );

  return (
    <div className="bg-mantle p-4 overflow-y-auto">
      <div className="text-blue text-[12px] font-semibold mb-1">🤝 合作伙伴</div>
      <div className="text-overlay text-[10px] mb-4">定义{config.displayName}可向谁发起 ask，以及谁能 ask {config.displayName}</div>

      <div className="text-peach text-[11px] font-semibold mb-2">↗ 可发起 ask 给（出向）</div>
      <div className="flex flex-col gap-2 mb-4">
        {outbound.map(a => <PartnerRow key={a.name} a={a} label={a.description} />)}
        <div className="border border-dashed border-surface2 rounded-lg p-2.5 flex items-center gap-2.5 opacity-60 cursor-pointer">
          <div className="w-9 h-9 rounded-full bg-surface flex items-center justify-center text-overlay">＋</div>
          <div className="text-[11px] text-overlay">添加伙伴...</div>
        </div>
      </div>

      <div className="text-green text-[11px] font-semibold mb-2">↙ 可被 ask 自（入向）</div>
      <div className="flex flex-col gap-2">
        {inbound.map(a => <PartnerRow key={a.name} a={a} label={a.description} />)}
      </div>

      <div className="grid grid-cols-2 gap-2 mt-3.5 text-[10px]">
        <div className="bg-surface p-2 rounded-md text-center">
          <div className="text-peach font-bold text-[16px]">{outbound.length}</div>
          <div className="text-overlay">出向伙伴</div>
        </div>
        <div className="bg-surface p-2 rounded-md text-center">
          <div className="text-green font-bold text-[16px]">{inbound.length}</div>
          <div className="text-overlay">入向伙伴</div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: AgentConfig（弹窗，左表单 + 右合作伙伴，spec 6.6）**

`packages/frontend/src/components/AgentConfig.tsx`:
```tsx
import { useState } from "react";
import type { AgentConfig } from "hiagent-shared";
import { avatarStyle } from "../theme/agents";
import { PartnerPanel } from "./PartnerPanel";

export function AgentConfig({ agent, onClose }: { agent: AgentConfig; onClose: () => void }) {
  const [form, setForm] = useState(agent);
  const [tab, setTab] = useState<"basic" | "prompt" | "tools" | "partners">("basic");

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
      <div className="bg-base rounded-xl w-[720px] max-h-[85vh] overflow-hidden flex flex-col">
        {/* Header（spec 6.6） */}
        <div className="bg-mantle px-4 py-3 border-b border-surface flex items-center justify-between">
          <div className="flex items-center gap-3.5">
            <div className="rounded-full flex items-center justify-center text-[26px] border-2 border-text relative"
                 style={{ ...avatarStyle(form.name, 52) }}>
              {form.avatar}
            </div>
            <div>
              <div className="font-semibold text-[15px] text-text">{form.displayName} Agent</div>
              <div className="text-[10px] text-overlay">~/.pi/agent/agents/{form.name}.md · FIFO 串行</div>
            </div>
          </div>
          <div className="flex gap-1.5">
            <button onClick={onClose} className="border border-surface2 text-subtext px-3 py-1.5 rounded text-[11px]">查看原始 .md</button>
            <button onClick={onClose} className="bg-blue text-base px-3 py-1.5 rounded text-[11px] font-semibold">保存</button>
          </div>
        </div>
        {/* Tabs */}
        <div className="bg-mantle flex border-b border-surface text-[11px]">
          {([["basic","基本信息"], ["prompt","系统提示词"], ["tools","工具"], ["partners","合作伙伴"]] as const).map(([k, label]) => (
            <div key={k} onClick={() => setTab(k)} className="px-4 py-2 cursor-pointer"
                 style={tab === k ? { color: "#89b4fa", borderBottom: "2px solid #89b4fa", fontWeight: 600 } : { color: "#6c7086" }}>
              {label}
            </div>
          ))}
        </div>
        {/* 左右布局 */}
        <div className="flex-1 overflow-hidden grid" style={{ gridTemplateColumns: tab === "partners" ? "1fr 320px" : "1fr" }}>
          <div className="p-4 overflow-y-auto border-r border-surface">
            {tab === "basic" && (
              <div className="space-y-3.5 text-sm">
                <div className="grid grid-cols-2 gap-3.5">
                  <Field label="名称 (name)" value={form.name} onChange={v => setForm({ ...form, name: v })} />
                  <Field label="显示名" value={form.displayName} onChange={v => setForm({ ...form, displayName: v })} />
                </div>
                <Field label="描述（决定何时被委派）" value={form.description} onChange={v => setForm({ ...form, description: v })} />
                <div className="grid grid-cols-2 gap-3.5">
                  <Field label="模型" value={form.model} onChange={v => setForm({ ...form, model: v })} />
                  <Field label="thinking level" value={form.thinking} onChange={v => setForm({ ...form, thinking: v as any })} />
                </div>
              </div>
            )}
            {tab === "prompt" && (
              <div>
                <div className="text-overlay text-[10px] mb-1.5">系统提示词</div>
                <textarea className="w-full bg-mantle border border-surface rounded-md p-2.5 text-[11px] text-subtext font-mono h-64 outline-none"
                  value={form.systemPrompt ?? ""} onChange={e => setForm({ ...form, systemPrompt: e.target.value })} />
              </div>
            )}
            {tab === "tools" && (
              <div>
                <div className="text-overlay text-[10px] mb-2">工具（已启用 {form.tools.length} 个）</div>
                <div className="flex flex-wrap gap-1.5">
                  {form.tools.map(t => (
                    <span key={t} className="rounded-xl px-2.5 py-1 text-[11px] cursor-pointer"
                      style={{ background: "rgba(166,227,161,0.15)", border: "1px solid #a6e3a1", color: "#a6e3a1" }}>✓ {t}</span>
                  ))}
                  <span className="rounded-xl px-2.5 py-1 text-[11px]"
                    style={{ background: "rgba(137,180,250,0.15)", border: "1px solid #89b4fa", color: "#89b4fa" }}>✓ intercom</span>
                </div>
                <div className="text-overlay text-[10px] mt-4 italic">MVP：工具编辑需 kernel 加 agent:save-config 命令（后续迭代）</div>
              </div>
            )}
            {tab === "partners" && <div className="text-overlay text-[11px] p-4">合作伙伴配置见右侧面板 →</div>}
          </div>
          {tab === "partners" && <PartnerPanel config={form} />}
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <div className="text-overlay text-[10px] mb-1">{label}</div>
      <input className="w-full bg-surface border border-surface2 text-text px-2.5 py-1.5 rounded text-[12px] outline-none"
        value={value} onChange={e => onChange(e.target.value)} />
    </div>
  );
}
```

- [ ] **Step 3: Sidebar 双击打开配置**

`packages/frontend/src/components/Sidebar.tsx` 修改：
```tsx
import { useState } from "react";
import { AgentConfig as AgentConfigModal } from "./AgentConfig";
import type { AgentConfig } from "hiagent-shared";
// 在 Sidebar 组件内：
const [editing, setEditing] = useState<AgentConfig | null>(null);
// 在角色 div 上加 onDoubleClick={() => setEditing(a)}
// 在 Sidebar return 末尾：
{editing && <AgentConfigModal agent={editing} onClose={() => setEditing(null)} />}
```

- [ ] **Step 4: 验证配置弹窗**

Run: 双击 sidebar 角色，弹窗显示
Expected: 4 tab 可切换，基本信息可编辑，合作伙伴面板显示出向/入向 + 统计

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/components/AgentConfig.tsx packages/frontend/src/components/PartnerPanel.tsx packages/frontend/src/components/Sidebar.tsx
git commit -m "feat(frontend): agent config modal with tabs + partner panel (spec 6.6)"
```

---

## Task 15: Tauri 外壳 + Bun sidecar 生命周期

**Files:**
- Create: `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/build.rs`, `src-tauri/src/main.rs`

**Interfaces:**
- Consumes: bun 二进制（PATH），kernel `packages/kernel/src/index.ts`
- Produces: `cargo tauri dev` 启动 Tauri 窗口 + 自动 spawn Bun sidecar + 加载前端

spec 8.3：Tauri 只管窗口 + Bun sidecar 生命周期。MVP 用裸 `std::process::Command`。

- [ ] **Step 1: Cargo.toml + build.rs**

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

[features]
custom-protocol = ["tauri/custom-protocol"]
```

`src-tauri/build.rs`:
```rust
fn main() { tauri_build::build() }
```

- [ ] **Step 2: tauri.conf.json**

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
    "windows": [{ "title": "HiAgent", "width": 1280, "height": 800, "resizable": true }],
    "security": { "csp": null }
  },
  "bundle": { "active": true, "targets": "all", "icon": ["icons/icon.png"] }
}
```

- [ ] **Step 3: main.rs（窗口 + Bun sidecar 生命周期，spec 8.3）**

`src-tauri/src/main.rs`:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

struct SidecarState(Mutex<Option<Child>>);

fn spawn_bun_sidecar() -> std::io::Result<Child> {
    Command::new("bun")
        .arg("run")
        .arg("packages/kernel/src/index.ts")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
}

fn main() {
    tauri::Builder::default()
        .manage(SidecarState(Mutex::new(None)))
        .setup(|app| {
            match spawn_bun_sidecar() {
                Ok(child) => {
                    let state: tauri::State<SidecarState> = app.state();
                    *state.0.lock().unwrap() = Some(child);
                    println!("[HiAgent] Bun sidecar started");
                }
                Err(e) => eprintln!("[HiAgent] Failed to start Bun sidecar: {}", e),
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let state: tauri::State<SidecarState> = window.app_handle().state();
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

- [ ] **Step 4: 加图标占位 + 验证编译**

```bash
mkdir -p src-tauri/icons
# 放一个 icon.png 占位（或用 tauri 默认）
cargo build --manifest-path src-tauri/Cargo.toml
```
Expected: Rust 编译通过（首次下载 tauri 依赖较慢）

- [ ] **Step 5: Commit**

```bash
git add src-tauri/
git commit -m "feat(tauri): native shell + bun sidecar lifecycle (spec 8.3)"
```

---

## Task 16: 端到端联调 + 默认 agent 配置

**Files:**
- Create: `scripts/dev.sh`, `~/.pi/agent/agents/` 下 4 个默认 agent（产品/PM/研发/测试）, `README.md`

**Interfaces:**
- Consumes: Task 1-15 全部
- Produces: `./scripts/dev.sh` 启动完整应用，4 agent 互 ask

- [ ] **Step 1: 创建 4 个默认 agent 配置（spec 6.0 四角色）**

`~/.pi/agent/agents/product.md`:
```yaml
---
name: product
displayName: 产品
avatar: "📋"
description: 需求设计
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
avatar: "📅"
description: 项目管理
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
description: 技术实现
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
description: 质量验收
model: deepseek/deepseek-v4-flash
thinking: medium
tools: read, bash
partners:
  askTo: [dev]
  askFrom: [dev]
---
你是一名测试工程师。收到 ask 时用 intercom 工具回复。
```

- [ ] **Step 2: 一键启动脚本**

`scripts/dev.sh`:
```bash
#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."
echo "=== 启动 Bun 编排内核（后台）==="
bun run packages/kernel/src/index.ts &
KERNEL_PID=$!
trap "kill $KERNEL_PID 2>/dev/null" EXIT
sleep 2
echo "=== 启动 Tauri（前端 + 窗口）==="
cargo tauri dev
```
```bash
chmod +x scripts/dev.sh
```

- [ ] **Step 3: 端到端验证清单**

需 `DEEPSEEK_API_KEY` 环境变量：

1. **启动**：`./scripts/dev.sh` → Tauri 窗口出现，启动页 4 角色卡片（📋📅⚙️🧪 渐变色）
2. **单角色对话**：选"产品" → 发"设计登录功能" → DeepSeek 流式回复（assistant 气泡 `12 4 12 12`）
3. **委派（ask）**：让产品 ask 研发 → 对话流出现橙色 ask 卡片 + 实时计时 → 切研发会话看自动回复 → 产品卡片变绿
4. **用户替答**：ask 卡片点"🙋 我来回答" → 输入 → ask 解除
5. **画布**：点"编排画布" → 4 节点环形 + 灰虚线（partners），ask 时对应连线变橙动画
6. **配置**：双击 sidebar 角色 → 弹窗 4 tab，合作伙伴显示出向/入向
7. **关闭**：关窗口 → Bun sidecar 退出（`ps aux | grep index.ts` 确认）

- [ ] **Step 4: README**

`README.md`:
```markdown
# HiAgent

基于 Pi Coding Agent 的本地多 agent 编排管理桌面客户端。

## 开发

```bash
# 1. pi 在 PATH（pi --version → 0.80.x）
# 2. DEEPSEEK_API_KEY 已设
# 3. pi-intercom 已装（pi install npm:pi-intercom）
./scripts/dev.sh
```

详见 `docs/superpowers/specs/2026-07-05-hiagent-design.md`。
```

- [ ] **Step 5: Commit**

```bash
git add scripts/ README.md
git commit -m "chore: dev script + default 4 agent configs + README"
```

---

## Self-Review 检查

**1. Spec 覆盖**（spec 11.1 MVP 八项）：
- ✅ 启动页（4 角色卡片，spec 6.1）→ Task 10
- ✅ 会话视图（Codex 式左右，气泡圆角方向，spec 6.1）→ Task 11
- ✅ Pi 集成（spawn pi --mode rpc，prompt/abort）→ Task 4
- ✅ pi-intercom 集成（ask/reply 跟踪）→ Task 6+7
- ✅ 委派内联显示（ask 卡片 + 三按钮干预，spec 6.5）→ Task 12
- ✅ Agent 配置（基本信息/提示词/工具/合作伙伴，spec 6.6）→ Task 14
- ✅ 编排画布（节点+连线+实时状态，spec 6.3）→ Task 13
- ✅ 无超时 ask（v0.6.0 天然支持）→ Task 6 实现说明

**2. 设计系统一致性**（spec 6.0）：
- ✅ Tailwind v4 @theme 定义全部 16 个 Catppuccin 色（Task 9 styles.css）
- ✅ `theme/agents.ts` 集中四角色渐变（Task 9），组件引用不散落 hex
- ✅ 气泡圆角方向（用户 `4 12 12 12` / assistant `12 4 12 12`，Task 11 MessageItem）
- ✅ 状态色（thinking 蓝/blocked 橙+pulse/idle 灰，Task 13 CanvasNode + styles.css）
- ✅ 委派卡片精确配色（rgba(250,179,135,0.1) + 三按钮文案，Task 12 AskCard）

**3. 接口契约一致性**：
- `AgentConfig`/`WSEvent`/`RPCEvent` 在 shared/types.ts（Task 1）定义，后续全引用 ✓
- `PiRpcClient.start/prompt/getState` (Task 4) → AgentManager (Task 5) / index (Task 8) 一致 ✓
- `ConfigStore.listAgents/getAgent/saveAgent` (Task 3) → AgentManager (Task 5) 一致 ✓
- `IntercomMonitor.connect/injectReply` (Task 6) → StateAggregator (Task 7) / index (Task 8) 一致 ✓
- WSEvent 字段（agent:message/intercom:ask/intercom:reply）内核发出 (Task 7) ↔ 前端 store 消费 (Task 10/12) 一致 ✓

**4. 已知简化/后续扩展点**（非缺陷）：
- AgentConfig 保存仅本地内存（Task 14），持久化需 kernel 加 `agent:save-config`
- "⚡催一下"/"查看队列" MVP 禁用（Task 12 标注）
- 会话历史 sidebar 占位（Task 11）
- Tauri sidecar 用裸 Command，生产需打包 bun 二进制
