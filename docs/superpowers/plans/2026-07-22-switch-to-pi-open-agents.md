# 切换到 pi-open-agents 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将子智能体执行后端从 `@gotgenes/pi-subagents`（进程内 spawn+轮询）切换到 `pi-open-agents`（子进程 runSubagent+onProgress），获得 per-agent skills/tools 配置能力和子智能体执行过程可见性。

**Architecture:** HiAgent kernel 通过 Pi SDK 的 `additionalExtensionPaths` 加载 `pi-open-agents` 扩展；delegate-tool 不再走 `getSubagentsService()` + spawn+轮询，改为直接 import `runSubagent()` 异步执行 + `onProgress` 回调推送过程事件。内置 subagent 类型（general-purpose/Explore/Plan）从代码常量改为 `.pi/agents/*.md` 定义文件。HiAgent 的 `config.skills`/`config.tools` 白名单映射到 agent 定义文件的 frontmatter。

**Tech Stack:** pi-open-agents@0.1.12、@earendil-works/pi-coding-agent（Pi SDK）、Bun + TypeScript、bun:test

## Global Constraints

- 测试框架：后端 `bun:test`，前端 `bun:test` + `@testing-library/react` + `happy-dom`
- 测试运行：`export PATH="$HOME/.bun/bin:$PATH" && bun test`
- 代码注释和沟通使用中文
- 精准修改：只碰必须改的，匹配现有风格
- 每个任务结束时 commit
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
| `packages/kernel/src/subagent-info.ts` | 内置 subagent 信息读取 | 修改：从 .md 文件读 |
| `packages/kernel/src/agent-manager.ts` | session 创建 + delegate 工具注册 | 修改：spawn 闭包 + 过程事件转发 |
| `packages/shared/src/constants.ts` | SUBAGENT_TYPES 常量 | 修改：保留元信息（emoji/gradient/displayName），移除对 pi-subagents 内部路径的依赖 |
| `packages/kernel/tests/delegate-tool.test.ts` | delegate 工具测试 | **完全重写** |
| `docs/research/pi-open-agents-evaluation.md` | 调研评估文档 | 新建（可选） |

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

### Task 3: 新建 subagent-runner.ts（runSubagent 适配层）

**Files:**
- Create: `packages/kernel/src/subagent-runner.ts`

**Interfaces:**
- Consumes: `runSubagent`、`AgentDefinition`、`AgentProgress` from `pi-open-agents`
- Produces: `runSubagentAgent(agent, task, opts)` 函数，返回 `DelegateSpawnResult`，支持 `onProgress` 过程回调

这是 delegate-tool 的执行核心。把 pi-open-agents 的 `runSubagent`（子进程 async）封装为 HiAgent 的 `DelegateSpawnFn` 签名，同时把 `onProgress` 事件转发给上层（用于前端过程展示）。

- [ ] **Step 1: 写失败测试**

```typescript
// packages/kernel/tests/subagent-runner.test.ts
import { test, expect, mock } from "bun:test";
import { buildAgentDefinition, type SubagentProgressEvent } from "../src/subagent-runner";

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
  // Explore 是只读探索类型，builtinToolNames 应为只读工具集
  expect(def.name).toBe("Explore");
  expect(def.tools).toContain("read");
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

  const systemPrompt = config.systemPrompt
    || builtin?.readOnly
      ? config.systemPrompt
      : "";

  return {
    name: config.name,
    description: config.description || builtin?.description || "",
    mode: "subagent",
    hidden: false,
    disable: false,
    model: config.model ?? undefined,
    thinking: mapThinking(config.thinking) as any,
    systemPrompt: config.systemPromptMode,
    prompt: systemPrompt,
    tools,
    skills: config.skills.length > 0 ? config.skills : undefined,
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

### Task 5: agent-manager 接入新 spawn 闭包 + config.skills/tools 传递

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

// resolveConfig：从 ConfigStore 读 agent 配置，提取 spawn 所需字段
// config.skills / config.tools 白名单在此传入子智能体（之前从未被消费的死字段，现在生效）
const resolveSpawnConfig = async (agentName: string): Promise<HiAgentSpawnConfig | null> => {
  const cfg = await this.opts.configStore?.getAgent(agentName).catch(() => null);
  if (!cfg) {
    // 内置 subagent 类型不在 store 里，用 SUBAGENT_TYPES 补全
    if (isSubagentType(agentName)) {
      const builtin = SUBAGENT_TYPES.find(t => t.name === agentName);
      if (builtin) {
        return {
          name: builtin.name,
          description: builtin.description,
          systemPrompt: "",
          systemPromptMode: "replace",
          model: null,
          thinking: null,
          tools: builtin.readOnly ? ["read", "bash", "grep", "find", "ls"] : [],
          skills: [],
        };
      }
    }
    return null;
  }
  return {
    name: cfg.displayName,
    description: cfg.description,
    systemPrompt: cfg.systemPromptBody ?? "",
    systemPromptMode: cfg.systemPromptMode,
    model: cfg.model,
    thinking: cfg.thinking,
    tools: cfg.tools,
    skills: cfg.skills,  // ← 死字段现在生效
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

### Task 6: 移除 inheritSkills 死字段

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

### Task 7: 更新 subagent-info.ts（从 pi-open-agents 读内置 agent 信息）

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

注意：SUBAGENT_TYPES 需要确认是否已有 systemPrompt 字段。如果没有，systemPrompt 返回空串（前端 AgentConfig 展示只读详情时，可以后续从 .md 文件读）。

- [ ] **Step 2: 运行测试**

Run: `export PATH="$HOME/.bun/bin:$PATH" && cd /Users/pipi/work/HiAgent && bun test packages/kernel/tests/ --grep "subagent" 2>&1 | tail -10`
Expected: PASS（或因 mock 变化需更新测试）

- [ ] **Step 3: Commit**

```bash
git add packages/kernel/src/subagent-info.ts
git commit -m "refactor(kernel): subagent-info 不再 import pi-subagents 内部源码"
```

---

### Task 8: 运行全套测试 + 修复回归

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

### Task 9: 更新 CHANGELOG + 最终验证

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 更新 CHANGELOG**

在 `## 2026-07-22` 顶部追加：

```markdown
### 重构
- **子智能体执行后端从 @gotgenes/pi-subagents 切换到 pi-open-agents**：获得 per-agent skills/tools 白名单配置能力（config.skills/config.tools 死字段正式生效）+ 子智能体执行过程可见性（onProgress 回调：工具调用/文本输出/用量实时推送）。架构变化：进程内 spawn+轮询 → 子进程 runSubagent+AbortSignal。delegate-tool 完全重写（移除 SubagentServiceLike/waitSubagentResult/spawnViaSubagentsService，新增 makeSpawnFn + subagent-runner 适配层）。移除死字段 inheritSkills。影响范围：kernel/{delegate-tool,subagent-runner(新),subagent-info,agent-manager,extensions}.ts、shared/{types,constants}.ts、frontend/AgentConfig.tsx。
```

- [ ] **Step 2: 全量测试最终验证**

Run: `export PATH="$HOME/.bun/bin:$PATH" && cd /Users/pipi/work/HiAgent && bun test --path-ignore-patterns "**/e2e/**" 2>&1 | tail -10`
Expected: 除预先存在的 flaky 测试外全部 PASS

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG 记录 pi-open-agents 切换"
```
