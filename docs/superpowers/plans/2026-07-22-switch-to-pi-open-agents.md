# 切换到 pi-open-agents 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将子智能体执行后端从 `@gotgenes/pi-subagents`（进程内 spawn+轮询）切换到 `pi-open-agents`（子进程 runSubagent+onProgress），获得 per-agent skills/tools 配置能力和子智能体执行过程可见性。

**Architecture:** HiAgent kernel 通过 Pi SDK 的 `additionalExtensionPaths` 加载 `pi-open-agents` 扩展；delegate-tool 不再走 `getSubagentsService()` + spawn+轮询，改为直接 import `runSubagent()` 异步执行 + `onProgress` 回调推送过程事件。agent 定义文件放在 HiAgent 自己的目录 `~/.hiagent/agents/*.md`（不是 Pi 默认的 `.pi/agents/`），通过 `loadAgents({ agentDir: HIAGENT_DIR })` 发现。HiAgent 的 `config.skills`/`config.tools` 白名单映射到 `AgentDefinition` 的 `skills`/`tools` 字段。

**Tech Stack:** pi-open-agents@0.1.12、@earendil-works/pi-coding-agent（Pi SDK）、Bun + TypeScript、bun:test

## Global Constraints

- 测试框架：后端 `bun:test`，前端 `bun:test` + `@testing-library/react` + `happy-dom`
- 测试运行：`export PATH="$HOME/.bun/bin:$PATH" && bun test`
- 代码注释和沟通使用中文
- 精准修改：只碰必须改的，匹配现有风格
- 每个任务结束时 commit
- agent 定义文件目录：`~/.hiagent/agents/*.md`（HiAgent 自己的 `HIAGENT_DIR`，**不是** Pi 默认的 `~/.pi/agent/` 或 `.pi/agents/`）。通过 `loadAgents({ agentDir: HIAGENT_DIR })` 发现
- pi-open-agents 的 `runSubagent` 通过子进程执行（child_process.spawn），与当前 `@gotgenes` 的进程内模型不同
- `runSubagent` 签名：`runSubagent(options: RunSubagentOptions): Promise<AgentResult>`，options 含 `agent: AgentDefinition`、`task`、`cwd`、`signal?`、`onProgress?`
- `AgentProgress` 结构：`{ agent, status: "running"|"done"|"error", output, tools: AgentToolLog[], usage, elapsedMs, model? }`
- `AgentDefinition` 含 `name`、`description?`、`mode`、`model?`、`thinking`、`systemPrompt`、`tools?`、`skills?`、`prompt`（markdown body）、`filePath`、`source`、`maxDepth`、`hidden`、`disable`
- 公开导出（从 `pi-open-agents`）：`runSubagent`、`resolveSubagentSession`、`resolvePiEntryPoint`、`loadAgents`、`selectableAgents`、`spawnableAgents`、`agentsAvailableTo`、`resolveSkills`、`buildSubagentPrompt`、`parseAgentDefinition`、`AgentProgress`、`AgentResult`、`AgentDefinition`

---

## File Structure

| 文件 | 职责 | 操作 |
|---|---|---|
| `packages/kernel/package.json` | 依赖声明 | 修改：`@gotgenes/pi-subagents` → `pi-open-agents` |
| `packages/kernel/src/extensions.ts` | 扩展注册 | 修改：PKG_EXTENSIONS 包名 |
| `packages/kernel/src/delegate-tool.ts` | delegate/fleet 工具 + spawn 执行 | **完全重写** |
| `packages/kernel/src/subagent-runner.ts` | runSubagent 适配层 + onProgress 事件转发 | **新建** |
| `packages/kernel/src/builtin-agents.ts` | 内置 agent .md 内容 + seedBuiltinAgents | **新建** |
| `packages/kernel/src/subagent-info.ts` | 内置 subagent 信息读取 | 修改：从 .md 文件读 |
| `packages/kernel/src/agent-manager.ts` | session 创建 + delegate 工具注册 | 修改：spawn 闭包 + 过程事件转发 |
| `packages/shared/src/constants.ts` | SUBAGENT_TYPES 常量 | 修改：保留元信息（emoji/gradient/displayName），移除对 pi-subagents 内部路径的依赖 |
| `packages/kernel/tests/delegate-tool.test.ts` | delegate 工具测试 | **完全重写** |
| `~/.hiagent/agents/*.md`（运行时） | agent 定义文件目录 | 通过 `loadAgents({ agentDir: HIAGENT_DIR })` 发现，**不**用 Pi 的 `.pi/agents/` |

---

### Task 1: 安装 pi-open-agents + 移除 @gotgenes/pi-subagents

**Files:**
- Modify: `packages/kernel/package.json`

**Interfaces:**
- Produces: `pi-open-agents` 作为依赖可用，`@gotgenes/pi-subagents` 移除

- [ ] **Step 1: 安装 pi-open-agents**

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd /Users/pipi/work/HiAgent
bun add pi-open-agents --filter @hiagent/kernel
```

- [ ] **Step 2: 移除 @gotgenes/pi-subagents**

```bash
bun remove @gotgenes/pi-subagents --filter @hiagent/kernel
```

- [ ] **Step 3: 验证 package.json**

Run: `grep -E "pi-open-agents|gotgenes" packages/kernel/package.json`
Expected: 只有 `pi-open-agents`，无 `@gotgenes/pi-subagents`

- [ ] **Step 4: Commit**

```bash
git add packages/kernel/package.json bun.lock
git commit -m "chore(kernel): 替换 @gotgenes/pi-subagents → pi-open-agents"
```

---

### Task 2: 更新扩展注册

**Files:**
- Modify: `packages/kernel/src/extensions.ts:71`

**Interfaces:**
- Consumes: `pi-open-agents` 包的 `pi.extensions` 声明（`["./index.ts"]`）
- Produces: SDK 的 `additionalExtensionPaths` 含 `pi-open-agents` 路径

- [ ] **Step 1: 修改 PKG_EXTENSIONS**

```typescript
// packages/kernel/src/extensions.ts:70-74
const PKG_EXTENSIONS = [
  "pi-open-agents",
  "pi-web-access",
  "pi-mcp-adapter",
] as const;
```

- [ ] **Step 2: 修改 agent-manager.ts 的诊断日志**

```typescript
// packages/kernel/src/agent-manager.ts:396
const subagentPath = paths.find((p: string) => p.includes("pi-open-agents"));
console.log("[kernel] additionalExtensionPaths 含 pi-open-agents:", !!subagentPath, subagentPath ? subagentPath : "");
```

- [ ] **Step 3: 验证编译**

Run: `export PATH="$HOME/.bun/bin:$PATH" && cd /Users/pipi/work/HiAgent/packages/kernel && bun build src/index.ts --no-bundle 2>&1 | head -5`
Expected: 无报错（runtime 错误后续 Task 修复）

- [ ] **Step 4: Commit**

```bash
git add packages/kernel/src/extensions.ts packages/kernel/src/agent-manager.ts
git commit -m "refactor(kernel): 扩展注册从 @gotgenes/pi-subagents 改为 pi-open-agents"
```

---

### Task 3: 新建 subagent-runner.ts（runSubagent 适配层 + agent 发现）

**Files:**
- Create: `packages/kernel/src/subagent-runner.ts`

**Interfaces:**
- Consumes: `runSubagent`、`AgentDefinition`、`AgentProgress`、`loadAgents` from `pi-open-agents`
- Produces: `runSubagentAgent(config, task, cwd, opts)` 函数，返回 `DelegateSpawnResult`，支持 `onProgress` 过程回调

这是 delegate-tool 的执行核心。把 pi-open-agents 的 `runSubagent`（子进程 async）封装为 HiAgent 的 `DelegateSpawnFn` 签名，同时把 `onProgress` 事件转发给上层（用于前端过程展示）。

agent 定义文件从 `~/.hiagent/agents/*.md` 发现（通过 `loadAgents({ agentDir: HIAGENT_DIR })`），HiAgent 的 ConfigStore 配置覆盖 .md 定义里的 model/thinking/tools/skills。

- [ ] **Step 1: 写失败测试**

```typescript
// packages/kernel/tests/subagent-runner.test.ts
import { test, expect, mock } from "bun:test";
import { buildAgentDefinition, type SubagentProgressEvent, type HiAgentSpawnConfig } from "../src/subagent-runner";

test("buildAgentDefinition 从 HiAgent config 构造 AgentDefinition", () => {
  const def = buildAgentDefinition({
    name: "research",
    description: "调研",
    systemPrompt: "你是一个调研员",
    systemPromptMode: "replace",
    model: "glm-4.6",
    thinking: "medium",
    tools: ["read", "grep"],
    skills: ["brainstorming"],
  });
  expect(def.name).toBe("research");
  expect(def.description).toBe("调研");
  expect(def.prompt).toBe("你是一个调研员");
  expect(def.tools).toEqual(["read", "grep"]);
  expect(def.skills).toEqual(["brainstorming"]);
  expect(def.mode).toBe("subagent");
});

test("buildAgentDefinition 内置类型用 SUBAGENT_TYPES 元信息填充缺省值", () => {
  const def = buildAgentDefinition({
    name: "Explore",
    description: "",
    systemPrompt: "",
    systemPromptMode: "replace",
    model: null,
    thinking: null,
    tools: [],
    skills: [],
  });
  // Explore 是只读探索类型，工具集应为只读
  expect(def.name).toBe("Explore");
  expect(def.tools).toContain("read");
});

test("buildAgentDefinition config.skills 非空时白名单生效", () => {
  const def = buildAgentDefinition({
    name: "dev",
    description: "",
    systemPrompt: "",
    systemPromptMode: "replace",
    model: null,
    thinking: null,
    tools: [],
    skills: ["pdf", "brainstorming"],
  });
  expect(def.skills).toEqual(["pdf", "brainstorming"]);
});

test("buildAgentDefinition config.skills 为空时不设 skills（继承全部）", () => {
  const def = buildAgentDefinition({
    name: "dev",
    description: "",
    systemPrompt: "",
    systemPromptMode: "replace",
    model: null,
    thinking: null,
    tools: [],
    skills: [],
  });
  expect(def.skills).toBeUndefined();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `export PATH="$HOME/.bun/bin:$PATH" && cd /Users/pipi/work/HiAgent/packages/kernel && bun test tests/subagent-runner.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 subagent-runner.ts**

```typescript
// packages/kernel/src/subagent-runner.ts
import { runSubagent } from "pi-open-agents";
import type { AgentDefinition, AgentProgress, AgentResult } from "pi-open-agents";
import type { ThinkingLevel } from "@hiagent/shared";
import { SUBAGENT_TYPES, isSubagentType } from "@hiagent/shared";

/** HiAgent 侧的 agent 配置片段（从 AgentConfig 提取） */
export interface HiAgentSpawnConfig {
  name: string;
  description: string;
  systemPrompt: string;
  systemPromptMode: "replace" | "append";
  model: string | null;
  thinking: ThinkingLevel | null;
  tools: string[];
  skills: string[];
}

/** 过程事件：转发给 agent-manager → WS → 前端 */
export interface SubagentProgressEvent {
  agent: string;
  status: "running" | "done" | "error";
  output: string;
  tools: Array<{ id: string; name: string; status: string }>;
  elapsedMs: number;
}

/** 执行结果（与 delegate-tool 的 DelegateSpawnResult 对齐） */
export interface SubagentRunResult {
  text: string;
  isError: boolean;
}

/** thinking → pi-open-agents thinkingLevel 映射 */
function mapThinking(thinking: ThinkingLevel | null): string {
  if (!thinking) return "medium";
  return thinking === "disabled" ? "off"
    : thinking === "max" ? "xhigh"
    : thinking;
}

/**
 * 从 HiAgent config 构造 pi-open-agents 的 AgentDefinition。
 * 内置 subagent 类型（general-purpose/Explore/Plan）用 SUBAGENT_TYPES 元信息补全。
 *
 * config.skills / config.tools 白名单在此映射到 AgentDefinition：
 * - 非空数组 = 按白名单限定（skills 支持通配符，由 pi-open-agents resolveSkills 处理）
 * - 空数组 = undefined（不设字段 = 继承全部，pi-open-agents 默认行为）
 */
export function buildAgentDefinition(config: HiAgentSpawnConfig): AgentDefinition {
  // 内置类型从 SUBAGENT_TYPES 补全工具/提示词缺省值
  const builtin = isSubagentType(config.name)
    ? SUBAGENT_TYPES.find(t => t.name === config.name)
    : undefined;

  const tools = config.tools.length > 0
    ? config.tools
    : builtin?.readOnly
      ? ["read", "bash", "grep", "find", "ls"]
      : undefined; // undefined = 全量工具（AgentDefinition 不设 tools 字段）

  // skills：非空数组 = 白名单限定；空数组 = undefined（继承全部）
  const skills = config.skills.length > 0 ? config.skills : undefined;

  return {
    name: config.name,
    description: config.description || builtin?.description || "",
    mode: "subagent",
    hidden: false,
    disable: false,
    model: config.model ?? undefined,
    thinking: mapThinking(config.thinking) as any,
    systemPrompt: config.systemPromptMode,
    prompt: config.systemPrompt,
    tools,
    skills,
    maxDepth: 3,
    filePath: "",
    source: "project" as any,
  } as AgentDefinition;
}

/**
 * 执行子智能体：调用 pi-open-agents runSubagent（子进程）。
 * onProgress 回调实时转发工具调用/文本输出/用量。
 * 所有失败路径收敛为 { text, isError:true }，绝不 throw。
 */
export async function runSubagentAgent(
  config: HiAgentSpawnConfig,
  task: string,
  cwd: string,
  opts?: {
    signal?: AbortSignal;
    onProgress?: (event: SubagentProgressEvent) => void;
  },
): Promise<SubagentRunResult> {
  const agentDef = buildAgentDefinition(config);

  try {
    const result: AgentResult = await runSubagent({
      agent: agentDef,
      task,
      cwd,
      signal: opts?.signal,
      onProgress: opts?.onProgress
        ? (progress: AgentProgress) => {
            opts.onProgress!({
              agent: progress.agent,
              status: progress.status,
              output: progress.output,
              tools: progress.tools.map(t => ({ id: t.id, name: t.name, status: t.status })),
              elapsedMs: progress.elapsedMs,
            });
          }
        : undefined,
    });

    return {
      text: result.output || "（子智能体无输出）",
      isError: result.isError,
    };
  } catch (err) {
    return {
      text: `子智能体执行失败: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `export PATH="$HOME/.bun/bin:$PATH" && cd /Users/pipi/work/HiAgent/packages/kernel && bun test tests/subagent-runner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/subagent-runner.ts packages/kernel/tests/subagent-runner.test.ts
git commit -m "feat(kernel): 新建 subagent-runner——pi-open-agents runSubagent 适配层"
```

---

### Task 4: 重写 delegate-tool.ts（移除 spawn+轮询，改用 runSubagentAgent）

**Files:**
- Modify: `packages/kernel/src/delegate-tool.ts`（完全重写 spawn 闭包部分）
- Test: `packages/kernel/tests/delegate-tool.test.ts`

**Interfaces:**
- Consumes: `runSubagentAgent`、`HiAgentSpawnConfig`、`SubagentProgressEvent` from `./subagent-runner`
- Produces: `spawnViaRunner(config, task, cwd, opts)` 替代 `spawnViaSubagentsService`

delegate/fleet 工具的外壳（canInvoke / makeDelegateTool / makeFleetTool / buildDelegatePrompt）**保持不变**，只重写 spawn 执行闭包。

- [ ] **Step 1: 写失败测试**

```typescript
// packages/kernel/tests/delegate-tool.test.ts（新增测试，先写核心 spawn 闭包测试）
import { test, expect, mock } from "bun:test";
import { makeDelegateTool, type DelegateSpawnFn } from "../src/delegate-tool";

test("makeDelegateTool 调起合法智能体返回 spawn 结果", async () => {
  const spawn = mock<(agent: string, task: string) => Promise<{ text: string; isError: boolean }>>();
  spawn.mockResolvedValue({ text: "调研完成", isError: false });
  const tool = makeDelegateTool({
    askTo: [{ name: "research", description: "调研" }],
    spawn: spawn as DelegateSpawnFn,
  });
  const result = await tool.execute("call-1", { agent: "research", task: "调研 X" });
  expect(result.content[0].text).toBe("调研完成");
  expect(result.isError).toBe(false);
  expect(spawn).toHaveBeenCalledWith("research", "调研 X");
});

test("makeDelegateTool 越权调起返回错误", async () => {
  const spawn = mock<(agent: string, task: string) => Promise<{ text: string; isError: boolean }>>();
  const tool = makeDelegateTool({
    askTo: [{ name: "research", description: "调研" }],
    spawn: spawn as DelegateSpawnFn,
  });
  const result = await tool.execute("call-1", { agent: "unknown", task: "X" });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("不在可调起列表中");
  expect(spawn).not.toHaveBeenCalled();
});

test("makeDelegateTool 内置 subagent 类型始终可调起", async () => {
  const spawn = mock<(agent: string, task: string) => Promise<{ text: string; isError: boolean }>>();
  spawn.mockResolvedValue({ text: "done", isError: false });
  const tool = makeDelegateTool({
    askTo: [],
    spawn: spawn as DelegateSpawnFn,
  });
  const result = await tool.execute("call-1", { agent: "Explore", task: "搜索" });
  expect(result.isError).toBe(false);
  expect(spawn).toHaveBeenCalledWith("Explore", "搜索");
});

test("makeFleetTool 并行调起多个子智能体，按输入顺序聚合", async () => {
  const spawn = mock<(agent: string, task: string) => Promise<{ text: string; isError: boolean }>>();
  spawn.mockImplementation(async (agent) => ({ text: `${agent} 结果`, isError: false }));
  const tool = makeFleetTool({
    askTo: [{ name: "a", description: "" }, { name: "b", description: "" }],
    spawn: spawn as DelegateSpawnFn,
  });
  const result = await tool.execute("call-1", {
    tasks: [
      { agent: "a", task: "ta" },
      { agent: "b", task: "tb" },
    ],
  });
  expect(result.content[0].text).toContain("【a】");
  expect(result.content[0].text).toContain("【b】");
  expect(result.isError).toBe(false);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `export PATH="$HOME/.bun/bin:$PATH" && cd /Users/pipi/work/HiAgent/packages/kernel && bun test tests/delegate-tool.test.ts`
Expected: 部分 FAIL（旧测试因 spawnViaSubagentsService 移除断言变化）

- [ ] **Step 3: 重写 delegate-tool.ts**

保留文件头部的 import 和类型定义（DelegateTarget / DelegateSpawnResult / DelegateSpawnFn / canInvoke / buildNotAllowedMessage / buildDelegatePrompt / makeDelegateTool / makeFleetTool），**移除**以下部分：
- `SubagentServiceLike` 接口
- `waitSubagentResult` 函数
- `createExtensionApiStub` 函数
- `SpawnOpts` 接口
- `mapThinkingToLevel` 函数
- `spawnViaSubagentsService` 函数

替换为新的 spawn 闭包工厂：

```typescript
// packages/kernel/src/delegate-tool.ts —— 保留外壳，替换 spawn 闭包
// 移除旧的 import { createRequire } / { dirname, join } / getSubagentOverride 等
// 这些不再需要（runSubagent 不走 service 单例）

import { Type } from "typebox";
import { isSubagentType, SUBAGENT_TYPES, normalizeSubagentType } from "@hiagent/shared";
import type { HiAgentSpawnConfig, SubagentProgressEvent } from "./subagent-runner";
import { runSubagentAgent } from "./subagent-runner";

// ... DelegateTarget / DelegateSpawnResult / DelegateSpawnFn / canInvoke /
//     buildNotAllowedMessage / DelegateParamsSchema / makeDelegateTool /
//     buildDelegatePrompt / FleetParamsSchema / runWithConcurrency / makeFleetTool
//     保持不变（这些不依赖 spawn 实现方式）...

/**
 * spawn 闭包工厂：绑定 HiAgent config + cwd + 过程回调，
 * 调用 subagent-runner 的 runSubagentAgent 执行子智能体。
 *
 * config 由 agent-manager 从 AgentConfig 提取（name/description/systemPrompt/model/thinking/tools/skills）。
 * onProgress 回调实时转发子智能体执行过程（工具调用/文本输出），用于前端过程展示。
 */
export function makeSpawnFn(opts: {
  resolveConfig: (agentName: string) => Promise<HiAgentSpawnConfig | null>;
  cwd: string;
  signal?: AbortSignal;
  onProgress?: (event: SubagentProgressEvent) => void;
}): DelegateSpawnFn {
  return async (agent: string, task: string) => {
    const config = await opts.resolveConfig(agent);
    if (!config) {
      return { text: `智能体「${agent}」配置未找到`, isError: true };
    }
    return runSubagentAgent(config, task, opts.cwd, {
      signal: opts.signal,
      onProgress: opts.onProgress,
    });
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `export PATH="$HOME/.bun/bin:$PATH" && cd /Users/pipi/work/HiAgent/packages/kernel && bun test tests/delegate-tool.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/delegate-tool.ts packages/kernel/tests/delegate-tool.test.ts
git commit -m "refactor(kernel): delegate-tool 移除 spawn+轮询，改用 runSubagentAgent"
```

---

### Task 5: 内置智能体迁移为 ~/.hiagent/agents/*.md 定义文件

**Files:**
- Create: `packages/kernel/src/builtin-agents.ts`（内置 agent .md 内容 + seedDefaults）
- Modify: `packages/kernel/src/agent-manager.ts`（启动时调 seedBuiltinAgents）
- Test: `packages/kernel/tests/builtin-agents.test.ts`

**Interfaces:**
- Consumes: `SUBAGENT_TYPES` from `@hiagent/shared`（emoji/gradient/displayName 元信息）
- Produces: `seedBuiltinAgents(agentsDir)` 函数，在 `~/.hiagent/agents/` 写入三个 .md 文件；`loadBuiltinAgentDefs()` 返回内置 AgentDefinition（供 resolveSpawnConfig 使用）

切换前内置类型（general-purpose/Explore/Plan）的 systemPrompt 在 `@gotgenes/pi-subagents` 的 `default-agents.ts` 里硬编码。切换后改为 `~/.hiagent/agents/*.md` 定义文件，由 kernel 启动时 seedDefaults 写入（同 `~/.hiagent/agents/<命名智能体>.md` 的 seedDefaults 机制）。.md 文件用户可覆盖。

- [ ] **Step 1: 写失败测试**

```typescript
// packages/kernel/tests/builtin-agents.test.ts
import { test, expect } from "bun:test";
import { readdirSync, readFileSync, rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { seedBuiltinAgents, BUILTIN_AGENT_CONTENT } from "../src/builtin-agents";

test("BUILTIN_AGENT_CONTENT 含三个内置类型", () => {
  expect(BUILTIN_AGENT_CONTENT["general-purpose"]).toBeDefined();
  expect(BUILTIN_AGENT_CONTENT["Explore"]).toBeDefined();
  expect(BUILTIN_AGENT_CONTENT["Plan"]).toBeDefined();
});

test("Explore .md 含只读提示词 + read-only 工具集", () => {
  const md = BUILTIN_AGENT_CONTENT["Explore"];
  expect(md).toContain("READ-ONLY MODE");
  expect(md).toContain("tools: read, bash, grep, find, ls");
});

test("Plan .md 含架构师提示词 + read-only 工具集", () => {
  const md = BUILTIN_AGENT_CONTENT["Plan"];
  expect(md).toContain("software architect");
  expect(md).toContain("tools: read, bash, grep, find, ls");
});

test("general-purpose .md 无 tools 白名单（继承全部）", () => {
  const md = BUILTIN_AGENT_CONTENT["general-purpose"];
  // general-purpose 不设 tools 字段 = 全量工具
  expect(md).not.toMatch(/^tools:/m);
});

test("seedBuiltinAgents 写入三个 .md 文件", () => {
  const tmpDir = `/tmp/hiagent-test-agents-${Date.now()}`;
  mkdirSync(tmpDir, { recursive: true });
  seedBuiltinAgents(tmpDir);
  const files = readdirSync(tmpDir).filter(f => f.endsWith(".md")).sort();
  expect(files).toEqual(["Explore.md", "Plan.md", "general-purpose.md"].sort());
  // 已存在文件不覆盖
  rmSync(tmpDir, { recursive: true });
});

test("seedBuiltinAgents 已存在的文件不覆盖", () => {
  const tmpDir = `/tmp/hiagent-test-agents-keep-${Date.now()}`;
  mkdirSync(tmpDir, { recursive: true });
  // 先写一个自定义的 Explore.md
  const customContent = "---\nname: Explore\ndescription: 我的自定义探索\n---\n自定义提示词";
  writeFileSync(join(tmpDir, "Explore.md"), customContent);
  seedBuiltinAgents(tmpDir);
  const after = readFileSync(join(tmpDir, "Explore.md"), "utf-8");
  expect(after).toBe(customContent);
  rmSync(tmpDir, { recursive: true });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `export PATH="$HOME/.bun/bin:$PATH" && cd /Users/pipi/work/HiAgent/packages/kernel && bun test tests/builtin-agents.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 builtin-agents.ts**

```typescript
// packages/kernel/src/builtin-agents.ts
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 内置 subagent 的 agent.md 定义内容（frontmatter + 提示词正文）。
 *
 * 提示词从 @gotgenes/pi-subagents 的 default-agents.ts 迁移而来，
 * 切换到 pi-open-agents 后不再依赖包内部源码，改为本地 .md 文件。
 * 用户可在 ~/.hiagent/agents/ 覆盖同名文件自定义。
 */
export const BUILTIN_AGENT_CONTENT: Record<string, string> = {
  "general-purpose": `---
name: general-purpose
description: 继承调用者的全部工具，执行复杂多步任务。
mode: subagent
systemPrompt: append
thinking: medium
---

General-purpose agent for complex, multi-step tasks.`,

  "Explore": `---
name: Explore
description: 只读代码探索，快速搜索和理解代码库结构。
mode: subagent
systemPrompt: replace
thinking: medium
tools: read, bash, grep, find, ls
---

# CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS
You are a file search specialist. You excel at thoroughly navigating and exploring codebases.
Your role is EXCLUSIVELY to search and analyze existing code. You do NOT have access to file editing tools.

You are STRICTLY PROHIBITED FROM:
- Creating new files
- Modifying existing files
- Deleting files
- Moving or copying files
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

Use Bash ONLY for read-only operations: ls, git status, git log, git diff, find, cat, head, tail.

# Tool Usage
- Use the find tool for file pattern matching (NOT the bash find command)
- Use the grep tool for content search (NOT bash grep/rg command)
- Use the read tool for reading files (NOT bash cat/head/tail)
- Use Bash ONLY for read-only operations
- Make independent tool calls in parallel for efficiency
- Adapt search approach based on thoroughness level specified

# Output
- Use absolute file paths in all references
- Report findings as regular messages
- Do not use emojis
- Be thorough and precise`,

  "Plan": `---
name: Plan
description: 只读代码架构师，探索代码库并设计实施方案。
mode: subagent
systemPrompt: replace
thinking: medium
tools: read, bash, grep, find, ls
---

# CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS
You are a software architect and planning specialist.
Your role is EXCLUSIVELY to explore the codebase and design implementation plans.
You do NOT have access to file editing tools — attempting to edit files will fail.

You are STRICTLY PROHIBITED FROM:
- Creating new files
- Modifying existing files
- Deleting files
- Moving or copying files
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

# Planning Process
1. Understand requirements
2. Explore thoroughly (read files, find patterns, understand architecture)
3. Design solution based on your assigned perspective
4. Detail the plan with step-by-step implementation strategy

# Requirements
- Consider trade-offs and architectural decisions
- Identify dependencies and sequencing
- Anticipate potential challenges
- Follow existing patterns where appropriate

# Tool Usage
- Use the find tool for file pattern matching (NOT the bash find command)
- Use the grep tool for content search (NOT bash grep/rg command)
- Use the read tool for reading files (NOT bash cat/head/tail)
- Use Bash ONLY for read-only operations

# Output Format
- Use absolute file paths
- Do not use emojis
- End your response with:

### Critical Files for Implementation
List 3-5 files most critical for implementing this plan:
- /absolute/path/to/file.ts - [Brief reason]`,
};

/**
 * 在 agentsDir 写入内置 agent 定义文件（~/.hiagent/agents/*.md）。
 * 已存在的同名文件不覆盖（用户自定义优先）。
 */
export function seedBuiltinAgents(agentsDir: string): void {
  mkdirSync(agentsDir, { recursive: true });
  for (const [name, content] of Object.entries(BUILTIN_AGENT_CONTENT)) {
    const filePath = join(agentsDir, `${name}.md`);
    if (!existsSync(filePath)) {
      writeFileSync(filePath, content, "utf-8");
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `export PATH="$HOME/.bun/bin:$PATH" && cd /Users/pipi/work/HiAgent/packages/kernel && bun test tests/builtin-agents.test.ts`
Expected: PASS

- [ ] **Step 5: agent-manager 启动时调 seedBuiltinAgents**

在 `packages/kernel/src/agent-manager.ts` 的 `ensureStarted` 或构造时调用：

```typescript
import { seedBuiltinAgents } from "./builtin-agents";
import { join } from "node:path";

// 在 _createSession 或 ensureStarted 的初始化阶段调用：
const agentsDir = join(HIAGENT_DIR, "agents");
seedBuiltinAgents(agentsDir);
```

- [ ] **Step 6: Commit**

```bash
git add packages/kernel/src/builtin-agents.ts packages/kernel/tests/builtin-agents.test.ts packages/kernel/src/agent-manager.ts
git commit -m "feat(kernel): 内置智能体迁移为 ~/.hiagent/agents/*.md 定义文件"
```

---

### Task 6: agent-manager 接入新 spawn 闭包 + config.skills/tools 传递

**Files:**
- Modify: `packages/kernel/src/agent-manager.ts:368-381`

**Interfaces:**
- Consumes: `makeSpawnFn` from `./delegate-tool`、`HiAgentSpawnConfig` from `./subagent-runner`
- Produces: delegate/fleet 工具绑定新 spawn 闭包，config.skills/tools 白名单传入子智能体

这是让 `config.skills` 和 `config.tools` 真正生效的关键接入点。

- [ ] **Step 1: 修改 delegate 工具注册（agent-manager.ts:378-381）**

将原来的：
```typescript
const delegateTools = [
  makeDelegateTool({ askTo: askToTargets, spawn: spawnViaSubagentsService }),
  makeFleetTool({ askTo: askToTargets, spawn: spawnViaSubagentsService }),
];
```

替换为：
```typescript
import { makeSpawnFn } from "./delegate-tool";
import type { HiAgentSpawnConfig } from "./subagent-runner";

// resolveConfig：优先从 ConfigStore 读 HiAgent 配置（用户在 UI 设置的 model/thinking/tools/skills），
// 内置 subagent 类型不在 store 里——从 ~/.hiagent/agents/*.md 定义文件加载 systemPrompt（Task 5 seedBuiltinAgents 写入）。
// config.skills / config.tools 白名单在此传入子智能体（之前从未被消费的死字段，现在生效）。
const resolveSpawnConfig = async (agentName: string): Promise<HiAgentSpawnConfig | null> => {
  // 内置 subagent 类型：从 ~/.hiagent/agents/*.md 读定义（含 systemPrompt）
  if (isSubagentType(agentName)) {
    const builtin = SUBAGENT_TYPES.find(t => t.name === agentName);
    if (builtin) {
      // 从 seedBuiltinAgents 写入的 .md 文件读取 systemPrompt（用户可覆盖）
      const { loadAgents } = await import("pi-open-agents");
      const { agents } = await loadAgents({ agentDir: HIAGENT_DIR });
      const agentDef = agents.find(a => a.name === agentName);
      return {
        name: builtin.name,
        description: builtin.description,
        systemPrompt: agentDef?.prompt ?? "",
        systemPromptMode: (agentDef?.systemPrompt as any) ?? "replace",
        model: null,
        thinking: null,
        tools: builtin.readOnly ? ["read", "bash", "grep", "find", "ls"] : [],
        skills: [],
      };
    }
  }
  // 命名智能体：从 ConfigStore 读配置
  const cfg = await this.opts.configStore?.getAgent(agentName).catch(() => null);
  if (!cfg) return null;
  return {
    name: cfg.displayName,
    description: cfg.description,
    systemPrompt: cfg.systemPromptBody ?? "",
    systemPromptMode: cfg.systemPromptMode,
    model: cfg.model,
    thinking: cfg.thinking,
    tools: cfg.tools,     // ← 白名单生效（空=全量默认）
    skills: cfg.skills,   // ← 白名单生效（空=继承全部）
  };
};

const spawnFn = makeSpawnFn({
  resolveConfig: resolveSpawnConfig,
  cwd,
});

const delegateTools = [
  makeDelegateTool({ askTo: askToTargets, spawn: spawnFn }),
  makeFleetTool({ askTo: askToTargets, spawn: spawnFn }),
];
```

- [ ] **Step 2: 移除旧的 spawnViaSubagentsService import**

删除 agent-manager.ts 顶部对 `spawnViaSubagentsService` 的 import（如果有）。

- [ ] **Step 3: 验证编译**

Run: `export PATH="$HOME/.bun/bin:$PATH" && cd /Users/pipi/work/HiAgent/packages/kernel && bun build src/index.ts --no-bundle 2>&1 | head -10`
Expected: 无 "Cannot find module" 或类型错误

- [ ] **Step 4: Commit**

```bash
git add packages/kernel/src/agent-manager.ts
git commit -m "feat(kernel): agent-manager 接入 runSubagentAgent，config.skills/tools 白名单传入子智能体"
```

---

### Task 7: 移除 inheritSkills 死字段

**Files:**
- Modify: `packages/shared/src/types.ts:47`
- Modify: `packages/kernel/src/agent-md.ts:81,106,141`
- Modify: `packages/frontend/src/components/AgentConfig.tsx:49`
- Test: 所有含 `inheritSkills` 字面量的测试文件

**Interfaces:**
- Produces: `AgentConfig` 接口不再有 `inheritSkills` 字段

- [ ] **Step 1: 移除类型定义**

```typescript
// packages/shared/src/types.ts:46-48
// 删除 inheritSkills 行
  systemPromptMode: "replace" | "append";
  tools: string[];
```

- [ ] **Step 2: 移除 agent-md.ts 序列化**

parse（移除 `inheritSkills: Boolean(y.inheritSkills),`）、stringify（移除 `fm.push(\`inheritSkills: ${c.inheritSkills}\`);`）、makeDefault（移除 `inheritSkills: true,`）。

- [ ] **Step 3: 移除前端 AgentConfig.tsx 内置 draft 的 inheritSkills**

```typescript
// packages/frontend/src/components/AgentConfig.tsx:48-49
      systemPromptMode: "replace",
      // inheritSkills: false,  ← 删除此行
```

- [ ] **Step 4: 批量清理测试字面量**

```bash
find packages/frontend/tests packages/frontend/e2e packages/shared/tests packages/kernel/tests \
  -maxdepth 1 -type f \( -name "*.ts" -o -name "*.tsx" \) \
  -exec grep -l "inheritSkills" {} \; | while read f; do
    sed -i '' -E 's/[[:space:]]*inheritSkills:[[:space:]]*(true|false),//g; s/,[[:space:]]*inheritSkills:[[:space:]]*(true|false)//g' "$f"
    echo "cleaned: $f"
  done
# 多行模板字符串里的 inheritSkills 行
for f in packages/kernel/tests/agent-md.test.ts packages/kernel/tests/steer-queue-poc.test.ts \
         packages/kernel/tests/sdk-e2e.test.ts packages/kernel/tests/sdk-integration.test.ts \
         packages/frontend/e2e/global-setup.ts; do
  sed -i '' '/^[[:space:]]*inheritSkills:/d' "$f"
done
```

- [ ] **Step 5: 验证无残留**

Run: `grep -rn "inheritSkills" packages/*/src packages/*/tests packages/shared --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v "/ws-cfg" | grep -v "/dist/"`
Expected: 无输出

- [ ] **Step 6: 运行测试**

Run: `export PATH="$HOME/.bun/bin:$PATH" && cd /Users/pipi/work/HiAgent && bun test packages/shared/tests/types.test.ts packages/kernel/tests/agent-md.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: 移除死字段 inheritSkills"
```

---

### Task 8: 更新 subagent-info.ts（从 pi-open-agents 读内置 agent 信息）

**Files:**
- Modify: `packages/kernel/src/subagent-info.ts`

**Interfaces:**
- Consumes: `SUBAGENT_TYPES` from `@hiagent/shared`（元信息仍在）
- Produces: `getSubagentInfo` 返回内置 subagent 的 systemPrompt/builtinToolNames（从 SUBAGENT_TYPES 常量读，不再从 pi-subagents 内部源码 import）

- [ ] **Step 1: 重写 loadPiDefaultAgents**

```typescript
// packages/kernel/src/subagent-info.ts
// 移除 createRequire / dirname / join import 和 loadPiDefaultAgents 的 dynamic import 逻辑
// 内置 subagent 的 systemPrompt/builtinToolNames 现在从 SUBAGENT_TYPES 常量直接读

import { SUBAGENT_TYPES } from "@hiagent/shared";
import type { SubagentInfo, SubagentOverride } from "@hiagent/shared";

/** 内置 subagent 元信息（systemPrompt/builtinToolNames 写在 SUBAGENT_TYPES 常量里） */
export async function getSubagentInfo(overrides: SubagentOverride[]): Promise<SubagentInfo[]> {
  return SUBAGENT_TYPES.map(t => ({
    name: t.name,
    displayName: t.displayName,
    description: t.description,
    emoji: t.emoji,
    gradient: t.gradient,
    readOnly: t.readOnly,
    systemPrompt: "",  // pi-open-agents 的 systemPrompt 在 .md 文件里，此处不再从包内部读取
    builtinToolNames: t.readOnly ? ["read", "bash", "grep", "find", "ls"] : [],
    override: overrides.find(o => o.type === t.name),
  }));
}
```

注意：SUBAGENT_TYPES 需要确认是否已有 systemPrompt 字段。如果没有，systemPrompt 返回空串（前端 AgentConfig 展示只读详情时，可以后续从 `~/.hiagent/agents/*.md` 读）。

- [ ] **Step 2: 运行测试**

Run: `export PATH="$HOME/.bun/bin:$PATH" && cd /Users/pipi/work/HiAgent && bun test packages/kernel/tests/ --grep "subagent" 2>&1 | tail -10`
Expected: PASS（或因 mock 变化需更新测试）

- [ ] **Step 3: Commit**

```bash
git add packages/kernel/src/subagent-info.ts
git commit -m "refactor(kernel): subagent-info 不再 import pi-subagents 内部源码"
```

---

### Task 9: 运行全套测试 + 修复回归

**Files:**
- 可能涉及多个测试文件

- [ ] **Step 1: 运行 kernel 全套测试**

Run: `export PATH="$HOME/.bun/bin:$PATH" && cd /Users/pipi/work/HiAgent/packages/kernel && bun test 2>&1 | tail -20`
Expected: 记录所有 FAIL

- [ ] **Step 2: 运行 shared 全套测试**

Run: `export PATH="$HOME/.bun/bin:$PATH" && cd /Users/pipi/work/HiAgent/packages/shared && bun test 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 3: 运行 frontend 全套测试**

Run: `export PATH="$HOME/.bun/bin:$PATH" && cd /Users/pipi/work/HiAgent/packages/frontend && bun test 2>&1 | tail -15`
Expected: 记录所有 FAIL

- [ ] **Step 4: 逐个修复 FAIL 测试**

每个 FAIL 测试：读错误信息 → 修改测试断言以适配新 API → 重跑确认 PASS。

常见预期变化：
- `spawnViaSubagentsService` 相关测试 → 改为测 `makeSpawnFn` + mock `runSubagentAgent`
- `waitSubagentResult` 相关测试 → 删除（函数已移除）
- `getSubagentsService` 相关测试 → 删除（不再使用）

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test: 修复 pi-open-agents 切换后的测试回归"
```

---

### Task 10: 更新 CHANGELOG + 最终验证

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 更新 CHANGELOG**

在 `## 2026-07-22` 顶部追加：

```markdown
### 重构
- **子智能体执行后端从 @gotgenes/pi-subagents 切换到 pi-open-agents**：获得 per-agent skills/tools 白名单配置能力（config.skills/config.tools 死字段正式生效）+ 子智能体执行过程可见性（onProgress 回调：工具调用/文本输出/用量实时推送）。架构变化：进程内 spawn+轮询 → 子进程 runSubagent+AbortSignal。内置智能体（general-purpose/Explore/Plan）的 systemPrompt 从包内部硬编码迁移为 `~/.hiagent/agents/*.md` 定义文件（用户可覆盖），agent 定义目录统一在 HiAgent 自己的 `~/.hiagent/agents/`。delegate-tool 完全重写（移除 SubagentServiceLike/waitSubagentResult/spawnViaSubagentsService，新增 makeSpawnFn + subagent-runner 适配层 + builtin-agents 种子文件）。移除死字段 inheritSkills。影响范围：kernel/{delegate-tool,subagent-runner(新),builtin-agents(新),subagent-info,agent-manager,extensions}.ts、shared/{types,constants}.ts、frontend/AgentConfig.tsx。
```

- [ ] **Step 2: 全量测试最终验证**

Run: `export PATH="$HOME/.bun/bin:$PATH" && cd /Users/pipi/work/HiAgent && bun test --path-ignore-patterns "**/e2e/**" 2>&1 | tail -10`
Expected: 除预先存在的 flaky 测试外全部 PASS

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG 记录 pi-open-agents 切换"
```

---

## 第二部分：per-agent MCP 服务器白名单

以下 Task 独立于 pi-open-agents 切换，可在当前 `@gotgenes` 架构上直接实现。

---

### Task 11: resolveAgentTools 增加 MCP server 白名单过滤

**Files:**
- Modify: `packages/shared/src/constants.ts:168-197`
- Modify: `packages/kernel/src/agent-manager.ts:437-446`
- Test: `packages/shared/tests/constants.test.ts`（或 inline test）

**Interfaces:**
- Consumes: `config.mcpServers: string[]`（agent 配置里的 MCP server 白名单，空=全部放行）
- Produces: `resolveAgentTools` 新增 `allowedMcpServers?: string[]` 参数；agent-manager 从 config.mcpServers 传入

**MCP 工具命名规则**（pi-mcp-adapter 的 `formatToolName`）：
- directTools 开启的服务器：工具名 = `<serverPrefix>_<toolName>`，serverPrefix = `serverName.replace(/-/g, "_")`
- directTools 未开启的服务器：只有统一的 `mcp` proxy 工具（通过 `mcp({ tool, server })` 调用）
- 前缀模式默认 `"server"`

- [ ] **Step 1: 写失败测试**

```typescript
// packages/shared/tests/constants.test.ts（追加到现有测试文件）
import { resolveAgentTools } from "../src/constants";

test("resolveAgentTools: mcpServers 白名单过滤 harvestedTools 中的 MCP 工具", () => {
  // harvestedTools 含 3 个 MCP direct tool + 1 个普通工具
  const harvested = [
    "playwright_browser_navigate",   // server: playwright
    "playwright_browser_click",      // server: playwright
    "github_create_issue",           // server: github
    "read",                          // 普通 builtin 工具
  ];
  // 白名单只允许 playwright server
  const result = resolveAgentTools(
    [], new Set(), undefined, {}, harvested,
    { allowedMcpServers: ["playwright"] },
  );
  expect(result).toContain("playwright_browser_navigate");
  expect(result).toContain("playwright_browser_click");
  expect(result).not.toContain("github_create_issue");
  // 非 MCP 工具不受影响
  expect(result).toContain("read");
});

test("resolveAgentTools: mcpServers 为空/不传 = 全部放行（向后兼容）", () => {
  const harvested = ["playwright_browser_navigate", "github_create_issue", "read"];
  const result = resolveAgentTools([], new Set(), undefined, {}, harvested);
  expect(result).toContain("playwright_browser_navigate");
  expect(result).toContain("github_create_issue");
});

test("resolveAgentTools: server 名含连字符时按 _ 前缀匹配", () => {
  // server "my-server" → 前缀 "my_server"
  const harvested = ["my_server_tool1", "other_tool2"];
  const result = resolveAgentTools(
    [], new Set(), undefined, {}, harvested,
    { allowedMcpServers: ["my-server"] },
  );
  expect(result).toContain("my_server_tool1");
  expect(result).not.toContain("other_tool2");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `export PATH="$HOME/.bun/bin:$PATH" && cd /Users/pipi/work/HiAgent/packages/shared && bun test tests/constants.test.ts -t "mcpServers"`
Expected: FAIL — `allowedMcpServers` 参数不存在

- [ ] **Step 3: 修改 resolveAgentTools 增加 allowedMcpServers 参数**

```typescript
// packages/shared/src/constants.ts:168-197
// 新增第 6 个参数 opts（含 allowedMcpServers）

/**
 * 判定一个 harvested tool 是否属于某个 MCP server（基于命名前缀规则）。
 * MCP direct tool 名形如 `<serverPrefix>_<toolName>`，serverPrefix = serverName.replace(/-/g,"_")。
 * 非 MCP 工具（builtin/扩展）不匹配任何 server 前缀，返回 false。
 *
 * 注意：这是一个启发式匹配——serverPrefix 是 server 名的规范化形式，
 * 可能存在极端命名碰撞（如普通工具恰好叫 `foo_bar` 而恰好有个 server 叫 `foo`）。
 * 但在实际使用中 MCP 工具名通常足够独特，碰撞概率极低。
 */
function getMcpServerOfTool(toolName: string, serverPrefixes: Set<string>): string | null {
  const idx = toolName.indexOf("_");
  if (idx < 0) return null;
  const prefix = toolName.slice(0, idx);
  return serverPrefixes.has(prefix) ? prefix : null;
}

export function resolveAgentTools(
  baseTools: string[],
  enabledExtensionIds: Set<string>,
  _agentName?: string,
  toolMap: Record<string, string[]> = EXTENSION_TOOL_MAP,
  harvestedTools: Iterable<string> = [],
  opts?: { allowedMcpServers?: string[] },
): string[] {
  const BLOCKED = new Set(["subagent"]);
  const seen = new Set(baseTools);
  const result = [...baseTools];
  for (const [extId, extTools] of Object.entries(toolMap)) {
    if (enabledExtensionIds.has(extId)) {
      for (const t of extTools) {
        if (!seen.has(t)) {
          seen.add(t);
          result.push(t);
        }
      }
    }
  }

  // MCP server 白名单：非空时只放行白名单内 server 的工具
  // server 名 → 前缀（- 替换为 _），如 "playwright" → "playwright"，"my-server" → "my_server"
  const allowedPrefixes = opts?.allowedMcpServers?.length
    ? new Set(opts.allowedMcpServers.map(s => s.replace(/-/g, "_")))
    : null;

  for (const t of harvestedTools) {
    if (seen.has(t)) continue;
    // MCP 白名单过滤：工具属于某 MCP server 前缀时，只放行白名单内的
    if (allowedPrefixes) {
      const serverPrefix = getMcpServerOfTool(t, allowedPrefixes);
      if (serverPrefix === null && t.includes("_")) {
        // 工具名含下划线但不匹配任何白名单前缀 → 可能是未授权的 MCP 工具，跳过
        // 注意：普通扩展工具（如 read/bash/grep）不含下划线，不受影响
        continue;
      }
    }
    seen.add(t);
    result.push(t);
  }
  return result.filter(t => !BLOCKED.has(t));
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `export PATH="$HOME/.bun/bin:$PATH" && cd /Users/pipi/work/HiAgent/packages/shared && bun test tests/constants.test.ts -t "mcpServers"`
Expected: PASS

- [ ] **Step 5: agent-manager 传入 config.mcpServers**

```typescript
// packages/kernel/src/agent-manager.ts:440-446
const tools = resolveAgentTools(
  config?.tools?.length ? config.tools : DEFAULT_AGENT_TOOLS,
  enabledExtensionIds,
  agentName,
  EXTENSION_TOOL_MAP,
  harvestedTools,
  { allowedMcpServers: config?.mcpServers },  // ← 死字段现在生效
);
```

- [ ] **Step 6: 运行 kernel 测试确认无回归**

Run: `export PATH="$HOME/.bun/bin:$PATH" && cd /Users/pipi/work/HiAgent/packages/kernel && bun test 2>&1 | tail -10`
Expected: 无新增 FAIL

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/constants.ts packages/shared/tests/constants.test.ts packages/kernel/src/agent-manager.ts
git commit -m "feat(kernel): resolveAgentTools 支持 per-agent MCP server 白名单过滤"
```

---

### Task 12: AgentConfig 弹窗新增 MCP tab

**Files:**
- Modify: `packages/frontend/src/components/AgentConfig.tsx`（TABS + Tab 类型 + McpTab 组件）
- Test: `packages/frontend/tests/AgentConfig.test.tsx`

**Interfaces:**
- Consumes: `useMcpStore(s => s.servers)` 取 MCP 服务器列表（`McpServerConfig[]`）
- Consumes: `draft.mcpServers: string[]`（已有字段，之前是死字段）
- Produces: MCP tab 展示所有已配置 MCP 服务器的 checkbox 列表，勾选态绑定 `draft.mcpServers`

- [ ] **Step 1: 写失败测试**

```typescript
// packages/frontend/tests/AgentConfig.test.tsx（追加）
test("MCP tab 展示 MCP 服务器列表并支持勾选", async () => {
  // 设置 MCP store
  useMcpStore.setState({
    servers: [
      { name: "playwright", command: "npx", args: ["@playwright/mcp"] } as any,
      { name: "github", url: "https://api.github.com/mcp" } as any,
    ],
    loading: false,
  });
  const onChange = mock();
  render(<AgentConfig agentName="dev" onClose={noop} />);
  // 等 config 加载后切到 MCP tab
  await waitFor(() => screen.getByTestId("cfg-name-input"));
  fireEvent.click(screen.getByTestId("tab-mcp"));
  // 两个服务器都展示
  expect(screen.getByTestId("mcp-check-playwright")).toBeTruthy();
  expect(screen.getByTestId("mcp-check-github")).toBeTruthy();
  // 勾选 playwright
  fireEvent.click(screen.getByTestId("mcp-check-playwright"));
  // onChange 被调用，draft.mcpServers 含 playwright
  const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
  expect(lastCall.mcpServers).toContain("playwright");
  expect(lastCall.mcpServers).not.toContain("github");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `export PATH="$HOME/.bun/bin:$PATH" && cd /Users/pipi/work/HiAgent/packages/frontend && bun test tests/AgentConfig.test.tsx -t "MCP tab"`
Expected: FAIL — `tab-mcp` 不存在

- [ ] **Step 3: 修改 AgentConfig.tsx 新增 MCP tab**

在 `packages/frontend/src/components/AgentConfig.tsx` 做以下改动：

a) Tab 类型加 `"mcp"`，TABS 加 MCP 项：

```typescript
// line 15
type Tab = "basic" | "tools" | "skills" | "partners" | "mcp";

// line 17-22
const TABS: { key: Tab; label: string }[] = [
  { key: "basic", label: "基本" },
  { key: "tools", label: "工具" },
  { key: "skills", label: "技能" },
  { key: "mcp", label: "MCP" },
  { key: "partners", label: "关系网" },
];
```

b) 渲染分支加 McpTab（在 line 143 附近）：

```typescript
{draft && tab === "mcp" && <McpTab draft={draft} onChange={handleChange} />}
```

c) 新增 McpTab 组件（在文件底部 PartnersTab 之后）：

```typescript
function McpTab({ draft, onChange }: TabProps) {
  const servers = useMcpStore(s => s.servers);
  // 首次进入加载 MCP 列表
  useEffect(() => {
    if (servers.length === 0) useMcpStore.getState().load();
  }, []);
  // 空 mcpServers = 全量（同 tools/skills 的语义）
  const checked = (name: string) => draft.mcpServers.length === 0 || draft.mcpServers.includes(name);
  const toggle = (name: string) => {
    const next = draft.mcpServers.length === 0
      ? servers.filter(s => s.name !== name).map(s => s.name)
      : draft.mcpServers.includes(name) ? draft.mcpServers.filter(x => x !== name) : [...draft.mcpServers, name];
    onChange({ ...draft, mcpServers: next });
  };
  if (servers.length === 0) return <p className="text-sm text-tertiary">暂无 MCP 服务器，可在设置中添加</p>;
  return (
    <div className="flex flex-col">
      <p className="text-[11px] text-tertiary mb-2">全部勾选 = 全量默认；取消勾选后按显式列表保存</p>
      {servers.map(s => (
        <label key={s.name} className="flex items-center gap-2 py-1 cursor-pointer">
          <input type="checkbox" checked={checked(s.name)} onChange={() => toggle(s.name)} data-testid={`mcp-check-${s.name}`} />
          <span className="text-sm text-primary">{s.name}</span>
          <span className="text-[11px] text-tertiary truncate">{s.command ?? s.url ?? ""}</span>
        </label>
      ))}
    </div>
  );
}
```

d) 顶部加 useMcpStore import：

```typescript
import { useMcpStore } from "../store/mcp";
```

- [ ] **Step 4: 运行测试确认通过**

Run: `export PATH="$HOME/.bun/bin:$PATH" && cd /Users/pipi/work/HiAgent/packages/frontend && bun test tests/AgentConfig.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/components/AgentConfig.tsx packages/frontend/tests/AgentConfig.test.tsx
git commit -m "feat(frontend): AgentConfig 弹窗新增 MCP 服务器 tab"
```

---

### Task 13: 内置 draft 补 mcpServers 默认值 + CHANGELOG

**Files:**
- Modify: `packages/frontend/src/components/AgentConfig.tsx:54`（内置 draft 已有 `mcpServers: []`，确认即可）
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 确认内置 draft 有 mcpServers 字段**

内置 subagent 的 draft 构造（`AgentConfig.tsx:38-59`）已有 `mcpServers: []`，无需改动。命名智能体的 draft 从 ConfigStore 加载，agent-md.ts 的 `makeDefaultAgentConfig` 也已有 `mcpServers: []`。

- [ ] **Step 2: 更新 CHANGELOG**

在顶部追加：

```markdown
### 新增
- **编辑智能体弹窗新增 MCP tab**：每个智能体可配置可用的 MCP 服务器白名单（`config.mcpServers`）。之前 MCP 工具无差别流入所有智能体，现在 `resolveAgentTools` 按 `config.mcpServers` 白名单过滤 harvestedTools 中的 MCP direct tools（基于 server 名前缀匹配规则）。空数组=全量默认（向后兼容），非空=只放行白名单内 server 的工具。影响范围：shared/constants.ts（resolveAgentTools 新增 allowedMcpServers 参数）、kernel/agent-manager.ts（传入 config.mcpServers）、frontend/AgentConfig.tsx（新增 McpTab 组件 + TABS）。
```

- [ ] **Step 3: 运行全量测试**

Run: `export PATH="$HOME/.bun/bin:$PATH" && cd /Users/pipi/work/HiAgent && bun test --path-ignore-patterns "**/e2e/**" 2>&1 | tail -10`
Expected: 全部 PASS

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG 记录 per-agent MCP 白名单功能"
```
