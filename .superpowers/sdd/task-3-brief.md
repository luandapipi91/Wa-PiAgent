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

