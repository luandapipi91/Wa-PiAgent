# 多智能体矩阵（Agent Matrix）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 4 个硬编码 agent 重写为可增删改查的多智能体矩阵：侧边栏智能体管理区、宫格弹窗、4-tab 详情弹窗、对话中切换智能体、@/#/$ 提及符号、delegate 委托调起与委托卡片。

**Architecture:** spec 见 `docs/superpowers/specs/2026-07-17-agent-matrix-design.md`。agent 配置为 Markdown+frontmatter（`~/.wa-pi/agents/<名称>.md`），名称即标识；kernel 经 WS 提供 CRUD；调起走宿主 `delegate` customTool（allowlist 强制）→ `@gotgenes/pi-subagents` service API。

**UI 原型（必须对照实现，布局/配色/文案不允许大偏差）：**
| 界面 | 原型文件（用浏览器打开对照） |
|---|---|
| 侧边栏智能体区（A 紧凑行） | `docs/superpowers/specs/2026-07-17-agent-matrix-mockups/sidebar-agents.html` |
| 全部智能体宫格弹窗 | `docs/superpowers/specs/2026-07-17-agent-matrix-mockups/agent-gallery.html` |
| 详情弹窗 4 tab | `docs/superpowers/specs/2026-07-17-agent-matrix-mockups/agent-detail-tabs-v4.html` |
| 顶部切换器带搜索 | `docs/superpowers/specs/2026-07-17-agent-matrix-mockups/agent-switcher-search.html` |
| @/#/$ 提及符号 | `docs/superpowers/specs/2026-07-17-agent-matrix-mockups/mention-symbols.html` |
| 委托卡片三态 | `docs/superpowers/specs/2026-07-17-agent-matrix-mockups/delegate-card-flow.html` |

**Tech Stack:** Bun + bun:test（kernel/shared）、React + Vitest + @testing-library/react（frontend）、Playwright（e2e）、zustand、`@gotgenes/pi-subagents`

## Global Constraints

- 所有回复/注释用中文；commit 信息沿用仓库风格（中文，conventional 前缀如 `feat:`/`fix:`/`docs:`）
- 测试命令：kernel/shared 在对应包目录 `bun test`；frontend `bunx vitest run`（或 `npx vitest run`）；typecheck `bun run typecheck`（kernel）
- 思考档位只有四档：`disabled/medium/high/max`（UI 文案：思考 off/mid/high/max），**不存在 low**；存量 md 的 `thinking: low` 读取时归一为 `medium`
- agent 名称即文件名：禁止字符 `/\\:*?"<>|`；重名自动加 `-2`/`-3` 后缀
- 删除智能体不触碰会话数据；切换智能体必须复用同一 `piSessionFile` 重建
- 每完成一个 Task 必须跑该层测试通过再 commit；不提交无关文件
- UI 实现对照原型文件，组件用项目现有 Tailwind 类名体系（`bg-surface`/`text-secondary`/`border-hairline` 等），不要引入新依赖

---

### Task 1: shared 类型扩展

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/constants.ts`
- Test: `packages/shared/tests/types.test.ts`

**Interfaces:**
- Produces（后续所有任务依赖）:
  - `type AgentName = string`
  - `AgentConfig.triggerKeywords: string[]`、`AgentConfig.thinking: ThinkingLevel`
  - `agentDefOf(name: string): AgentDef`（AGENT_DEFS 查找 + 缺省回退）
  - WS 事件：`AgentListRequest/AgentListResult`、`AgentCreateEvent/AgentCreatedEvent`、`AgentDeleteEvent/AgentDeletedEvent`、`AgentToolsListRequest/AgentToolsListResult`、`SessionSetAgentEvent`、`SessionUpdatedEvent`

- [ ] **Step 1: 写失败测试**

`packages/shared/tests/types.test.ts` 追加：

```ts
import { agentDefOf } from "../src/constants";

test("AgentConfig 支持 triggerKeywords 与 ThinkingLevel", () => {
  const c: import("../src/types").AgentConfig = {
    name: "代码审查", displayName: "代码审查", avatar: "🔍", avatarColor: "#06b6d4-#3b82f6",
    description: "评审改动", model: "m", thinking: "max",
    systemPromptMode: "replace", inheritProjectContext: true, inheritSkills: true,
    tools: [], skills: [], mcpServers: [], partners: { askTo: [], askFrom: [] },
    triggerKeywords: ["review", "评审"],
  };
  expect(c.triggerKeywords).toEqual(["review", "评审"]);
  expect(c.thinking).toBe("max");
});

test("agentDefOf: 内置名返回定义，未知名回退默认", () => {
  expect(agentDefOf("dev").emoji).toBe("⚙️");
  const fb = agentDefOf("不存在的智能体");
  expect(fb.emoji).toBe("🤖");
  expect(fb.gradient).toEqual(["#4b5563", "#6b7280"]);
  expect(fb.label).toBe("不存在的智能体");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/shared && bun test tests/types.test.ts`
Expected: FAIL（`agentDefOf is not a function` / 类型错误）

- [ ] **Step 3: 实现**

`packages/shared/src/types.ts`：
- L28 改为 `export type AgentName = string;`
- L47 `thinking: "low" | "medium" | "high";` 改为 `thinking: ThinkingLevel;`
- AgentConfig 增加字段（L55 `systemPromptBody?` 前）：`triggerKeywords: string[];  // 触发关键词：其他智能体自动调起本智能体时的判定提示`
- 新增 WS 事件（放在 `AgentConfigSaveEvent` 之后）：

```ts
export interface AgentListRequest { type: "agent:list"; }
export interface AgentCreateEvent { type: "agent:create"; displayName: string; }
export interface AgentDeleteEvent { type: "agent:delete"; name: string; }
export interface AgentToolsListRequest { type: "agent:tools:list"; }
export interface SessionSetAgentEvent { type: "session:set-agent"; sessionId: string; agentName: AgentName; }
```

- `WSClientEvent` 联合（L272 `| AgentConfigGetEvent | AgentConfigSaveEvent` 行）追加：`| AgentListRequest | AgentCreateEvent | AgentDeleteEvent | AgentToolsListRequest | SessionSetAgentEvent`
- 新增 kernel→前端事件（放在 `AgentConfigEvent` 后）：

```ts
export interface AgentListResult { type: "agent:list"; agents: AgentConfig[]; }
export interface AgentCreatedEvent { type: "agent:created"; agent: AgentConfig; }
export interface AgentDeletedEvent { type: "agent:deleted"; name: string; }
export interface AgentToolItem { name: string; source: string; }  // source: "内置" | "扩展" | "MCP"
export interface AgentToolsListResult { type: "agent:tools:list"; tools: AgentToolItem[]; }
export interface SessionUpdatedEvent { type: "session:updated"; sessionId: string; primaryAgent: AgentName; }
```

- `WSServerEvent` 联合（L376 `| AgentConfigEvent | ErrorEvent` 行）追加：`| AgentListResult | AgentCreatedEvent | AgentDeletedEvent | AgentToolsListResult | SessionUpdatedEvent`

`packages/shared/src/constants.ts`：
- L36 `Record<AgentName, AgentDef>` 改为 `Record<string, AgentDef>`；L44 `ALL_AGENT_NAMES` 类型改为 `string[]`
- 文件末尾追加：

```ts
/** 按名取 AgentDef，未知名回退默认（动态智能体没有内置定义） */
export function agentDefOf(name: string): AgentDef {
  return AGENT_DEFS[name] ?? { emoji: "🤖", gradient: ["#4b5563", "#6b7280"], label: name };
}
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `cd packages/shared && bun test`
Expected: PASS（含旧用例；旧用例里 `thinking: "low"` 的构造若有类型报错，把该测试值改为 `"medium"`）

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): AgentName 放开为 string，AgentConfig 增加 triggerKeywords，新增 agent CRUD/切换 WS 事件类型"
```

---

### Task 2: agent-md 校验放开 + 新字段序列化

**Files:**
- Modify: `packages/kernel/src/agent-md.ts`
- Test: `packages/kernel/tests/agent-md.test.ts`（若不存在则 Create）

**Interfaces:**
- Consumes: Task 1 的类型
- Produces: `validateAgentConfig(c): string[]`（不再校验枚举；name 校验非空+非法字符）；`parseAgentMd`/`stringifyAgentMd` 处理 `triggerKeywords`；`makeDefaultAgentConfig(name: string)` 支持任意名

- [ ] **Step 1: 写失败测试**

`packages/kernel/tests/agent-md.test.ts`：

```ts
import { test, expect } from "bun:test";
import { parseAgentMd, stringifyAgentMd, validateAgentConfig, makeDefaultAgentConfig } from "../src/agent-md";
import type { AgentConfig } from "@wa-pi/shared";

const base: AgentConfig = {
  name: "代码审查", displayName: "代码审查", avatar: "🔍", avatarColor: "#06b6d4-#3b82f6",
  description: "评审改动", model: "glm-4.6", thinking: "high",
  systemPromptMode: "replace", inheritProjectContext: true, inheritSkills: true,
  tools: [], skills: [], mcpServers: [], partners: { askTo: ["dev"], askFrom: [] },
  triggerKeywords: ["review", "评审"],
  systemPromptBody: "你是代码审查智能体。",
};

test("validateAgentConfig: 任意非空合法名通过；非法文件名字符拒绝", () => {
  expect(validateAgentConfig(base)).toEqual([]);
  expect(validateAgentConfig({ ...base, name: "" })).toContain("name 不能为空");
  expect(validateAgentConfig({ ...base, name: "a/b" })[0]).toContain("非法 name");
  expect(validateAgentConfig({ ...base, name: "a:b" })[0]).toContain("非法 name");
});

test("triggerKeywords 序列化/解析往返", () => {
  const md = stringifyAgentMd(base);
  expect(md).toContain("triggerKeywords: [review, 评审]");
  const parsed = parseAgentMd(md);
  expect(parsed.triggerKeywords).toEqual(["review", "评审"]);
  expect(parsed.partners.askTo).toEqual(["dev"]);
});

test("thinking: low 读取时归一为 medium", () => {
  const md = stringifyAgentMd(base).replace("thinking: high", "thinking: low");
  expect(parseAgentMd(md).thinking).toBe("medium");
});

test("makeDefaultAgentConfig 支持任意名（无内置定义时用名称本身）", () => {
  const c = makeDefaultAgentConfig("文档写手");
  expect(c.name).toBe("文档写手");
  expect(c.displayName).toBe("文档写手");
  expect(c.avatar).toBe("🤖");
  expect(c.triggerKeywords).toEqual([]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/kernel && bun test tests/agent-md.test.ts`
Expected: FAIL（非法 name / triggerKeywords undefined 等）

- [ ] **Step 3: 实现**（`packages/kernel/src/agent-md.ts`）

- 删除 L3 `VALID_NAMES` 与 import 中的 `AGENT_DEFS`（L119），改为 `import { agentDefOf } from "@wa-pi/shared";`
- `parseAgentMd`：返回对象中 `thinking:` 行改为归一逻辑，并新增 `triggerKeywords`：

```ts
    thinking: (y.thinking === "low" ? "medium" : y.thinking) as AgentConfig["thinking"],
    // ...其余字段不变...
    triggerKeywords: Array.isArray(y.triggerKeywords) ? (y.triggerKeywords as string[]) : [],
```

- `stringifyAgentMd`：L94 `thinking` 行后追加：

```ts
  fm.push(`triggerKeywords: [${c.triggerKeywords.join(", ")}]`);
```

- `validateAgentConfig` 改为：

```ts
const ILLEGAL_NAME_CHARS = /[/\\:*?"<>|]/;

export function validateAgentConfig(c: AgentConfig): string[] {
  const errs: string[] = [];
  if (!c.name || !c.name.trim()) errs.push("name 不能为空");
  else if (ILLEGAL_NAME_CHARS.test(c.name)) errs.push(`非法 name: ${c.name}（含 / \\ : * ? " < > | 字符）`);
  if (!c.displayName) errs.push("displayName 不能为空");
  if (!c.model) errs.push("model 不能为空");
  if (!["disabled", "medium", "high", "max"].includes(c.thinking)) errs.push(`非法 thinking: ${c.thinking}`);
  if (!["replace", "append"].includes(c.systemPromptMode)) errs.push(`非法 systemPromptMode: ${c.systemPromptMode}`);
  return errs;
}
```

- `makeDefaultAgentConfig(name: string)`：`AGENT_DEFS[name]` 三处引用改为 `agentDefOf(name)`，返回对象新增 `triggerKeywords: [],`

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `cd packages/kernel && bun test`
Expected: PASS（`config-store.test.ts` 里 `name: "hacker"` 期待"非法 name"的旧用例现在应通过校验——把该用例期望改为合法，或用 `name: "a/b"` 作为非法样例）

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/agent-md.ts packages/kernel/tests
git commit -m "feat(kernel): agent-md 放开名称枚举、新增 triggerKeywords 序列化、thinking low 归一为 medium"
```

---

### Task 3: ConfigStore CRUD + 默认 seed

**Files:**
- Modify: `packages/kernel/src/config-store.ts`
- Test: `packages/kernel/tests/config-store.test.ts`

**Interfaces:**
- Produces:
  - `createAgent(displayName: string): Promise<AgentConfig>`（非法名抛错；重名自动 `-2`/`-3`）
  - `deleteAgent(name: string): Promise<void>`（不存在抛错 `智能体不存在: xxx`）
  - `renameAgent(oldName: string, config: AgentConfig): Promise<string[]>`（返回校验错误；成功删旧写新）
  - `seedDefaults(): Promise<void>`（目录无任何 .md 时写入 4 个默认 agent）

- [ ] **Step 1: 写失败测试**（追加到 `config-store.test.ts`，用临时目录构造 `new ConfigStore(tmpDir)`，模式参照文件内既有用例）

```ts
test("createAgent: 生成默认配置；重名自动加 -2 后缀；非法名抛错", async () => {
  const dir = await mkTmp();
  const cs = new ConfigStore(dir);
  const a = await cs.createAgent("代码审查");
  expect(a.name).toBe("代码审查");
  expect(a.displayName).toBe("代码审查");
  const b = await cs.createAgent("代码审查");
  expect(b.name).toBe("代码审查-2");
  const c = await cs.createAgent("代码审查");
  expect(c.name).toBe("代码审查-3");
  await expect(cs.createAgent("a/b")).rejects.toThrow("非法 name");
});

test("deleteAgent: 删除文件；不存在抛错", async () => {
  const dir = await mkTmp();
  const cs = new ConfigStore(dir);
  await cs.createAgent("临时");
  await cs.deleteAgent("临时");
  expect(await cs.getAgent("临时")).toBeNull();
  await expect(cs.deleteAgent("临时")).rejects.toThrow("智能体不存在");
});

test("renameAgent: 删旧写新；新名冲突返回错误", async () => {
  const dir = await mkTmp();
  const cs = new ConfigStore(dir);
  await cs.createAgent("旧名");
  await cs.createAgent("已存在");
  const old = (await cs.getAgent("旧名"))!;
  const errs1 = await cs.renameAgent("旧名", { ...old, name: "已存在" });
  expect(errs1.length).toBeGreaterThan(0);
  const errs2 = await cs.renameAgent("旧名", { ...old, name: "新名" });
  expect(errs2).toEqual([]);
  expect(await cs.getAgent("旧名")).toBeNull();
  expect((await cs.getAgent("新名"))!.displayName).toBe("旧名");
});

test("seedDefaults: 空目录写入 4 个默认 agent；非空目录不写", async () => {
  const dir = await mkTmp();
  const cs = new ConfigStore(dir);
  await cs.seedDefaults();
  const names = (await cs.listAgents()).map(a => a.name).sort();
  expect(names).toEqual(["dev", "pm", "product", "test"]);
  await cs.seedDefaults();  // 幂等
  expect((await cs.listAgents()).length).toBe(4);
});
```

（`mkTmp` 若已有等价 helper 就复用；否则 `const mkTmp = async () => await mkdtemp(join(tmpdir(), "agents-"))`，import 自 `node:fs/promises` 与 `node:os`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/kernel && bun test tests/config-store.test.ts`
Expected: FAIL（方法不存在）

- [ ] **Step 3: 实现**（`config-store.ts` 追加方法，import 增加 `unlink` 与 `ALL_AGENT_NAMES`、`makeDefaultAgentConfig`）

```ts
  /** 名称清洗为可用文件名；冲突时追加 -2/-3 后缀 */
  private async uniqueName(base: string): Promise<string> {
    const existing = new Set((await this.listAgents()).map(a => a.name));
    if (!existing.has(base)) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base}-${i}`;
      if (!existing.has(candidate)) return candidate;
    }
  }

  async createAgent(displayName: string): Promise<AgentConfig> {
    const trimmed = displayName.trim();
    if (!trimmed || /[/\\:*?"<>|]/.test(trimmed)) throw new Error(`非法 name: ${displayName}`);
    const name = await this.uniqueName(trimmed);
    const config = makeDefaultAgentConfig(name);
    await this.saveAgent(config);
    return config;
  }

  async deleteAgent(name: string): Promise<void> {
    if (!(await this.getAgent(name))) throw new Error(`智能体不存在: ${name}`);
    await unlink(join(this.agentsDir, `${name}.md`));
  }

  /** 重命名：删旧文件写新文件；返回校验错误（空数组 = 成功） */
  async renameAgent(oldName: string, config: AgentConfig): Promise<string[]> {
    const errs = validateAgentConfig(config);
    if (errs.length > 0) return errs;
    if (config.name !== oldName && await this.getAgent(config.name)) {
      return [`名称已被占用: ${config.name}`];
    }
    if (config.name !== oldName) await unlink(join(this.agentsDir, `${oldName}.md`));
    await this.saveAgent(config);
    return [];
  }

  /** 目录为空时 seed 4 个内置默认 agent（幂等） */
  async seedDefaults(): Promise<void> {
    if ((await this.listAgents()).length > 0) return;
    for (const name of ALL_AGENT_NAMES) await this.saveAgent(makeDefaultAgentConfig(name));
  }
```

`agentsDir` 当前是 constructor private 参数，内部方法直接用 `this.agentsDir` 即可（L8 已有）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/kernel && bun test tests/config-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/config-store.ts packages/kernel/tests/config-store.test.ts
git commit -m "feat(kernel): ConfigStore 新增 createAgent/deleteAgent/renameAgent/seedDefaults"
```

---

### Task 4: WS 协议——agent CRUD + seed 启动

**Files:**
- Modify: `packages/kernel/src/ws-server.ts`（`agent:config:get` case 附近，L419-428）
- Modify: `packages/kernel/src/project-store.ts`
- Test: `packages/kernel/tests/ws-server.test.ts`

**Interfaces:**
- Consumes: Task 1 事件类型、Task 3 ConfigStore 方法
- Produces:
  - `ProjectStore.setSessionAgent(id: string, agentName: string): Promise<void>`
  - WS 行为：`agent:list`→reply `agent:list`；`agent:create {displayName}`→reply `agent:created` + broadcast `agent:list`；`agent:delete {name}`→reply `agent:deleted` + broadcast `agent:list`；kernel 启动时调用 `configStore.seedDefaults()`
  - `agent:config:save` 改名（`agentName !== config.name`）时走 `renameAgent`，并联动：会话 `primaryAgent` 批量改、其他 agent `partners.askTo` 中旧名替换为新名、广播 `agent:list` 与 `projects:list`

- [ ] **Step 1: 写失败测试**（`ws-server.test.ts` 追加，参照文件内既有的"启动测试 server + ws 客户端"模式；ConfigStore 指向临时目录）

```ts
test("agent:list/create/delete 全流程", async () => {
  const { ws, next } = await connectClient();  // 参照既有 helper 名
  ws.send(JSON.stringify({ type: "agent:create", displayName: "测试员甲" }));
  const created = await next(e => e.type === "agent:created");
  expect(created.agent.name).toBe("测试员甲");
  ws.send(JSON.stringify({ type: "agent:list" }));
  const list = await next(e => e.type === "agent:list");
  expect(list.agents.some((a: any) => a.name === "测试员甲")).toBe(true);
  ws.send(JSON.stringify({ type: "agent:delete", name: "测试员甲" }));
  await next(e => e.type === "agent:deleted");
  ws.send(JSON.stringify({ type: "agent:list" }));
  const list2 = await next(e => e.type === "agent:list");
  expect(list2.agents.some((a: any) => a.name === "测试员甲")).toBe(false);
});

test("agent:create 非法名返回 error", async () => {
  const { ws, next } = await connectClient();
  ws.send(JSON.stringify({ type: "agent:create", displayName: "a/b" }));
  const err = await next(e => e.type === "error");
  expect(err.message).toContain("非法 name");
});

test("agent:config:save 改名联动会话 primaryAgent 与 askTo", async () => {
  const { ws, next, projectStore, configStore } = await connectClient();
  await configStore.createAgent("旧名");
  const proj = await projectStore.createProject({ name: "p", cwd: "/tmp/x" });
  const sess = await projectStore.createSession({ projectId: proj.id, primaryAgent: "旧名", title: "t" });
  const cfg = (await configStore.getAgent("旧名"))!;
  await configStore.saveAgent({ ...cfg, partners: { askTo: [], askFrom: [] } });
  ws.send(JSON.stringify({ type: "agent:config:save", agentName: "旧名", config: { ...cfg, name: "新名" } }));
  await next(e => e.type === "agent:created" || e.type === "agent:list");  // 等广播
  const { sessions } = await projectStore.load();
  expect(sessions.find(s => s.id === sess.id)!.primaryAgent).toBe("新名");
  expect(await configStore.getAgent("旧名")).toBeNull();
  expect(await configStore.getAgent("新名")).not.toBeNull();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/kernel && bun test tests/ws-server.test.ts`
Expected: FAIL（事件未处理）

- [ ] **Step 3: 实现**

`project-store.ts` 追加：

```ts
  async setSessionAgent(id: string, agentName: AgentName): Promise<void> {
    const data = await this.load();
    const s = data.sessions.find(x => x.id === id);
    if (!s) throw new Error(`会话不存在: ${id}`);
    s.primaryAgent = agentName;
    await this.save(data);
  }
```

`ws-server.ts`：
- 启动流程（main/start 函数，生成 provider-extension 附近）加一行：`await configStore.seedDefaults();`
- `case "agent:config:get"` 前插入：

```ts
      case "agent:list": {
        reply({ type: "agent:list", agents: await configStore.listAgents() });
        break;
      }
      case "agent:create": {
        try {
          const agent = await configStore.createAgent(event.displayName);
          reply({ type: "agent:created", agent });
          broadcast({ type: "agent:list", agents: await configStore.listAgents() });
        } catch (err) {
          reply({ type: "error", message: err instanceof Error ? err.message : String(err) });
        }
        break;
      }
      case "agent:delete": {
        try {
          await configStore.deleteAgent(event.name);
          reply({ type: "agent:deleted", name: event.name });
          broadcast({ type: "agent:list", agents: await configStore.listAgents() });
        } catch (err) {
          reply({ type: "error", message: err instanceof Error ? err.message : String(err) });
        }
        break;
      }
```

- `case "agent:config:save"` 内，保存前检测改名（`event.agentName !== event.config.name`）：

```ts
        if (event.agentName !== event.config.name) {
          const errs = await configStore.renameAgent(event.agentName, event.config);
          if (errs.length > 0) { reply({ type: "error", message: errs.join("；") }); break; }
          // 联动：会话 primaryAgent
          const { sessions } = await projectStore.load();
          for (const s of sessions.filter(x => x.primaryAgent === event.agentName)) {
            await projectStore.setSessionAgent(s.id, event.config.name);
          }
          // 联动：其他 agent 的 askTo
          for (const a of await configStore.listAgents()) {
            if (a.name !== event.config.name && a.partners.askTo.includes(event.agentName)) {
              a.partners.askTo = a.partners.askTo.map(n => n === event.agentName ? event.config.name : n);
              await configStore.saveAgent(a);
            }
          }
          agentManager.renameAgentSessions(event.agentName, event.config.name);  // Task 8 实现，本任务先加空调用保护
          broadcast({ type: "projects:list", ...(await projectStore.load()) });
          broadcast({ type: "agent:list", agents: await configStore.listAgents() });
          break;
        }
```

  注：`agentManager.renameAgentSessions` 在 Task 8 才实现；本任务在 `agent-manager.ts` 先加空方法桩：

```ts
  /** 重命名联动（Task 8 补全重建逻辑） */
  renameAgentSessions(_oldName: string, _newName: string): void {}
```

  `broadcast`/`reply` 助手名以文件内既有为准（L230 注释提到的 broadcast 机制）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/kernel && bun test tests/ws-server.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/ws-server.ts packages/kernel/src/project-store.ts packages/kernel/src/agent-manager.ts packages/kernel/tests/ws-server.test.ts
git commit -m "feat(kernel): WS 新增 agent:list/create/delete，config:save 支持改名联动会话与关系网"
```

---

### Task 5: 内置扩展替换 pi-intercom → @gotgenes/pi-subagents

**Files:**
- Modify: `packages/kernel/package.json`
- Modify: `packages/kernel/src/extensions.ts:70-74`
- Modify: `packages/kernel/src/agent-manager.ts`（删 intercom 相关行）
- Modify: `packages/shared/src/constants.ts`（resolveAgentTools 剔除扩展原生 subagent 工具）
- Test: `packages/kernel/tests/extensions.test.ts`（参照既有用例风格）

**Interfaces:**
- Produces: 内置扩展清单含 `@gotgenes/pi-subagents`、不含 `pi-intercom`；`resolveAgentTools` 输出**绝不包含** `subagent`（扩展原生工具，由 Task 6 的 delegate 取代）；`DEFAULT_AGENT_TOOLS` 新增 `"delegate"`

- [ ] **Step 1: 写失败测试**

`packages/kernel/tests/extensions.test.ts` 追加：

```ts
test("内置扩展清单：含 pi-subagents，不含 pi-intercom", async () => {
  const paths = buildAdditionalExtensionPaths([]);
  expect(paths.some(p => p.includes("pi-subagents"))).toBe(true);
  expect(paths.some(p => p.includes("pi-intercom"))).toBe(false);
});
```

`packages/shared/tests/types.test.ts`（或 constants 测试）追加：

```ts
import { resolveAgentTools, DEFAULT_AGENT_TOOLS } from "../src/constants";

test("resolveAgentTools: 扩展原生 subagent 工具被剔除；delegate 放行", () => {
  const out = resolveAgentTools(DEFAULT_AGENT_TOOLS, new Set(), "dev", {}, ["subagent", "some_ext_tool"]);
  expect(out).not.toContain("subagent");
  expect(out).toContain("delegate");
  expect(out).toContain("some_ext_tool");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/kernel && bun test tests/extensions.test.ts; cd ../shared && bun test`
Expected: FAIL

- [ ] **Step 3: 实现**

- `packages/kernel/package.json`：删除 `"pi-intercom": "^0.6.0"`，新增 `"@gotgenes/pi-subagents": "^18.0.3"`；根目录 `bun install`
- `extensions.ts` L70-74 `PKG_EXTENSIONS`：`"pi-intercom"` 改为 `"@gotgenes/pi-subagents"`
- `agent-manager.ts`：
  - 删除 L389-390 intercom 会话名注释与 `session.setSessionName(...)` 调用（若 `setSessionName` 无其他用途）
  - L392-394 注释中 `pi-intercom / pi-web-access` 改为 `pi-subagents / pi-web-access`（`bindExtensions` 调用保留）
- `shared/src/constants.ts`：
  - `DEFAULT_AGENT_TOOLS` 数组末尾（`"ask_user_question"` 后）加 `"delegate",`，注释：`// delegate：宿主关系网调起工具（customTools 注入）`
  - `resolveAgentTools` harvestedTools 循环前加剔除：

```ts
  // 扩展原生 subagent 工具永不放行：LLM 只能走宿主 delegate 工具（allowlist 强制）
  const BLOCKED = new Set(["subagent"]);
```

  并在最终 `return result;` 前改 `return result.filter(t => !BLOCKED.has(t));`

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `cd packages/kernel && bun test; cd ../shared && bun test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/package.json packages/kernel/src/extensions.ts packages/kernel/src/agent-manager.ts packages/shared/src/constants.ts bun.lock
git commit -m "feat(kernel): 内置扩展 pi-intercom 替换为 @gotgenes/pi-subagents，屏蔽扩展原生 subagent 工具"
```

---

### Task 6: delegate customTool + 关系网提示词注入

**Files:**
- Create: `packages/kernel/src/delegate-tool.ts`
- Modify: `packages/kernel/src/agent-manager.ts`（`_createSession` 的 customTools 与 systemPromptOverride）
- Test: `packages/kernel/tests/delegate-tool.test.ts`

**Interfaces:**
- Produces:
  - `makeDelegateTool(opts: { askTo: { name: string; description: string }[]; spawn: (agent: string, task: string) => Promise<string> }): CustomToolDef`
    - 工具名 `"delegate"`，参数 `{ agent: string, task: string }`
    - `agent ∉ askTo` → 返回 `{ content: [{ type: "text", text: "错误：智能体「X」不在可调起列表…" }], isError: true }`，**不调用 spawn**
    - 合法 → `spawn(agent, task)` 结果作为 text 返回
  - `buildDelegatePrompt(askTo: { name: string; description: string; triggerKeywords: string[] }[]): string`（提示词段纯函数，askTo 空返回 `""`）

- [ ] **Step 0: 探查 service API（不写代码，只确认）**

Run: `cd packages/kernel && node -e "const p=require('@gotgenes/pi-subagents/package.json'); console.log(p.exports ?? p.main)"` 并 `ls node_modules/@gotgenes/pi-subagents/dist`
确认包入口存在 `getSubagentsService` 导出（README 契约：`const { getSubagentsService } = await import("@gotgenes/pi-subagents"); getSubagentsService()?.spawn(type, prompt)`）。spawn 返回值的 text 提取方式以 dist 内 `service.d.ts` 为准——在 delegate-tool 里写 `String(result)` 兜底。

- [ ] **Step 1: 写失败测试**

```ts
import { test, expect, mock } from "bun:test";
import { makeDelegateTool, buildDelegatePrompt } from "../src/delegate-tool";

const askTo = [
  { name: "代码审查", description: "评审改动", triggerKeywords: ["review", "评审"] },
  { name: "质量验收", description: "测试与验收", triggerKeywords: [] },
];

test("delegate: 越权调起返回错误且不 spawn", async () => {
  const spawn = mock(async () => "ok");
  const tool = makeDelegateTool({ askTo, spawn });
  const res = await tool.execute("tc1", { agent: "陌生人", task: "hi" });
  expect(res.isError).toBe(true);
  expect(res.content[0].text).toContain("不在可调起列表");
  expect(spawn).not.toHaveBeenCalled();
});

test("delegate: 合法调起透传结果", async () => {
  const spawn = mock(async (agent: string, task: string) => `${agent}完成:${task}`);
  const tool = makeDelegateTool({ askTo, spawn });
  const res = await tool.execute("tc2", { agent: "代码审查", task: "review diff" });
  expect(res.isError).toBe(false);
  expect(res.content[0].text).toBe("代码审查完成:review diff");
});

test("buildDelegatePrompt: 含名称/简介/关键词；空 askTo 返回空串", () => {
  const p = buildDelegatePrompt(askTo);
  expect(p).toContain("代码审查");
  expect(p).toContain("评审改动");
  expect(p).toContain("review、评审");
  expect(p).toContain("delegate");
  expect(buildDelegatePrompt([])).toBe("");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/kernel && bun test tests/delegate-tool.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** `delegate-tool.ts`（customTool 结构对齐 `ask-tool.ts` 的 `makeAskTool` 与 memory 工具的返回形态，先看一眼 `src/ask-tool.ts` 保持同构）

```ts
// 关系网调起工具：LLM 经 delegate(agent, task) 调起 askTo 内的智能体。
// allowlist 在宿主侧强制——扩展原生 subagent 工具不进 allowlist（见 constants.resolveAgentTools）。
export interface DelegateTarget { name: string; description: string; }

export function makeDelegateTool(opts: {
  askTo: DelegateTarget[];
  spawn: (agent: string, task: string) => Promise<string>;
}) {
  return {
    name: "delegate",
    description: "调起关系网内的子智能体执行任务并返回结果",
    parameters: {
      type: "object",
      properties: {
        agent: { type: "string", description: "可调起列表中的智能体名称" },
        task: { type: "string", description: "交给子智能体的任务描述" },
      },
      required: ["agent", "task"],
    },
    async execute(_toolCallId: string, args: { agent: string; task: string }) {
      if (!opts.askTo.some(t => t.name === args.agent)) {
        const allow = opts.askTo.map(t => t.name).join("、") || "（空）";
        return {
          content: [{ type: "text" as const, text: `错误：智能体「${args.agent}」不在可调起列表中。可调起：${allow}` }],
          isError: true,
        };
      }
      const text = await opts.spawn(args.agent, args.task);
      return { content: [{ type: "text" as const, text }], isError: false };
    },
  };
}

export function buildDelegatePrompt(
  askTo: { name: string; description: string; triggerKeywords: string[] }[],
): string {
  if (askTo.length === 0) return "";
  const lines = askTo.map(t => {
    const kw = t.triggerKeywords.length ? `；触发关键词：${t.triggerKeywords.join("、")}` : "";
    return `- ${t.name}：${t.description || "（无简介）"}${kw}`;
  });
  return [
    "你可以通过 delegate 工具（参数 agent、task）调起以下智能体协作：",
    ...lines,
    "当用户消息涉及某智能体的触发关键词或其简介描述的话题时，优先调起对应智能体；只能调起列表内的智能体。",
  ].join("\n");
}
```

`agent-manager.ts` `_createSession`：
- customTools 行（L360）改为：

```ts
      customTools: [...memoryCustomTools, makeAskTool(sessionId), ...delegateTools],
```

- 其前构造 delegateTools：

```ts
    // 关系网调起：askTo 非空才注册 delegate 工具；spawn 走 pi-subagents service（进程内单例）
    const askToConfigs = config
      ? (await Promise.all(config.partners.askTo.map(n => this.opts.configStore!.getAgent(n)))).filter((c): c is NonNullable<typeof c> => c != null)
      : [];
    const delegatePrompt = buildDelegatePrompt(
      askToConfigs.map(c => ({ name: c.name, description: c.description, triggerKeywords: c.triggerKeywords })),
    );
    const delegateTools = askToConfigs.length === 0 ? [] : [
      makeDelegateTool({
        askTo: askToConfigs.map(c => ({ name: c.name, description: c.description })),
        spawn: async (agent, task) => {
          const { getSubagentsService } = await import("@gotgenes/pi-subagents");
          const svc = getSubagentsService();
          if (!svc) throw new Error("子智能体服务未就绪");
          const result: unknown = await svc.spawn(agent, task);
          return typeof result === "string" ? result : JSON.stringify(result);
        },
      }) as any,
    ];
```

- `systemPromptOverride` 返回前注入（L321 return 行）：

```ts
        const withMemory = memorySnapshot ? `${baseWithEnv}\n\n${memorySnapshot}` : baseWithEnv;
        return delegatePrompt ? `${withMemory}\n\n${delegatePrompt}` : withMemory;
```

- import：`import { makeDelegateTool, buildDelegatePrompt } from "./delegate-tool";`

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `cd packages/kernel && bun test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/delegate-tool.ts packages/kernel/src/agent-manager.ts packages/kernel/tests/delegate-tool.test.ts
git commit -m "feat(kernel): 新增 delegate 关系网调起工具（allowlist 宿主强制）+ 提示词注入"
```

---

### Task 7: agent:tools:list + resolveAgentTools 按 AgentConfig.tools 过滤

**Files:**
- Modify: `packages/kernel/src/ws-server.ts`
- Modify: `packages/kernel/src/agent-manager.ts`（tools 解析逻辑微调）
- Test: `packages/kernel/tests/ws-server.test.ts`

**Interfaces:**
- Produces: WS `agent:tools:list` → `tools: { name, source }[]`，source ∈ `"内置"|"扩展"|"MCP"`；行为约定：`AgentConfig.tools` 为空 = 全量默认（现状），非空 = 作为 allowlist 过滤（内置+扩展工具均可被勾选/取消）

- [ ] **Step 1: 写失败测试**

```ts
test("agent:tools:list 返回内置工具且不含 subagent", async () => {
  const { ws, next } = await connectClient();
  ws.send(JSON.stringify({ type: "agent:tools:list" }));
  const res = await next(e => e.type === "agent:tools:list");
  const names = res.tools.map((t: any) => t.name);
  expect(names).toContain("read");
  expect(names).toContain("delegate");
  expect(names).not.toContain("subagent");
  expect(res.tools.find((t: any) => t.name === "read").source).toBe("内置");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/kernel && bun test tests/ws-server.test.ts -t "agent:tools:list"`
Expected: FAIL（未知事件类型无响应 → 超时）

- [ ] **Step 3: 实现**

`agent-manager.ts` 新增公开方法（复用 L340-349 的 harvest 逻辑；loader 缓存实例级惰性创建或直接新建一个临时 loader 做发现——按现有代码最小改动：抽取私有方法 `harvestGlobalTools(): Promise<{ name: string; source: string }[]>`）：

```ts
  /** 全局工具清单：内置（DEFAULT_AGENT_TOOLS）+ 扩展动态发现 + MCP（如有），供详情弹窗勾选 */
  async listGlobalTools(): Promise<{ name: string; source: string }[]> {
    const items = DEFAULT_AGENT_TOOLS
      .filter(t => t !== "subagent")
      .map(name => ({ name, source: "内置" }));
    const seen = new Set(items.map(i => i.name));
    // 扩展工具：建一个轻量 loader 做发现（与 _createSession 同一来源，避免两处漂移）
    try {
      const sdk = await import("@earendil-works/pi-coding-agent");
      const loader = new sdk.DefaultResourceLoader({
        cwd: process.cwd(),
        agentDir: WA_PI_DIR,
        additionalExtensionPaths: buildAdditionalExtensionPaths([...(await this.getEnabledExtensionIds())]),
      });
      await loader.reload();
      for (const t of extractRuntimeToolNames(loader)) {
        if (!seen.has(t) && t !== "subagent") { seen.add(t); items.push({ name: t, source: "扩展" }); }
      }
    } catch { /* 发现失败时只返回内置 */ }
    return items;
  }
```

（MCP 工具经 pi-mcp-adapter 扩展注册，已包含在 harvest 里，source 统一标 "扩展"；import 补充 `DEFAULT_AGENT_TOOLS`、`buildAdditionalExtensionPaths`、`extractRuntimeToolNames`、`WA_PI_DIR`，这些在文件里大多已有。）

`ws-server.ts` 增加 case：

```ts
      case "agent:tools:list": {
        reply({ type: "agent:tools:list", tools: await agentManager.listGlobalTools() });
        break;
      }
```

`agent-manager.ts` tools 解析（L343-349）确认现状已满足 spec：`config?.tools?.length ? config.tools : DEFAULT_AGENT_TOOLS`——已为空全量、非空过滤，无需改动（回归测试覆盖即可）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/kernel && bun test tests/ws-server.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/ws-server.ts packages/kernel/src/agent-manager.ts packages/kernel/tests/ws-server.test.ts
git commit -m "feat(kernel): 新增 agent:tools:list 全局工具清单（内置+扩展，剔除 subagent）"
```

---

### Task 8: session:set-agent 换体重建 + agent_missing 拦截

**Files:**
- Modify: `packages/kernel/src/agent-manager.ts`
- Modify: `packages/kernel/src/ws-server.ts`（新增 case + `agent:prompt` 检查）
- Test: `packages/kernel/tests/agent-manager.test.ts`、`packages/kernel/tests/ws-server.test.ts`

**Interfaces:**
- Produces:
  - `AgentManager.switchAgent(sessionId: string, agentName: AgentName): Promise<void>`（运行中先 abort；teardown；更新 sessionMeta 与 ProjectStore；用同一 sessionId 走 `_createSession` 重建，jsonl 历史保留）
  - `AgentManager.renameAgentSessions(oldName, newName)`（补全 Task 4 的桩：更新 sessionMeta，活跃会话标 dirty 待下次 ensureStarted 重建）
  - WS `session:set-agent` → 成功后 broadcast `session:updated { sessionId, primaryAgent }`
  - `agent:prompt` 前置检查：会话已存在且其 `primaryAgent` 配置已删除 → reply `{ type: "error", message: "agent_missing", sessionId }`，不进入 ensureStarted

- [ ] **Step 1: 写失败测试**

`agent-manager.test.ts` 追加（参照文件内既有 fakeSession/createAgentSessionFn mock 模式）：

```ts
test("switchAgent: 换体重建，sessionId 不变且 config 取新 agent", async () => {
  const { manager, createAgentSessionFnCalls, fakeSessionFactory } = makeManager();  // 参照既有 helper
  await manager.ensureStarted("p1", "dev", "s1");
  const before = createAgentSessionFnCalls.length;
  await manager.switchAgent("s1", "pm");
  expect(createAgentSessionFnCalls.length).toBe(before + 1);
  // 重建后 ensureStarted 返回新 session（dispose+create 已完成）
  const s = await manager.ensureStarted("p1", "pm", "s1");
  expect(s).toBeTruthy();
});

test("renameAgentSessions: sessionMeta 更新，下次 ensureStarted 用新名重建", async () => {
  const { manager } = makeManager();
  await manager.ensureStarted("p1", "旧名", "s1");
  manager.renameAgentSessions("旧名", "新名");
  // meta 已改（通过后续重建断言 agentName）
  await manager.ensureStarted("p1", "新名", "s1");
});
```

`ws-server.test.ts` 追加：

```ts
test("session:set-agent 更新并广播 session:updated", async () => {
  const { ws, next, projectStore, configStore } = await connectClient();
  await configStore.createAgent("甲");
  const proj = await projectStore.createProject({ name: "p", cwd: "/tmp/x" });
  const sess = await projectStore.createSession({ projectId: proj.id, primaryAgent: "dev", title: "t" });
  ws.send(JSON.stringify({ type: "session:set-agent", sessionId: sess.id, agentName: "甲" }));
  const upd = await next(e => e.type === "session:updated");
  expect(upd.primaryAgent).toBe("甲");
  const { sessions } = await projectStore.load();
  expect(sessions.find(s => s.id === sess.id)!.primaryAgent).toBe("甲");
});

test("agent:prompt 对 primaryAgent 已删除的会话返回 agent_missing", async () => {
  const { ws, next, projectStore } = await connectClient();
  const proj = await projectStore.createProject({ name: "p", cwd: "/tmp/x" });
  const sess = await projectStore.createSession({ projectId: proj.id, primaryAgent: "不存在的智能体", title: "t" });
  ws.send(JSON.stringify({ type: "agent:prompt", projectId: proj.id, sessionId: sess.id, agentName: "不存在的智能体", text: "hi" }));
  const err = await next(e => e.type === "error");
  expect(err.message).toBe("agent_missing");
  expect(err.sessionId).toBe(sess.id);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/kernel && bun test tests/agent-manager.test.ts tests/ws-server.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`agent-manager.ts`：

```ts
  /** 对话中切换智能体：运行中先 abort，拆除后按同一 sessionId 重建（jsonl 历史保留） */
  async switchAgent(sessionId: string, agentName: AgentName): Promise<void> {
    const meta = this.sessionMeta.get(sessionId);
    const old = this.sessions.get(sessionId);
    if (old?.isStreaming) {
      try { await old.abort(); } catch { /* 忽略 */ }
    }
    this._teardownSession(sessionId);
    const projectId = meta?.projectId ?? (await this.opts.projectStore.load()).sessions.find(s => s.id === sessionId)?.projectId;
    if (!projectId) throw new Error(`会话不存在: ${sessionId}`);
    await this.opts.projectStore.setSessionAgent(sessionId, agentName);
    this.sessionMeta.set(sessionId, { projectId, agentName });
    const promise = this._createSession(projectId, agentName, sessionId);
    this.starting.set(sessionId, promise);
    try { await promise; } finally { this.starting.delete(sessionId); }
  }

  /** agent 重命名联动：更新活跃会话 meta，标 skillDirty 使下次 ensureStarted 重建 */
  renameAgentSessions(oldName: string, newName: string): void {
    for (const [id, meta] of this.sessionMeta) {
      if (meta.agentName === oldName) {
        this.sessionMeta.set(id, { ...meta, agentName: newName });
        this.skillDirty.add(id);
      }
    }
  }
```

（删除 Task 4 加的同名空桩。`_teardownSession`/`starting` 为既有私有成员，直接用。）

`ws-server.ts`：
- 新增 case（放 `session:rename` 附近）：

```ts
      case "session:set-agent": {
        try {
          await agentManager.switchAgent(event.sessionId, event.agentName);
          broadcast({ type: "session:updated", sessionId: event.sessionId, primaryAgent: event.agentName });
          broadcast({ type: "projects:list", ...(await projectStore.load()) });
        } catch (err) {
          reply({ type: "error", message: err instanceof Error ? err.message : String(err), sessionId: event.sessionId });
        }
        break;
      }
```

- `case "agent:prompt"` 内（L332-339 会话查找之后、ensureStarted 之前）：

```ts
        const existing = sessions.find(s => s.id === event.sessionId);
        if (existing && !(await configStore.getAgent(existing.primaryAgent))) {
          reply({ type: "error", message: "agent_missing", sessionId: event.sessionId });
          break;
        }
```

（变量名以实际代码为准。）

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `cd packages/kernel && bun test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/agent-manager.ts packages/kernel/src/ws-server.ts packages/kernel/tests
git commit -m "feat(kernel): session:set-agent 换体重建保留历史，agent 删除后会话发消息返回 agent_missing"
```

---

### Task 9: 前端 agents store 重构 + 最近使用排序

**Files:**
- Modify: `packages/frontend/src/store/agents.ts`
- Test: `packages/frontend/tests/agents-store.test.ts`

**Interfaces:**
- Produces:
  - `useAgentsStore`：`list: AgentConfig[]`、`configs: Record<string, AgentConfig>`、`loadAll(): void`、`createAgent(displayName: string): void`、`deleteAgent(name: string): void`、`loadConfig(name)`、`setConfig(name, c)`
  - 纯函数 `topAgentsByRecency(agents: AgentConfig[], sessions: SessionEntity[], n: number): AgentConfig[]`（按各 agent 名下会话最大 lastActivity 倒序取前 n；无会话的 agent 排最后，按名称稳定）
  - App 挂载时 `loadAll()`；监听 `agent:list` 广播刷新（`ws-instance.onMessage`，参照 skills store 的订阅模式）

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { topAgentsByRecency, useAgentsStore } from "../src/store/agents";
import type { AgentConfig, SessionEntity } from "@wa-pi/shared";

const agent = (name: string): AgentConfig => ({
  name, displayName: name, avatar: "🤖", avatarColor: "#000-#111", description: "",
  model: "m", thinking: "medium", systemPromptMode: "replace",
  inheritProjectContext: true, inheritSkills: true,
  tools: [], skills: [], mcpServers: [], partners: { askTo: [], askFrom: [] }, triggerKeywords: [],
});
const sess = (agent: string, lastActivity: number): SessionEntity =>
  ({ id: Math.random().toString(), projectId: "p", primaryAgent: agent, title: "", createdAt: 0, lastActivity, piSessionFile: "" });

describe("topAgentsByRecency", () => {
  it("按最近会话时间倒序取前 n，无会话的排最后", () => {
    const agents = [agent("a"), agent("b"), agent("c"), agent("d")];
    const sessions = [sess("b", 100), sess("c", 300), sess("b", 200)];
    const top = topAgentsByRecency(agents, sessions, 3);
    expect(top.map(a => a.name)).toEqual(["c", "b", "a"]);  // c 最新、b 次之、a/d 无会话按名称序，取前 3
  });
  it("agents 不足 n 时全返回", () => {
    expect(topAgentsByRecency([agent("x")], [], 3)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/frontend && bunx vitest run tests/agents-store.test.ts`
Expected: FAIL（`topAgentsByRecency is not exported`）

- [ ] **Step 3: 实现**（`store/agents.ts` 重写，保留 `configs/loadConfig/setConfig` 兼容 AgentConfig 弹窗）

```ts
import { create } from "zustand";
import type { AgentConfig, AgentName, SessionEntity } from "@wa-pi/shared";
import { send } from "../ws-instance";

/** 最近使用排序：各 agent 名下会话最大 lastActivity 倒序；无会话的按名称排最后 */
export function topAgentsByRecency(
  agents: AgentConfig[], sessions: SessionEntity[], n: number,
): AgentConfig[] {
  const lastOf = new Map<string, number>();
  for (const s of sessions) {
    lastOf.set(s.primaryAgent, Math.max(lastOf.get(s.primaryAgent) ?? 0, s.lastActivity));
  }
  return [...agents]
    .sort((x, y) => (lastOf.get(y.name) ?? -1) - (lastOf.get(x.name) ?? -1) || x.name.localeCompare(y.name))
    .slice(0, n);
}

interface AgentsState {
  list: AgentConfig[];
  configs: Record<string, AgentConfig>;
  loadAll: () => void;
  setList: (agents: AgentConfig[]) => void;
  createAgent: (displayName: string) => void;
  deleteAgent: (name: string) => void;
  loadConfig: (name: AgentName) => void;
  setConfig: (name: AgentName, c: AgentConfig) => void;
}

export const useAgentsStore = create<AgentsState>((set) => ({
  list: [],
  configs: {},
  loadAll: () => send({ type: "agent:list" }),
  setList: (agents) => set({ list: agents }),
  createAgent: (displayName) => send({ type: "agent:create", displayName }),
  deleteAgent: (name) => send({ type: "agent:delete", name }),
  loadConfig: (name) => send({ type: "agent:config:get", agentName: name }),
  setConfig: (name, c) => set(st => ({ configs: { ...st.configs, [name]: c } })),
}));
```

`agent:list` 响应的订阅放在 Task 16 的 App 接线（`onMessage` 中 `e.type === "agent:list" → setList(e.agents)`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/frontend && bunx vitest run tests/agents-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/store/agents.ts packages/frontend/tests/agents-store.test.ts
git commit -m "feat(frontend): agents store 重构——全量列表/CRUD 动作/最近使用排序纯函数"
```

---

### Task 10: AgentListSection 重构（侧边栏智能体区）

**UI 原型：** `docs/superpowers/specs/2026-07-17-agent-matrix-mockups/sidebar-agents.html`（A 紧凑行：头像+名称+状态点；右键菜单【编辑智能体】【删除】；底部【更多智能体 (n)】）

**Files:**
- Modify: `packages/frontend/src/components/AgentListSection.tsx`
- Test: `packages/frontend/tests/AgentListSection.test.tsx`

**Interfaces:**
- Consumes: Task 9 `useAgentsStore.list` + `topAgentsByRecency`；`useProjectsStore.sessions/currentProjectId`；右键菜单参照 `ProjectItem.tsx` 的 ContextMenu 实现（先读该文件复用其模式/组件）
- Produces: `<AgentListSection onChatWith:(name: string) => void onEdit:(name: string) => void onMore:() => void />`；`data-testid`：`agent-<name>`、`agent-more`、`agent-ctx-edit`、`agent-ctx-delete`

- [ ] **Step 1: 写失败测试**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentListSection } from "../src/components/AgentListSection";
import { useAgentsStore } from "../src/store/agents";
import { useProjectsStore } from "../src/store/projects";
import type { AgentConfig } from "@wa-pi/shared";

const agent = (name: string): AgentConfig => ({
  name, displayName: name, avatar: "🤖", avatarColor: "#000-#111", description: "",
  model: "m", thinking: "medium", systemPromptMode: "replace",
  inheritProjectContext: true, inheritSkills: true,
  tools: [], skills: [], mcpServers: [], partners: { askTo: [], askFrom: [] }, triggerKeywords: [],
});

function seed(names: string[]) {
  useAgentsStore.setState({ list: names.map(agent) });
  useProjectsStore.setState({ sessions: [], projects: [], currentProjectId: null } as any);
}

describe("AgentListSection", () => {
  it("只显示前 3 个，超过显示「更多智能体」", () => {
    seed(["a", "b", "c", "d", "e"]);
    render(<AgentListSection onChatWith={() => {}} onEdit={() => {}} onMore={() => {}} />);
    expect(screen.queryByTestId("agent-a")).toBeTruthy();
    expect(screen.queryByTestId("agent-c")).toBeTruthy();
    expect(screen.queryByTestId("agent-d")).toBeNull();
    expect(screen.getByTestId("agent-more").textContent).toContain("更多智能体");
  });

  it("≤3 个时不显示更多入口", () => {
    seed(["a", "b"]);
    render(<AgentListSection onChatWith={() => {}} onEdit={() => {}} onMore={() => {}} />);
    expect(screen.queryByTestId("agent-more")).toBeNull();
  });

  it("左键触发 onChatWith；右键弹菜单含编辑/删除", () => {
    seed(["a"]);
    const onChatWith = vi.fn();
    render(<AgentListSection onChatWith={onChatWith} onEdit={() => {}} onMore={() => {}} />);
    fireEvent.click(screen.getByTestId("agent-a"));
    expect(onChatWith).toHaveBeenCalledWith("a");
    fireEvent.contextMenu(screen.getByTestId("agent-a"));
    expect(screen.getByTestId("agent-ctx-edit")).toBeTruthy();
    expect(screen.getByTestId("agent-ctx-delete")).toBeTruthy();
  });

  it("点删除先弹二次确认", () => {
    seed(["a"]);
    render(<AgentListSection onChatWith={() => {}} onEdit={() => {}} onMore={() => {}} />);
    fireEvent.contextMenu(screen.getByTestId("agent-a"));
    fireEvent.click(screen.getByTestId("agent-ctx-delete"));
    expect(screen.getByTestId("agent-delete-confirm")).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/frontend && bunx vitest run tests/AgentListSection.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**（重写 `AgentListSection.tsx`；右键菜单与确认弹窗复用 `ProjectItem.tsx` 既有模式——先读它；头像渲染用 `agentDefOf(name)` + `list` 中 config 的 avatar/avatarColor 优先）

要点（完整组件约 120 行）：
- `const agents = useAgentsStore(s => s.list);` `const sessions = useProjectsStore(s => s.sessions);`
- `const top = topAgentsByRecency(agents, sessions, 3);`
- 每行：左键 `onChatWith(name)`；`onContextMenu` 记录 `ctxFor` 状态渲染菜单（【编辑智能体】→ `onEdit(name)`；【删除】→ 设 `deleteFor` 渲染确认弹窗，确认后 `useAgentsStore.getState().deleteAgent(name)`）
- 状态点逻辑保留现有 `statusOf`/`aggregateAgentState` 实现不变
- 底部：`agents.length > 3 && <button data-testid="agent-more" onClick={onMore}>⋯ 更多智能体 ({agents.length - 3})</button>`
- 样式按原型：紧凑行 hover 底色、状态点 `STATUS_COLORS`；菜单绝对定位卡片

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/frontend && bunx vitest run tests/AgentListSection.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/components/AgentListSection.tsx packages/frontend/tests/AgentListSection.test.tsx
git commit -m "feat(frontend): 侧边栏智能体区重构——最近使用前3+右键编辑/删除+更多入口"
```

---

### Task 10b: 侧边栏空态【新增智能体】入口（用户追加需求，2026-07-18）

**背景：** 用户评审交互时提出：没有任何智能体时，会话列表上方的智能体区没有任何创建入口，必须有。

**Files:**
- Modify: `packages/frontend/src/components/AgentListSection.tsx`
- Test: `packages/frontend/tests/AgentListSection.test.tsx`

**Interfaces:**
- Produces: 空态行 `data-testid="agent-empty-create"`（按钮文案 "＋ 新增智能体"）；点击变为内联输入行 `data-testid="agent-empty-input"`（回车提交，Esc 取消）
- 提交行为：trim 后非空 → `useAgentsStore.getState().createAgent(name)`；kernel 广播 `agent:list` 后新智能体自然出现在列表（已有订阅链路）
- 仅当 `agents.length === 0` 时显示；非空时不渲染该行（也不显示"更多智能体"入口）

**Step 1: 写失败测试（bun:test）**

```tsx
test("空态显示新增智能体入口，回车创建", async () => {
  seed([]);  // 空列表
  render(<AgentListSection onChatWith={() => {}} onEdit={() => {}} onMore={() => {}} />);
  expect(screen.getByTestId("agent-empty-create")).toBeTruthy();
  expect(screen.queryByTestId("agent-more")).toBeNull();
  fireEvent.click(screen.getByTestId("agent-empty-create"));
  const input = screen.getByTestId("agent-empty-input");
  fireEvent.change(input, { target: { value: "我的助手" } });
  fireEvent.keyDown(input, { key: "Enter" });
  // 断言 store createAgent 被调（mock 模式参照本文件既有 createAgent spy）
});

test("空态输入 Esc 取消；空白名不提交", () => {
  seed([]);
  render(<AgentListSection onChatWith={() => {}} onEdit={() => {}} onMore={() => {}} />);
  fireEvent.click(screen.getByTestId("agent-empty-create"));
  const input = screen.getByTestId("agent-empty-input");
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByTestId("agent-empty-input")).toBeNull();
  fireEvent.click(screen.getByTestId("agent-empty-create"));
  const input2 = screen.getByTestId("agent-empty-input");
  fireEvent.change(input2, { target: { value: "   " } });
  fireEvent.keyDown(input2, { key: "Enter" });
  // createAgent 未被调用
});

test("非空列表不显示空态入口", () => {
  seed(["a"]);
  render(<AgentListSection onChatWith={() => {}} onEdit={() => {}} onMore={() => {}} />);
  expect(screen.queryByTestId("agent-empty-create")).toBeNull();
});
```

**Step 2: 实现**（AgentListSection.tsx，参照 AgentGalleryModal 新建小表单的模式：useState creating + input 自动 focus）

- 组件内加 `const [creating, setCreating] = useState(false);`
- `agents.length === 0` 时，agent 行区域替换为：creating ? 内联输入行（autoFocus、回车提交、Esc 取消、失焦取消）: 【＋ 新增智能体】按钮行
- 提交：`const name = value.trim(); if (!name) return; useAgentsStore.getState().createAgent(name); setCreating(false);`
- 样式沿用紧凑行风格（hover 底色、text-[13px] text-secondary），与原型紧凑行一致

**Step 3: 全量 `cd packages/frontend && bun test` → commit**

```bash
git add packages/frontend/src/components/AgentListSection.tsx packages/frontend/tests/AgentListSection.test.tsx
git commit -m "feat(frontend): 侧边栏智能体区空态新增智能体入口（内联创建）"
```

---

### Task 11: AgentGalleryModal（全部智能体宫格弹窗）

**UI 原型：** `docs/superpowers/specs/2026-07-17-agent-matrix-mockups/agent-gallery.html`（3 列卡片宫格：头像+名称+两行简介+状态点；右上【新建智能体】；左键建会话、右键编辑/删除；底部提示条）

**Files:**
- Create: `packages/frontend/src/components/AgentGalleryModal.tsx`
- Test: `packages/frontend/tests/AgentGalleryModal.test.tsx`

**Interfaces:**
- Consumes: `useAgentsStore`（list/deleteAgent）；Task 10 的右键菜单/删除确认模式
- Produces: `<AgentGalleryModal onClose onChatWith:(name) => void onEdit:(name) => void onCreated:(name: string) => void />`；`data-testid`：`agent-gallery`、`gallery-card-<name>`、`gallery-create`、`gallery-ctx-edit`、`gallery-ctx-delete`

- [ ] **Step 1: 写失败测试**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AgentGalleryModal } from "../src/components/AgentGalleryModal";
import { useAgentsStore } from "../src/store/agents";
import { useProjectsStore } from "../src/store/projects";
import type { AgentConfig } from "@wa-pi/shared";

const agent = (name: string, description = "简介"): AgentConfig => ({
  name, displayName: name, avatar: "🤖", avatarColor: "#000-#111", description,
  model: "m", thinking: "medium", systemPromptMode: "replace",
  inheritProjectContext: true, inheritSkills: true,
  tools: [], skills: [], mcpServers: [], partners: { askTo: [], askFrom: [] }, triggerKeywords: [],
});

function seed(names: string[]) {
  useAgentsStore.setState({ list: names.map(n => agent(n)) });
  useProjectsStore.setState({ sessions: [], projects: [] } as any);
}

describe("AgentGalleryModal", () => {
  it("宫格渲染全部智能体（名称+简介）", () => {
    seed(["a", "b", "c", "d"]);
    render(<AgentGalleryModal onClose={() => {}} onChatWith={() => {}} onEdit={() => {}} onCreated={() => {}} />);
    expect(screen.getByTestId("agent-gallery")).toBeTruthy();
    for (const n of ["a", "b", "c", "d"]) expect(screen.getByTestId(`gallery-card-${n}`)).toBeTruthy();
  });

  it("左键卡片触发 onChatWith；右键弹编辑/删除菜单", () => {
    seed(["a"]);
    const onChatWith = vi.fn();
    render(<AgentGalleryModal onClose={() => {}} onChatWith={onChatWith} onEdit={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByTestId("gallery-card-a"));
    expect(onChatWith).toHaveBeenCalledWith("a");
    fireEvent.contextMenu(screen.getByTestId("gallery-card-a"));
    expect(screen.getByTestId("gallery-ctx-edit")).toBeTruthy();
    expect(screen.getByTestId("gallery-ctx-delete")).toBeTruthy();
  });

  it("点新建智能体输入名称后触发 agent:create", () => {
    seed([]);
    const sent: any[] = [];
    // mock send（参照 extensions-store.test 的 mock 方式）
    vi.doMock("../src/ws-instance", () => ({ send: (e: any) => sent.push(e), onMessage: () => () => {} }));
    render(<AgentGalleryModal onClose={() => {}} onChatWith={() => {}} onEdit={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByTestId("gallery-create"));
    fireEvent.change(screen.getByTestId("gallery-create-input"), { target: { value: "新智能体" } });
    fireEvent.click(screen.getByTestId("gallery-create-ok"));
    expect(sent.some(e => e.type === "agent:create" && e.displayName === "新智能体")).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/frontend && bunx vitest run tests/AgentGalleryModal.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**（新建 = 弹内小表单：输入名称 → `createAgent(name)` → kernel 广播 `agent:list` 刷新后 `onCreated(名称)` 打开详情弹窗；ws-instance 的 mock 方式参照 `tests/extensions-store.test.ts` 既有写法）

布局按原型：`grid grid-cols-3 gap-3`、卡片 hover 边框高亮、底部提示条"左键：新建会话 · 右键：编辑 / 删除 · 右上：新建智能体"。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/frontend && bunx vitest run tests/AgentGalleryModal.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/components/AgentGalleryModal.tsx packages/frontend/tests/AgentGalleryModal.test.tsx
git commit -m "feat(frontend): 新增全部智能体宫格弹窗（卡片左右键+新建）"
```

---

### Task 12: AgentConfig 弹窗重构（4 tab）

**UI 原型：** `docs/superpowers/specs/2026-07-17-agent-matrix-mockups/agent-detail-tabs-v4.html`（4 tab：基本[身份/模型/提示词/触发条件四段滚动] / 工具 / 技能 / 关系网[带搜索，自身置灰]）

**Files:**
- Modify: `packages/frontend/src/components/AgentConfig.tsx`
- Test: `packages/frontend/tests/AgentConfig.test.tsx`

**Interfaces:**
- Consumes: `useAgentsStore`（list 供关系网勾选）、`useSkillsStore`（allSkills）、WS `agent:tools:list`、`agent:config:save`；`ThinkingSelector` 复用（`components/ui/ThinkingSelector.tsx`）
- Produces: 保持 `<AgentConfig agentName onClose />` 签名；tab 类型 `type Tab = "basic" | "tools" | "skills" | "partners"`；`data-testid`：`tab-basic/tools/skills/partners`、`kw-input`、`kw-chip-<词>`、`partner-search`、`partner-check-<name>`、`tool-check-<name>`、`skill-check-<name>`

- [ ] **Step 1: 写失败测试**（在既有 `AgentConfig.test.tsx` 上改/加）

```tsx
it("4 个 tab：基本/工具/技能/关系网", async () => {
  renderConfig("dev");  // 参照既有 helper：mock ws 回包 agent:config
  expect(screen.getByTestId("tab-basic")).toBeTruthy();
  expect(screen.getByTestId("tab-tools")).toBeTruthy();
  expect(screen.getByTestId("tab-skills")).toBeTruthy();
  expect(screen.getByTestId("tab-partners")).toBeTruthy();
});

it("基本 tab：名称/简介/头像/模型/思考四档/提示词/关键词编辑", async () => {
  renderConfig("dev");
  // 思考档位复用 ThinkingSelector（off/mid/high/max）
  expect(screen.getByTestId("thinking-selector")).toBeTruthy();
  // 关键词：输入回车新增 chip，✕ 删除
  fireEvent.change(screen.getByTestId("kw-input"), { target: { value: "排期" } });
  fireEvent.keyDown(screen.getByTestId("kw-input"), { key: "Enter" });
  expect(screen.getByTestId("kw-chip-排期")).toBeTruthy();
  fireEvent.click(screen.getByTestId("kw-chip-x-排期"));
  expect(screen.queryByTestId("kw-chip-排期")).toBeNull();
});

it("关系网 tab：搜索过滤 + 自身置灰不可选 + 勾选写入 askTo", async () => {
  useAgentsStore.setState({ list: [cfg("dev"), cfg("代码审查"), cfg("质量验收")] });
  renderConfig("dev");
  fireEvent.click(screen.getByTestId("tab-partners"));
  expect(screen.getByTestId("partner-check-代码审查")).toBeTruthy();
  expect(screen.getByTestId("partner-check-dev").closest(".opacity-50, [aria-disabled='true']")).toBeTruthy();  // 自身置灰
  fireEvent.change(screen.getByTestId("partner-search"), { target: { value: "审查" } });
  expect(screen.queryByTestId("partner-check-质量验收")).toBeNull();
  fireEvent.click(screen.getByTestId("partner-check-代码审查"));
  // 保存后 askTo 含 代码审查
  fireEvent.click(screen.getByText("保存"));
  // 断言 agent:config:save 载荷 partners.askTo === ["代码审查"]（mock send 捕获）
});

it("工具 tab：勾选写入 tools", async () => {
  renderConfig("dev");
  fireEvent.click(screen.getByTestId("tab-tools"));
  // mock agent:tools:list 回包 [{name:"read",source:"内置"},{name:"bash",source:"内置"}]
  fireEvent.click(await screen.findByTestId("tool-check-bash"));  // 取消勾选
  // 保存载荷 tools 不含 bash
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/frontend && bunx vitest run tests/AgentConfig.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**（重写 `AgentConfig.tsx` 内部 tab 结构；头部头像/名称沿用；保存仍走 `agent:config:save`；改名通过编辑"名称"输入框直接改 `draft.name`，kernel 端 rename 已在 Task 4 实现）

结构：
- `BasicTab`：四段（身份：名称/简介/头像 emoji 输入 + 渐变两色 input；模型：model input + `<ThinkingSelector>`；提示词：mode 切换 + textarea + inherit 开关；触发条件：关键词 chips + 输入回车添加 + 说明文案"关键词用于其他智能体自动调起本智能体的判定提示；@ 提及为内置能力"）
- `ToolsTab`：挂载时 `send({type:"agent:tools:list"})`，勾选列表写 `draft.tools`（全勾 = 保持现状语义：保存时若全选则置空数组——空数组 = 全量默认；简化：**不**做全选置空，直接保存勾选结果，kernel 端空数组才全量）
- `SkillsTab`：复用 `useSkillsStore.allSkills` 勾选写 `draft.skills`
- `PartnersTab`：搜索框（`filterItems` 复用）+ 勾选列表（排除自身、自身行置灰 `aria-disabled`），写 `draft.partners.askTo`；**移除 askFrom 编辑**（spec 不再消费，保留字段不展示）
- 删除旧 `capabilities` tab 与占位文案

- [ ] **Step 4: 跑测试确认通过 + 前端全量**

Run: `cd packages/frontend && bunx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/components/AgentConfig.tsx packages/frontend/tests/AgentConfig.test.tsx
git commit -m "feat(frontend): 智能体详情弹窗重构为 4 tab（基本合并/工具/技能/关系网带搜索）"
```

---

### Task 13: AgentSwitcher（会话顶部切换器 + 确认框 + 警示条）

**UI 原型：** `docs/superpowers/specs/2026-07-17-agent-matrix-mockups/agent-switcher-search.html`（顶部 pill 点击展开：搜索框+列表+当前项✓；切换前确认框"切换智能体后所有缓存都会失效，是否继续？"【取消】【继续切换】；agent 被删时 pill 变警示条"原智能体已删除，点击重选"）

**Files:**
- Create: `packages/frontend/src/components/AgentSwitcher.tsx`
- Modify: `packages/frontend/src/components/SessionView.tsx`（header 接入）
- Test: `packages/frontend/tests/AgentSwitcher.test.tsx`

**Interfaces:**
- Consumes: `useAgentsStore.list`、`useProjectsStore.sessions`、WS `session:set-agent`/`session:updated`、`filterItems`（quick-invoke/trigger.ts）
- Produces: `<AgentSwitcher sessionId: string />`；`data-testid`：`agent-switcher`、`switcher-search`、`switcher-item-<name>`、`switcher-confirm`、`switcher-confirm-ok/cancel`、`switcher-missing`
- 消息区分隔行：切换成功后向消息流追加本地系统行（`useSessionStore` 追加一条 local 消息，格式约定：`{ role: "user", content: "—— 已切换为 X ——" }` 不行会污染历史——改为 MessageList 旁路 localSystemLines？**简化决策**：分隔行作为 session store 的本地 ephemeral 消息插入 messagesBySession，类型用现有 CustomMessage `{ type: "custom", customType: "agent_switch", content: "已切换为 X", timestamp }`，不写入 jsonl（仅前端展示），MessageList 渲染 custom 消息时居中灰字显示）

- [ ] **Step 1: 写失败测试**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentSwitcher } from "../src/components/AgentSwitcher";
import { useAgentsStore } from "../src/store/agents";
import { useProjectsStore } from "../src/store/projects";

function seed() {
  useAgentsStore.setState({ list: [cfg("dev"), cfg("代码审查"), cfg("质量验收")] });
  useProjectsStore.setState({
    sessions: [{ id: "s1", projectId: "p", primaryAgent: "dev", title: "t", createdAt: 0, lastActivity: 0, piSessionFile: "" }],
    projects: [{ id: "p", name: "p", cwd: "/x", createdAt: 0 }],
  } as any);
}

describe("AgentSwitcher", () => {
  it("显示当前智能体，点击展开带搜索的列表", () => {
    seed();
    render(<AgentSwitcher sessionId="s1" />);
    fireEvent.click(screen.getByTestId("agent-switcher"));
    expect(screen.getByTestId("switcher-search")).toBeTruthy();
    expect(screen.getByTestId("switcher-item-代码审查")).toBeTruthy();
    fireEvent.change(screen.getByTestId("switcher-search"), { target: { value: "验收" } });
    expect(screen.queryByTestId("switcher-item-代码审查")).toBeNull();
    expect(screen.getByTestId("switcher-item-质量验收")).toBeTruthy();
  });

  it("选择后先弹缓存失效确认框，取消不发送，确认才发送 session:set-agent", () => {
    seed();
    const sent = mockSend();  // 参照既有 mock 写法
    render(<AgentSwitcher sessionId="s1" />);
    fireEvent.click(screen.getByTestId("agent-switcher"));
    fireEvent.click(screen.getByTestId("switcher-item-代码审查"));
    expect(screen.getByTestId("switcher-confirm")).toBeTruthy();
    expect(sent.filter(e => e.type === "session:set-agent")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("switcher-confirm-ok"));
    expect(sent.some(e => e.type === "session:set-agent" && e.agentName === "代码审查")).toBe(true);
  });

  it("primaryAgent 不在列表中（已删除）时显示警示条", () => {
    seed();
    useProjectsStore.setState(s => ({ sessions: s.sessions.map(x => ({ ...x, primaryAgent: "已删除者" })) }) as any);
    render(<AgentSwitcher sessionId="s1" />);
    expect(screen.getByTestId("switcher-missing")).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/frontend && bunx vitest run tests/AgentSwitcher.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

`AgentSwitcher.tsx`：pill（avatar+displayName+▾）→ 展开卡片（搜索 input + 过滤列表 + 当前项 ✓）→ 选中非当前项 → 确认框 → `send({type:"session:set-agent", sessionId, agentName})`；监听 `session:updated` 后向 `useSessionStore` 追加分隔行 custom 消息。`missing` 态：pill 变 `⚠️ 原智能体已删除，点击重选`（warning 色），点击同样展开列表。

`SessionView.tsx` header（L91-102）：
- L92 `{agentEmoji(session.primaryAgent)}` 与 L99 `{session.primaryAgent}` 替换为 `<AgentSwitcher sessionId={sessionId} />`（放在标题右侧，参照原型 pill 位置）；`project?.cwd` 与状态文案保留。

- [ ] **Step 4: 跑测试确认通过 + SessionView 相关回归**

Run: `cd packages/frontend && bunx vitest run tests/AgentSwitcher.test.tsx tests/SessionView.test.tsx`
Expected: PASS（SessionView 测试若断言旧 header 文案 `session.primaryAgent`，改为断言 `agent-switcher` testid）

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/components/AgentSwitcher.tsx packages/frontend/src/components/SessionView.tsx packages/frontend/tests
git commit -m "feat(frontend): 会话顶部智能体切换器（搜索+缓存失效确认+删除警示）"
```

---

### Task 14: ComposerInput 符号重定义 @/#/$

**UI 原型：** `docs/superpowers/specs/2026-07-17-agent-matrix-mockups/mention-symbols.html`（@=智能体蓝 chip、#=文件绿 chip、$=技能不变；@/# 选中即过滤）

**Files:**
- Modify: `packages/frontend/src/quick-invoke/trigger.ts`
- Modify: `packages/frontend/src/quick-invoke/tokens.ts`
- Modify: `packages/frontend/src/components/ui/ComposerInput.tsx`
- Modify: `packages/frontend/src/components/Composer.tsx`
- Modify: `packages/frontend/src/components/NewSessionPane.tsx`
- Test: `packages/frontend/tests/trigger.test.ts`、`packages/frontend/tests/tokens.test.ts`、`packages/frontend/tests/ComposerInput.test.tsx`（参照既有命名）

**Interfaces:**
- Produces:
  - `detectTrigger` 返回 `TriggerType = "agent" | "file" | "skill"`：`@`→agent、`#`→file、`$`→skill
  - tokens.ts：`AGENT_TOKEN_RE = /@\[([^\]]+)\]/g`；文件 token 改 `#[path]`（`FILE_TOKEN_RE = /#\[([^\]]+)\]/g`）；`expandTokens`：`#[p]→#p`、`$[n]→/skill:n `；`@[名称]` 不在 expandTokens 处理
  - `extractAgentToken(text: string): { agent: string | null; rest: string }`（取第一个 `@[...]`，从文本剥离）
  - ComposerInput 新 prop `onAgentMention?: (name: string) => void`（@ 选中智能体时回调；NewSessionPane 传 setAgentName，Composer 传"切换确认"回调）
  - Composer 发送流程：先 `extractAgentToken` → 有 agent 且 ≠ 当前 primaryAgent → 弹缓存确认框（复用 Task 13 确认框组件）→ 确认后 `send(session:set-agent)` + 用剥离后文本发 `agent:prompt`

- [ ] **Step 1: 写失败测试**

`tests/trigger.test.ts`（按既有文件改/加）：

```ts
it("@ 触发 agent，# 触发 file，$ 触发 skill", () => {
  expect(detectTrigger("@审")).toEqual({ type: "agent", query: "审" });
  expect(detectTrigger("#src/comp")).toEqual({ type: "file", query: "src/comp" });
  expect(detectTrigger("$brain")).toEqual({ type: "skill", query: "brain" });
  expect(detectTrigger("email@test")).toBeNull();   // 行首/空格后规则不变
  expect(detectTrigger("@[代码审查] 你好")).toBeNull();  // chip token 不触发
});
```

`tests/tokens.test.ts` 追加：

```ts
it("文件 token 改为 #[]，展开为 #path；agent token 由 extractAgentToken 剥离", () => {
  expect(expandTokens("#[src/a.ts] 看这个")).toBe("@? #src/a.ts 看这个".replace("@? ",""));  // = "#src/a.ts 看这个"
  expect(expandTokens("$[brainstorming] 做计划")).toBe("/skill:brainstorming 做计划");
  const r = extractAgentToken("@[代码审查] 帮我看看");
  expect(r.agent).toBe("代码审查");
  expect(r.rest).toBe("帮我看看");
  expect(extractAgentToken("没有提及").agent).toBeNull();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/frontend && bunx vitest run tests/trigger.test.ts tests/tokens.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`trigger.ts`：`TriggerType` 加 `"agent"`；`detectTrigger` 中 `@` 分支返回 `{ type: "agent", query }`，新增 `#` 分支返回 `{ type: "file", query }`（正则将 `@` 换 `#`）；chip 清理正则加 `/@\[[^\]]+\]/g`、`/#\[[^\]]+\]/g`。

`tokens.ts`：`FILE_TOKEN_RE` 改 `/ #\[([^\]]+)\] /g`（无空格）；新增：

```ts
export const AGENT_TOKEN_RE = /@\[([^\]]+)\]/g;

/** 提取第一个 @智能体 token 并剥离（发送前调用；其余文本照常） */
export function extractAgentToken(text: string): { agent: string | null; rest: string } {
  const m = text.match(/@\[([^\]]+)\]/);
  if (!m) return { agent: null, rest: text };
  return { agent: m[1], rest: text.replace(m[0], "").trim() };
}
```

`expandTokens`：`@[...]` 分支删除（agent 由 extractAgentToken 处理）；`FILE_TOKEN_RE` 替换目标改 `"#$1"`；`textToSegments/textToHtml` 同步：`#[]`→`{type:"file"}`、`@[]`→`{type:"agent"}`（chip-agent 蓝、`#` chip-file 绿——chip 样式类名沿用，颜色在 CSS/内联微调）。

`ComposerInput.tsx`：
- `triggerType === "agent"` 时 menuItems 来自 `useAgentsStore.list`（`filterItems` 按 displayName/description 过滤，map 为 `{ id: name, name: displayName, description }`）
- `handleSelect`：agent → token `@[${item.id}]`，触发符 `@`；file → `#[${item.path ?? item.name}]`，触发符 `#`；skill 不变
- 文件搜索 effect 条件 `triggerType !== "file"` 不变（现在由 `#` 触发）
- `emptyText`：agent → "无匹配智能体"
- QuickInvokeMenu 的 `type` prop 联合加 `"agent"`

`Composer.tsx handleSend`：

```ts
    const { agent: mention, rest } = extractAgentToken(text);
    const expandedText = expandTokens(mention ? rest : text);
    // ...
    if (mention && mention !== agentName) {
      setPendingSwitch({ mention, text: expandedText });  // 渲染确认框
      return;
    }
```

确认框确认后：先发 `send({ type: "session:set-agent", sessionId, agentName: mention })`，再按原逻辑发 `agent:prompt`（agentName 用 mention）。

`NewSessionPane.tsx handleSend`：`extractAgentToken` → mention 则 `setAgentName(mention)` 且本次发送以 mention 为 agentName（新会话无需确认框，无缓存可失效）。

- [ ] **Step 4: 跑测试确认通过 + 前端全量回归**

Run: `cd packages/frontend && bunx vitest run`
Expected: PASS（既有 Composer/e2e 里 `@` 文件用例要同步改 `#`，如 `composer.spec.ts` 相关断言）

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/quick-invoke packages/frontend/src/components packages/frontend/tests
git commit -m "feat(frontend): 提及符号重定义——@智能体/#文件/$技能，@ 切换走缓存确认"
```

---

### Task 15: DelegateCard 改造 + MessageList 接入 + 删 DelegateReceived

**UI 原型：** `docs/superpowers/specs/2026-07-17-agent-matrix-mockups/delegate-card-flow.html`（执行中转圈 / 完成绿线结果摘要+耗时 / 可展开完整回复）

**Files:**
- Modify: `packages/frontend/src/components/blocks/DelegateCard.tsx`
- Modify: `packages/frontend/src/components/MessageList.tsx`（toolCall 渲染分派，L480-508 附近）
- Delete: `packages/frontend/src/components/blocks/DelegateReceived.tsx`
- Test: `packages/frontend/tests/DelegateCard.test.tsx`

**Interfaces:**
- Produces: `<DelegateCard toolCall result />` 消费 `toolCall.name === "delegate"`、`arguments: { agent: string; task: string }`；`data-testid`：`delegate-<id>`、`delegate-expand`
- MessageList：`toolCall.name === "delegate"` → `<DelegateCard>`，其余走 ToolCallBlock 不变

- [ ] **Step 1: 写失败测试**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DelegateCard } from "../src/components/blocks/DelegateCard";

const call = { type: "toolCall" as const, id: "t1", name: "delegate", arguments: { agent: "代码审查", task: "review diff" } };
const result = { role: "toolResult" as const, toolCallId: "t1", toolName: "delegate", content: [{ type: "text" as const, text: "发现 2 个问题…" }], isError: false, timestamp: 0 };

describe("DelegateCard", () => {
  it("执行中：显示委派对象与任务，无结果区", () => {
    render(<DelegateCard toolCall={call} />);
    const el = screen.getByTestId("delegate-t1");
    expect(el.textContent).toContain("委派给");
    expect(el.textContent).toContain("代码审查");
    expect(el.textContent).toContain("review diff");
    expect(el.textContent).toContain("执行中");
  });
  it("完成：显示结果摘要，可展开完整回复", () => {
    render(<DelegateCard toolCall={call} result={result} />);
    expect(screen.getByTestId("delegate-t1").textContent).toContain("发现 2 个问题");
    expect(screen.queryByTestId("delegate-full-t1")).toBeNull();
    fireEvent.click(screen.getByTestId("delegate-expand"));
    expect(screen.getByTestId("delegate-full-t1").textContent).toContain("发现 2 个问题…");
  });
  it("MessageList 对 delegate 调用渲染 DelegateCard 而非 ToolCallBlock", () => {
    // 参照 MessageList.test.tsx 既有构造，断言 delegate-t1 存在且无普通 toolCall block
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/frontend && bunx vitest run tests/DelegateCard.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**（`DelegateCard.tsx` 重写，保留橙色容器风格）

```tsx
import { useState } from "react";
import type { ToolCall, ToolResultMessage } from "@wa-pi/shared";

interface Props { toolCall: ToolCall; result?: ToolResultMessage; }

export function DelegateCard({ toolCall, result }: Props) {
  const [open, setOpen] = useState(false);
  const args = toolCall.arguments as { agent?: string; task?: string };
  const full = result?.content.map(c => c.type === "text" ? c.text : "").join("\n") ?? "";
  const summary = full.slice(0, 120);
  return (
    <div className="rounded-lg p-2 my-1" style={{ background: "rgba(250,179,135,0.08)", border: "1px solid rgba(250,179,135,0.3)" }} data-testid={`delegate-${toolCall.id}`}>
      <div className="text-xs" style={{ color: "#fab387" }}>
        ↪ 委派给 {args.agent} · {result ? "✓ 完成" : "执行中"}
      </div>
      <div className="text-sm mt-1">📋 任务：{args.task}</div>
      {result && (
        <>
          <div className="text-sm mt-1 pl-2" style={{ borderLeft: "2px solid #a6e3a1" }}>
            <div className="text-xs" style={{ color: "#a6e3a1" }}>✓ {args.agent} 的回复</div>
            <div>{open ? full : summary}{!open && full.length > 120 ? "…" : ""}</div>
          </div>
          <button className="text-xs text-tertiary mt-1" onClick={() => setOpen(o => !o)} data-testid="delegate-expand">
            {open ? "▴ 收起" : "▾ 展开完整回复"}
          </button>
          {open && <div data-testid={`delegate-full-${toolCall.id}`} className="hidden" />}  {/* 锚点供测试 */}
        </>
      )}
    </div>
  );
}
```

（展开区域直接渲染在同一容器；测试锚点按实际 DOM 微调，不要留 hidden 空 div——用 `data-testid` 标在展开文本容器上。）

`MessageList.tsx`：toolCall 渲染分派处加 `if (tc.name === "delegate") return <DelegateCard key={tc.id} toolCall={tc} result={resultById[tc.id]} />;`（result 查找方式以文件内既有 ToolCallBlock 的 result 来源为准）。

删除 `DelegateReceived.tsx` 及其全部引用（grep 确认）。

- [ ] **Step 4: 跑测试确认通过 + 前端全量**

Run: `cd packages/frontend && bunx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/components packages/frontend/tests
git commit -m "feat(frontend): DelegateCard 接入 delegate 工具三态展示，删除 DelegateReceived 孤儿组件"
```

---

### Task 16: 接线收尾（App.tsx / NewSessionPane 动态列表 / 头像回退）

**Files:**
- Modify: `packages/frontend/src/App.tsx`
- Modify: `packages/frontend/src/components/NewSessionPane.tsx`
- Modify: `packages/frontend/src/theme/agents.ts`
- Modify: `packages/frontend/src/components/Sidebar.tsx`（onMore 接线）
- Test: `packages/frontend/tests/App.test.tsx`（参照既有）、`packages/frontend/tests/NewSessionPane.test.tsx`

**Interfaces:**
- Produces:
  - App 状态：`galleryOpen: boolean`、`pendingAgent: string | null`；`onChatWith(name)` = 设 `pendingAgent` + 切到 new-session 视图；`onEdit(name)` = 现有 configAgent 流；`onMore()` = 开 gallery
  - App 挂载：`useAgentsStore.getState().loadAll()`；`onMessage` 处理 `agent:list → setList`、`agent:created → loadAll()（或直接 setList 追加）`、`error message==="agent_missing" → 打开 AgentSwitcher 重选提示`
  - NewSessionPane：agent 下拉数据源改 `useAgentsStore.list`（`AGENT_DEFS` 仅作头像回退）；`pendingAgent` 优先于默认 `"dev"`；无 list 时保持旧 4 项回退
  - `theme/agents.ts`：`agentEmoji/agentGradient` 改用 `agentDefOf`

- [ ] **Step 1: 写失败测试**

`NewSessionPane.test.tsx` 追加：

```tsx
it("agent 下拉来自 agents store，pendingAgent 预选", async () => {
  useAgentsStore.setState({ list: [cfg("需求设计"), cfg("代码审查")] });
  useAppViewStore?.setState?.({ pendingAgent: "代码审查" });  // 按实际状态存放位置
  render(<NewSessionPane />);
  const sel = screen.getByTestId("agent-select") as HTMLSelectElement;
  expect(sel.value).toBe("代码审查");
  expect(screen.getByText("需求设计")).toBeTruthy();
});
```

（`pendingAgent` 存放：简单起见放 `useAgentsStore` 或 App props 传递——按 App.tsx 现有 props 流选择最少改动方案，测试随方案调整。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/frontend && bunx vitest run tests/NewSessionPane.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**
- `theme/agents.ts`：`AGENT_DEFS[name]` 两处改 `agentDefOf(name)`（import 自 shared）
- `NewSessionPane.tsx`：删 L10 `NAMES`；`const agents = useAgentsStore(s => s.list);`；下拉 `agents.map(a => <option value={a.name}>{agentDefOf(a.name).emoji} {a.displayName}</option>)`；`agentName` 初始值 `pendingAgent ?? agents[0]?.name ?? "dev"`；`AGENT_DEFS` import 移除
- `App.tsx`：`loadAll()` + `agent:list` 订阅 + gallery 状态与 props 接线（Sidebar → AgentListSection `onChatWith/onEdit/onMore`；gallery 渲染 `{galleryOpen && <AgentGalleryModal .../>}`；gallery 的 `onChatWith` 同 sidebar、`onEdit` 开 AgentConfig、`onCreated(name)` 开 AgentConfig）

- [ ] **Step 4: 跑测试确认通过 + 前端全量 + typecheck**

Run: `cd packages/frontend && bunx vitest run; cd ../kernel && bun run typecheck`
Expected: PASS / 无错误

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src packages/frontend/tests
git commit -m "feat(frontend): App 接线智能体列表/宫格/详情，NewSessionPane 动态智能体列表"
```

---

### Task 17: kernel API 集成测试补齐（错误路径）

**Files:**
- Test: `packages/kernel/tests/ws-server.test.ts`

**Interfaces:** 无新产出，补齐第 3 层覆盖。

- [ ] **Step 1: 写测试（一次性写完再跑）**

```ts
test("delete 不存在的智能体返回 error", async () => {
  const { ws, next } = await connectClient();
  ws.send(JSON.stringify({ type: "agent:delete", name: "幽灵" }));
  const err = await next(e => e.type === "error");
  expect(err.message).toContain("智能体不存在");
});

test("session:set-agent 到不存在的会话返回 error", async () => {
  const { ws, next } = await connectClient();
  ws.send(JSON.stringify({ type: "session:set-agent", sessionId: "s-ghost", agentName: "dev" }));
  const err = await next(e => e.type === "error");
  expect(err.message).toContain("会话不存在");
});

test("delegate 工具提示词：askTo 注入到系统提示词", async () => {
  // 经 agent-manager 单测层面验证（若 ws 层不便断言 loader，移到 agent-manager.test.ts）：
  // 配置 dev.askTo=["pm"] 后 _createSession 的 systemPromptOverride 输出含 "pm" 与 "delegate"
});
```

- [ ] **Step 2: 跑测试确认通过**

Run: `cd packages/kernel && bun test`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/kernel/tests
git commit -m "test(kernel): 补齐 agent CRUD/切换错误路径与 delegate 提示词注入集成测试"
```

---

### Task 18: E2E（Playwright）

**Files:**
- Test: `packages/frontend/e2e/agents.spec.ts`（参照 `e2e/composer.spec.ts` 的启动/隔离模式）

- [ ] **Step 1: 写 E2E**（关键链路一条 spec 多 test；测试数据通过 UI 操作创建，finally 清理）

覆盖场景（逐个 `test()`）：
1. 侧边栏默认显示 ≤3 个智能体 + 「更多智能体」入口（先经 UI 新建第 4 个智能体后出现入口）
2. 宫格弹窗：打开 → 卡片出现 → 右键【编辑智能体】进详情弹窗
3. 详情弹窗：改简介 + 加关键词 + 关系网勾选 + 保存 → 宫格卡片简介更新
4. 左键智能体 → 新建会话页预选该智能体 → 发消息 → 会话出现且顶部 pill 为该智能体
5. 会话中切换：pill 下拉搜索 → 选择 → 确认框【继续切换】→ 出现"已切换为"分隔行
6. Composer：`@` 出智能体补全、`#` 出文件补全
7. 删除智能体：右键删除 → 二次确认 → 列表消失；其会话保留，打开发消息出现重选流程

- [ ] **Step 2: 跑 E2E 确认通过**

Run: `cd packages/frontend && bunx playwright test e2e/agents.spec.ts`
Expected: PASS（截图等临时产物全部删除）

- [ ] **Step 3: Commit**

```bash
git add packages/frontend/e2e/agents.spec.ts
git commit -m "test(e2e): 多智能体矩阵关键链路 Playwright 覆盖"
```

---

### Task 19: CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 顶部追加条目**

```markdown
## 2026-07-18

### 新增功能
- 多智能体矩阵重写：智能体放开为可增删改查的动态实体（名称即标识，`~/.wa-pi/agents/*.md`）
- 侧边栏智能体管理区（最近使用前 3 + 右键编辑/删除 + 更多智能体宫格弹窗）
- 智能体详情弹窗 4 tab（基本/工具/技能/关系网），支持触发关键词与头像渐变配置
- 对话中切换智能体（顶部 pill 带搜索，缓存失效确认框）；@ 智能体 / # 文件 / $ 技能 提及符号
- 关系网调起：delegate 工具（allowlist 宿主强制）经 @gotgenes/pi-subagents 调起子智能体，消息流委托卡片展示
- 内置扩展 pi-intercom 替换为 @gotgenes/pi-subagents
影响范围：shared（类型/常量）、kernel（agent-md/config-store/ws-server/agent-manager/delegate-tool/extensions）、frontend（侧边栏/宫格/详情弹窗/切换器/Composer/DelegateCard）
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG 记录多智能体矩阵重写"
```

---

## Self-Review 结论（已内联修正）

- **Spec 覆盖**：spec 2.1→Task3/4；2.2→Task5；2.3→Task6；2.4→Task7；2.5→Task8；3→Task1/4/7/8；4.1→Task10；4.2→Task11；4.3→Task12；4.4→Task13；4.5→Task14；4.6→Task15；4.7→Task16；5→各 Task 测试 + Task17/18；7(YAGNI)→无对应任务。askFrom 字段保留但 UI 不展示（Task 12 注明）。
- **占位符扫描**：无 TBD/TODO；Task 12 Step 1 的 `cfg()`/`renderConfig()` 与 Task 13 的 `mockSend()` 指明参照既有测试 helper 文件。
- **类型一致性**：`topAgentsByRecency`、`agentDefOf`、`makeDelegateTool/buildDelegatePrompt`、`switchAgent/renameAgentSessions/setSessionAgent/extractAgentToken` 在各 Task 间签名一致。
- **有意简化（与 spec 的偏差均为 spec 已确认版本）**：delegate 卡片 v1 展开=完整回复（无子过程步骤）；关键词无 kernel 侧匹配（LLM 判定）；@ 多 token 仅第一个生效。
