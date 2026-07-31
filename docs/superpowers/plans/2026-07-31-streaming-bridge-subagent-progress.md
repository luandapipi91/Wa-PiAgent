# 流式 Bridge + 子代理进度直推前端 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 delegate/fleet 的 bridge 调用从一次性阻塞改成 NDJSON 流式，根治"子代理执行超 5 分钟被 undici idle timeout 砍断"的超时问题，同时把已采集但闲置的子代理进度事件接通到前端实时展示。

**Architecture:** kernel 的 `/bridge/tool` 端点对 delegate/fleet 返回 NDJSON 流式响应（started→progress*→final 三帧），持续 flush 字节重置 undici 计时器；进度帧同时经新增的 `onSubagentProgress` 回调广播到 SSE 总线，前端 DelegateCard/FleetCard 默认折叠展示摘要、展开看详情。

**Tech Stack:** TypeScript monorepo（packages/kernel + packages/shared + packages/frontend），运行时 Bun，测试 bun:test + @testing-library/react + happy-dom。

## Global Constraints

- **语言**：所有代码注释用中文，变量名用英文。
- **只对 delegate/fleet 流式**：ask_user_question / memory_* 保持原同步请求-响应不变。
- **不引入新依赖**：流式用项目已有的 `ReadableStream` + `TextEncoder` 模式（参考 `ws-server.ts:367-390` 的 `/api/events` 实现）。
- **前端 EventSource 只用 `onmessage`**：新事件靠 `data.type` 字符串分发，不能用 `event:` 字段（`events.ts:58`）。
- **测试工具**：kernel 和前端都用 `bun:test`（非 Vitest）。kernel 测试在 `packages/kernel/tests/*.test.ts`，前端在 `packages/frontend/tests/*.test.tsx`。
- **向后兼容**：bridge 扩展读取首帧，若非 `started` 则降级为旧的一次性 JSON 解析。
- **精确行号会随编辑漂移**，计划中行号为编写时快照，按函数/变量名定位。

## File Structure

| 文件 | 责任 | 改动类型 |
|---|---|---|
| `packages/shared/src/types.ts` | 新增 `SubagentProgressEvent`、`BridgeStreamFrame`、`SubagentProgressServerEvent` 类型 | 新增 |
| `packages/kernel/src/subagent-runner.ts` | `SubagentProgressEvent` 改从 shared import；onProgress 加 toolCallId | 修改 |
| `packages/kernel/src/delegate-tool.ts` | `DelegateSpawnFn` 加 toolCallId；execute 透传 toolCallId；makeSpawnFn onProgress 加 toolCallId | 修改 |
| `packages/kernel/src/bridge-registry.ts` | `handleTool` 加 onProgress 参数；新增 `handleBridgeStream` 流式写入器 | 修改 |
| `packages/kernel/src/agent-manager.ts` | opts 加 `onSubagentProgress`；spawnFn 传 onProgress；bridgeCtx.handleTool 透传 onProgress | 修改 |
| `packages/kernel/src/index.ts` | 构造 AgentManager 时把 onSubagentProgress 接到 server.broadcast | 修改 |
| `packages/kernel/src/ws-server.ts` | `/bridge/tool` 端点对 delegate/fleet 走流式 Response | 修改 |
| `packages/kernel/src/wa-pi-bridge.extension.ts` | callBridge 对 delegate/fleet 改流式读取；超时收窄 | 修改 |
| `packages/frontend/src/store/session.ts` | 监听 subagent:progress 事件，存 progressByToolCall | 修改 |
| `packages/frontend/src/components/blocks/DelegateCard.tsx` | 消费进度，默认折叠展示摘要 | 修改 |
| `packages/frontend/src/components/blocks/FleetCard.tsx` | 消费进度，按 agent 分组 | 修改 |

---

### Task 1: shared 类型定义（SubagentProgressEvent + 流式帧 + SSE 事件）

**Files:**
- Modify: `packages/shared/src/types.ts`（在 `SubagentListResult` 附近，约 `:834`）

**Interfaces:**
- Produces: `SubagentProgressEvent`、`BridgeStreamFrame`（含 started/progress/final）、`SubagentProgressServerEvent`；`WSServerEvent` 联合追加 `SubagentProgressServerEvent`

**背景**：`SubagentProgressEvent` 当前定义在 `packages/kernel/src/subagent-runner.ts:38-44`，需提升到 shared 供前后端共用。`BridgeToolResult` 已存在于 `bridge-registry.ts:11-14`，但 shared 里没有——本任务在 shared 定义一份同结构类型供帧引用。

- [ ] **Step 1: 在 types.ts 新增三个类型**

在 `packages/shared/src/types.ts` 找到 `SubagentListResult`（约 `:834`）之后，新增：

```ts
// =========================================================================
// 子代理进度（流式 bridge + 前端实时展示共用）
// =========================================================================

/** 子代理执行过程事件（由 subagent-runner 采集，经 onProgress 透传） */
export interface SubagentProgressEvent {
	agent: string;
	status: "running" | "done" | "error";
	output: string;
	tools: Array<{ id: string; name: string; status: string }>;
	elapsedMs: number;
}

/** bridge 流式协议帧（NDJSON，每帧一行） */
export type BridgeStreamFrame =
	| { type: "started"; protocol: 1; tool: string; toolCallId: string }
	| { type: "progress"; tool: string; toolCallId: string; progress: SubagentProgressEvent }
	| {
			type: "final";
			tool: string;
			toolCallId: string;
			ok: boolean;
			result?: { content: Array<{ type: "text"; text: string }>; details?: unknown };
			error?: string;
	  };

/** SSE 事件：子代理进度（前端按 sessionId + toolCallId 路由到 DelegateCard/FleetCard） */
export interface SubagentProgressServerEvent {
	type: "subagent:progress";
	sessionId: string;
	toolCallId: string;
	progress: SubagentProgressEvent;
}
```

- [ ] **Step 2: 把 SubagentProgressServerEvent 加入 WSServerEvent 联合**

找到 `WSServerEvent` 联合类型定义（约 `:787-835`），在末尾 `| SubagentListResult` 后追加：

```ts
| SubagentProgressServerEvent
```

- [ ] **Step 3: 确认 shared 导出**

确认 `packages/shared/src/index.ts` 里 `export * from "./types"` 或等价导出已覆盖新类型（通常已是 `export *`，无需改）。运行：

```bash
cd /Users/pipi/work/HiAgent && bun -e "import { type SubagentProgressEvent, type BridgeStreamFrame, type SubagentProgressServerEvent } from '@wa-pi/shared'; console.log('ok')"
```
预期：输出 `ok`，无 TS 报错。

- [ ] **Step 4: 类型检查**

```bash
cd /Users/pipi/work/HiAgent && bunx tsc --noEmit -p packages/shared/tsconfig.json 2>&1 | head -20
```
预期：无新增错误（可能有既存无关错误，忽略）。

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat(shared): 新增 SubagentProgressEvent / BridgeStreamFrame / SubagentProgressServerEvent 类型"
```

---

### Task 2: kernel 侧 SubagentProgressEvent 改从 shared 引用

**Files:**
- Modify: `packages/kernel/src/subagent-runner.ts:38-44`（删除本地定义，改 import）
- Modify: `packages/kernel/src/delegate-tool.ts:25-30`（改 import 来源）

**Interfaces:**
- Consumes: `SubagentProgressEvent` from `@wa-pi/shared`（Task 1 产出）
- Produces: kernel 内不再重复定义 `SubagentProgressEvent`，统一从 shared 引用

- [ ] **Step 1: subagent-runner.ts 删除本地 SubagentProgressEvent，改 import**

在 `packages/kernel/src/subagent-runner.ts`：
- 删除 `:38-44` 的 `export interface SubagentProgressEvent { ... }` 整块。
- 在顶部 import 区（`:15` 的 `import type { ThinkingLevel } from "@wa-pi/shared";` 附近）加：
```ts
import type { SubagentProgressEvent } from "@wa-pi/shared";
```

- [ ] **Step 2: delegate-tool.ts 改 import 来源**

在 `packages/kernel/src/delegate-tool.ts:25-30`，把：
```ts
import type {
	WaPiSpawnConfig,
	SubagentProgressEvent,
	SubagentUsage,
} from "./subagent-runner";
```
中的 `SubagentProgressEvent,` 这一行删除，改为从 shared 引用。在文件顶部 import 区加：
```ts
import type { SubagentProgressEvent } from "@wa-pi/shared";
```
保留 `WaPiSpawnConfig, SubagentUsage` 仍从 `./subagent-runner` 引（它们是 kernel 内部类型）。改后：
```ts
import type { WaPiSpawnConfig, SubagentUsage } from "./subagent-runner";
import type { SubagentProgressEvent } from "@wa-pi/shared";
```

- [ ] **Step 3: 搜其他引用点，确保都有 import**

```bash
cd /Users/pipi/work/HiAgent && grep -rn "SubagentProgressEvent" packages/kernel/src packages/frontend/src
```
预期：所有引用处要么从 `@wa-pi/shared` import，要么从仍 export 它的文件引（subagent-runner 不再 export 它了）。若 kernel 内其他文件直接 `import { SubagentProgressEvent } from "./subagent-runner"`，改为从 `@wa-pi/shared`。

- [ ] **Step 4: 类型检查**

```bash
cd /Users/pipi/work/HiAgent && bunx tsc --noEmit -p packages/kernel/tsconfig.json 2>&1 | grep -i "subagentprogress\|cannot find" | head
```
预期：无 `Cannot find name 'SubagentProgressEvent'` 错误。

- [ ] **Step 5: 跑现有 kernel 测试确保未破坏**

```bash
cd /Users/pipi/work/HiAgent && bun test packages/kernel/tests/subagent-runner.test.ts 2>&1 | tail -20
```
预期：全部通过（仅类型来源变更，行为不变）。

- [ ] **Step 6: Commit**

```bash
git add packages/kernel/src/subagent-runner.ts packages/kernel/src/delegate-tool.ts
git commit -m "refactor(kernel): SubagentProgressEvent 统一从 @wa-pi/shared 引用"
```

---

### Task 3: toolCallId 透传链（delegate-tool spawn 签名 + onProgress 回调）

**Files:**
- Modify: `packages/kernel/src/delegate-tool.ts:52-55`（DelegateSpawnFn 签名）、`:141-171`（delegate execute）、`:181-257`（makeSpawnFn）、`:280-336`（fleet execute）
- Test: `packages/kernel/tests/delegate-tool.test.ts`

**Interfaces:**
- Produces: `DelegateSpawnFn` 变为 `(agent, task, toolCallId) => Promise<DelegateSpawnResult>`；`makeSpawnFn` 的 `onProgress` 变为 `(toolCallId, event) => void`

**背景**：前端 DelegateCard 靠 `toolCallId` 定位卡片。当前 `execute(_toolCallId, ...)` 把它忽略了，必须透传到 onProgress。

- [ ] **Step 1: 写失败测试——验证 toolCallId 透传到 onProgress**

在 `packages/kernel/tests/delegate-tool.test.ts` 末尾加：

```ts
import { makeSpawnFn, makeDelegateTool } from "../src/delegate-tool";

test("makeSpawnFn 的 onProgress 回调能收到 toolCallId", async () => {
	const toolCallId = "tc-test-001";
	const received: Array<{ tcId: string; agent: string }> = [];
	const spawnFn = makeSpawnFn({
		resolveConfig: async () => ({
			name: "test-agent",
			description: "",
			systemPrompt: "",
			systemPromptMode: "replace",
			model: null,
			thinking: null,
			tools: [],
			skills: [],
		}),
		cwd: "/tmp",
		// 注入假的 runSubagentAgent：立即触发一次 onProgress 再返回
		runSubagentAgent: (async (_config, _task, _cwd, opts) => {
			opts?.onProgress?.({
				agent: "test-agent",
				status: "running",
				output: "hi",
				tools: [],
				elapsedMs: 1,
			});
			return { text: "done", isError: false, elapsedMs: 1 };
		}) as any,
		onProgress: (tcId, event) => received.push({ tcId, agent: event.agent }),
	});
	// spawnFn 现在接受第三个参数 toolCallId
	await spawnFn("test-agent", "do something", toolCallId);
	expect(received).toEqual([{ tcId: toolCallId, agent: "test-agent" }]);
});

test("makeDelegateTool execute 把 toolCallId 透传给 spawn", async () => {
	let spawnCalledWith: string | undefined;
	const tool = makeDelegateTool({
		askTo: [],
		spawn: async (_agent, _task, toolCallId) => {
			spawnCalledWith = toolCallId;
			return { text: "ok", isError: false };
		},
	});
	await tool.execute("tc-xyz", { agent: "general-purpose", task: "hi" });
	expect(spawnCalledWith).toBe("tc-xyz");
});
```

- [ ] **Step 2: 运行测试验证失败**

```bash
cd /Users/pipi/work/HiAgent && bun test packages/kernel/tests/delegate-tool.test.ts 2>&1 | tail -15
```
预期：FAIL（当前 onProgress 签名是 `(event) => void`，且 spawn 不接受 toolCallId）。

- [ ] **Step 3: 改 DelegateSpawnFn 签名**

`delegate-tool.ts:52-55`：
```ts
export type DelegateSpawnFn = (
	agent: string,
	task: string,
	toolCallId: string,
) => Promise<DelegateSpawnResult>;
```

- [ ] **Step 4: 改 makeSpawnFn 的 onProgress 签名 + spawn 闭包接受 toolCallId**

`delegate-tool.ts` 找到 `makeSpawnFn`（约 `:181`）：
- `onProgress?: (event: SubagentProgressEvent) => void;` 改为：
```ts
onProgress?: (toolCallId: string, event: SubagentProgressEvent) => void;
```
- 返回的闭包 `return async (agent: string, task: string) => {` 改为：
```ts
return async (agent: string, task: string, toolCallId: string) => {
```
- `runSubagent(config, task, opts.cwd, { ... onProgress: opts.onProgress ... })` 处，把 onProgress 包一层注入 toolCallId：
```ts
const result = await runSubagent(config, task, opts.cwd, {
	signal: opts.signal,
	onProgress: opts.onProgress
		? (event) => opts.onProgress!(toolCallId, event)
		: undefined,
	skillPaths,
	extensionPaths: opts.extensionPaths,
	cliPath: opts.runnerOpts?.cliPath,
	runtime: opts.runnerOpts?.runtime,
	commandTimeoutMs: opts.runnerOpts?.commandTimeoutMs,
});
```

- [ ] **Step 5: 改 delegate execute 透传 toolCallId**

`delegate-tool.ts:141-171`，把 `async execute(_toolCallId: string, args)` 的 `_toolCallId` 改名 `toolCallId`，并把 `await opts.spawn(spawnAgent, args.task)` 改为 `await opts.spawn(spawnAgent, args.task, toolCallId)`。

- [ ] **Step 6: 改 fleet execute 透传 toolCallId**

`delegate-tool.ts:280-336`，fleet 的 `execute(_toolCallId, args)` 同样改名 `toolCallId`，把内部 `await opts.spawn(spawnAgent, t.task)` 改为 `await opts.spawn(spawnAgent, t.task, toolCallId)`（fleet 所有子任务共享同一个 fleet 工具调用的 toolCallId，前端 FleetCard 靠它定位，内部按 `progress.agent` 分组）。

- [ ] **Step 7: 跑测试验证通过**

```bash
cd /Users/pipi/work/HiAgent && bun test packages/kernel/tests/delegate-tool.test.ts 2>&1 | tail -15
```
预期：PASS。

- [ ] **Step 8: 修复调用方（agent-manager.ts 的 spawnFn 构造，仅签名适配，onProgress 在 Task 5 接）**

`agent-manager.ts:534-559` 的 `makeSpawnFn({...})` 目前不传 onProgress，签名变更不影响（新参数可选）。但 `spawnFn` 被调用的地方（搜索 `spawnFn(` 或经 delegateTool 间接调用）需确认无需改。运行全量 kernel 测试：
```bash
cd /Users/pipi/work/HiAgent && bun test packages/kernel/tests/ 2>&1 | tail -25
```
预期：无新增失败。若 agent-manager.test.ts 因 spawn 签名失败，按报错适配（给 spawn 调用补 toolCallId 参数）。

- [ ] **Step 9: Commit**

```bash
git add packages/kernel/src/delegate-tool.ts packages/kernel/tests/delegate-tool.test.ts
git commit -m "feat(delegate): toolCallId 透传到 spawn 与 onProgress，供进度帧关联卡片"
```

---

### Task 4: bridge-registry 流式写入器（handleBridgeStream）

**Files:**
- Modify: `packages/kernel/src/bridge-registry.ts:17-20`（BridgeSessionContext.handleTool 加 onProgress）、`:65-86`（新增流式分支）
- Test: `packages/kernel/tests/bridge.test.ts`

**Interfaces:**
- Consumes: `BridgeStreamFrame`、`SubagentProgressEvent` from `@wa-pi/shared`（Task 1）
- Produces: `handleBridgeStream(body, write)` —— delegate/fleet 走流式，write 回调写 NDJSON 帧

- [ ] **Step 1: 写失败测试——handleBridgeStream 输出 started→progress→final 序列**

在 `packages/kernel/tests/bridge.test.ts` 加：

```ts
import { handleBridgeStream, registerBridgeSession, unregisterBridgeSession, getBridgeToken } from "../src/bridge-registry";

test("handleBridgeStream 对 delegate 输出 started→progress→final NDJSON 序列", async () => {
	const token = getBridgeToken();
	const sessionId = "stream-test-sid";
	const toolCallId = "tc-stream-001";
	const frames: string[] = [];
	registerBridgeSession(sessionId, {
		cwd: "/tmp",
		async handleTool(tool, tcId, _params, _signal, onProgress) {
			// 模拟子代理产生一次进度后完成
			onProgress?.({
				agent: "general-purpose",
				status: "running",
				output: "working",
				tools: [],
				elapsedMs: 10,
			});
			return { content: [{ type: "text", text: "子代理完成" }] };
		},
	});
	try {
		await handleBridgeStream(
			{ token, sessionId, toolCallId, tool: "delegate", params: { agent: "general-purpose", task: "hi" } },
			(frame) => frames.push(frame),
		);
	} finally {
		unregisterBridgeSession(sessionId);
	}
	// 解析帧
	const parsed = frames.map((f) => JSON.parse(f));
	expect(parsed.map((f) => f.type)).toEqual(["started", "progress", "final"]);
	expect(parsed[0]).toMatchObject({ type: "started", protocol: 1, tool: "delegate", toolCallId });
	expect(parsed[1]).toMatchObject({ type: "progress", tool: "delegate", toolCallId });
	expect(parsed[1].progress).toMatchObject({ agent: "general-purpose", output: "working" });
	expect(parsed[2]).toMatchObject({ type: "final", tool: "delegate", toolCallId, ok: true });
	expect(parsed[2].result.content[0].text).toBe("子代理完成");
});

test("handleBridgeStream 对 memory_add 返回 null（非流式工具走旧路径）", async () => {
	const token = getBridgeToken();
	const sessionId = "stream-test-sid2";
	registerBridgeSession(sessionId, {
		cwd: "/tmp",
		async handleTool() { return { content: [{ type: "text", text: "ok" }] }; },
	});
	try {
		const ret = await handleBridgeStream(
			{ token, sessionId, toolCallId: "tc", tool: "memory_add", params: {} },
			() => {},
		);
		// 非流式工具返回结构化结果（不走帧），由调用方走旧 JSON 路径
		expect(ret).not.toBeNull();
		expect((ret as any).ok).toBe(true);
	} finally {
		unregisterBridgeSession(sessionId);
	}
});
```

- [ ] **Step 2: 运行测试验证失败**

```bash
cd /Users/pipi/work/HiAgent && bun test packages/kernel/tests/bridge.test.ts 2>&1 | tail -15
```
预期：FAIL（`handleBridgeStream` 未导出）。

- [ ] **Step 3: BridgeSessionContext.handleTool 加 onProgress 参数**

`bridge-registry.ts:17-20`：
```ts
export interface BridgeSessionContext {
	cwd: string;
	handleTool(
		tool: string,
		toolCallId: string,
		params: unknown,
		signal: AbortSignal,
		onProgress?: (event: SubagentProgressEvent) => void,
	): Promise<BridgeToolResult>;
}
```
顶部加 import：
```ts
import type { SubagentProgressEvent } from "@wa-pi/shared";
```

- [ ] **Step 4: 实现 handleBridgeStream**

在 `bridge-registry.ts` 的 `handleBridgeRequest` 之后新增：

```ts
import type { BridgeStreamFrame, SubagentProgressEvent } from "@wa-pi/shared";

/** 流式工具集合（仅这些走 NDJSON 流式，其余走旧同步路径） */
const STREAM_TOOLS = new Set(["delegate", "fleet"]);

/**
 * 处理 POST /bridge/tool 的流式分支：
 * - delegate/fleet：write 回调输出 started→progress*→final NDJSON 帧，返回 null
 * - 其他工具：走旧同步路径，返回 BridgeResponse（由调用方 Response.json）
 *
 * write 签名：(frame: string) => void，每帧已是 JSON.stringify 后的字符串（含 \n）。
 */
export async function handleBridgeStream(
	body: unknown,
	write: (ndjsonLine: string) => void,
): Promise<BridgeResponse | null> {
	if (!body || typeof body !== "object") return { ok: false, status: 400, error: "invalid_body" };
	const { token, sessionId, toolCallId, tool, params } = body as Record<string, unknown>;
	if (typeof token !== "string" || !verifyBridgeToken(token)) return { ok: false, status: 401, error: "invalid_token" };
	if (typeof sessionId !== "string" || typeof toolCallId !== "string" || typeof tool !== "string")
		return { ok: false, status: 400, error: "invalid_body" };

	// 非流式工具：返回 null 表示"交回旧路径"，但这里直接复用 handleBridgeRequest 更清晰
	if (!STREAM_TOOLS.has(tool)) {
		return handleBridgeRequest(body);
	}

	const ctx = sessions.get(sessionId);
	if (!ctx) return { ok: false, status: 404, error: "unknown_session" };

	const emit = (frame: BridgeStreamFrame) => write(JSON.stringify(frame) + "\n");
	emit({ type: "started", protocol: 1, tool, toolCallId });

	try {
		const result = await ctx.handleTool(tool, toolCallId, params, new AbortController().signal, (e: SubagentProgressEvent) => {
			emit({ type: "progress", tool, toolCallId, progress: e });
		});
		emit({ type: "final", tool, toolCallId, ok: true, result });
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		emit({ type: "final", tool, toolCallId, ok: false, error });
	}
	return null; // 流式工具已自行 write，调用方不应再 Response.json
}
```

- [ ] **Step 5: 跑测试验证通过**

```bash
cd /Users/pipi/work/HiAgent && bun test packages/kernel/tests/bridge.test.ts 2>&1 | tail -15
```
预期：两个新测试 PASS，旧测试不破坏。

- [ ] **Step 6: Commit**

```bash
git add packages/kernel/src/bridge-registry.ts packages/kernel/tests/bridge.test.ts
git commit -m "feat(bridge): handleBridgeStream 流式写入器，delegate/fleet 输出 NDJSON 帧"
```

---

### Task 5: agent-manager 接通 onProgress（断点修复 + SSE 广播出口）

**Files:**
- Modify: `packages/kernel/src/agent-manager.ts:100-129`（opts 加 onSubagentProgress）、`:534-559`（spawnFn 传 onProgress）、bridgeCtx 构造处（handleTool 透传 onProgress）
- Modify: `packages/kernel/src/index.ts`（接 onSubagentProgress 到 broadcast）

**Interfaces:**
- Consumes: `DelegateSpawnFn` 新签名（Task 3）、`handleTool` 新 onProgress 参数（Task 4）
- Produces: `AgentManagerOpts.onSubagentProgress` 回调，由 index.ts 接到 `server.broadcast({type:"subagent:progress",...})`

- [ ] **Step 1: AgentManagerOpts 加 onSubagentProgress**

`agent-manager.ts:100-129`，在 `onEvent` 之后加：
```ts
/** 子代理进度广播出口（index.ts 接到 server.broadcast → SSE → 前端） */
onSubagentProgress?: (sessionId: string, toolCallId: string, event: SubagentProgressEvent) => void;
```
顶部 import：
```ts
import type { SubagentProgressEvent } from "@wa-pi/shared";
```

- [ ] **Step 2: spawnFn 传 onProgress**

`agent-manager.ts:534-559` 的 `makeSpawnFn({...})`，在 `onSpawnComplete` 之后加：
```ts
onProgress: (toolCallId, event) => {
	this.opts.onSubagentProgress?.(sessionId, toolCallId, event);
},
```
（`sessionId` 是 `_createSession` 的参数，闭包内可见。）

- [ ] **Step 3: bridgeCtx.handleTool 透传 onProgress**

在 `agent-manager.ts` 找到 `bridgeCtx` 构造（约 `:596-626`，`handleTool` 内分发 delegate/fleet/ask/memory）。当前 `handleTool(tool, toolCallId, params, signal)` 签名要加第 5 个参数 `onProgress`，并在 delegate/fleet 分支透传给 `delegateTool.execute` / `fleetTool.execute`。

注意：delegate/fleet 工具的 `execute(toolCallId, args)` 本身不接受 onProgress——onProgress 是经 `makeSpawnFn` 的闭包注入的（Task 3 已让 spawnFn 的 onProgress 带 toolCallId）。所以 **handleTool 的 onProgress 参数需要"记住"当前调用的 onProgress，让 spawnFn 能取到**。

由于 `delegateTool.execute` 内部调 `opts.spawn(agent, task, toolCallId)`，而 spawn 闭包（makeSpawnFn 返回的）的 onProgress 是构造时就绑定的——它**不会**随每次 handleTool 调用而变。所以正确做法是：**bridgeCtx.handleTool 接收 onProgress 后，把它存到一个本次调用有效的位置，spawnFn 的 onProgress 闭包从该位置取最新值**。

最小侵入实现：在 `_createSession` 里用一个 `currentOnProgress` 变量：
```ts
// agent-manager.ts _createSession 内，spawnFn 构造前
let currentSubagentOnProgress: ((tcId: string, e: SubagentProgressEvent) => void) | undefined;
```
- `makeSpawnFn` 的 `onProgress` 改为读这个变量：
```ts
onProgress: (toolCallId, event) => {
	currentSubagentOnProgress?.(toolCallId, event);
	this.opts.onSubagentProgress?.(sessionId, toolCallId, event);
},
```
- `bridgeCtx.handleTool` 签名加 `onProgress`，在 delegate/fleet 分支前设置 `currentSubagentOnProgress = onProgress`：
```ts
async handleTool(tool, toolCallId, params, signal, onProgress) {
	if (tool === "delegate" || tool === "fleet") {
		currentSubagentOnProgress = onProgress;
		try {
			// ... 原有 delegateTool.execute / fleetTool.execute 调用
		} finally {
			currentSubagentOnProgress = undefined;
		}
	}
	// ... ask/memory 分支不变
}
```

> 这种"槽位 + try/finally"是因为 spawn 闭包构造时点早于 handleTool 调用时点，无法直接传参。若你发现更简洁的透传方式（如让 execute 接受 onProgress），可采用，但需保证单元测试覆盖。

- [ ] **Step 4: index.ts 接 onSubagentProgress 到 broadcast**

`packages/kernel/src/index.ts` 找到 `new AgentManager({...})`（约 `:130-165`），在 `onEvent` 之后加：
```ts
onSubagentProgress: (sessionId, toolCallId, event) => {
	broadcast({ type: "subagent:progress", sessionId, toolCallId, progress: event });
},
```
（`broadcast` 在 `index.ts:139` 定义为 `(e) => server.broadcast(e)`。）

- [ ] **Step 5: 写测试——验证 onSubagentProgress 被触发**

在 `packages/kernel/tests/agent-manager.test.ts` 加（若该文件已有 subagent 相关测试，参考其 setup）：
```ts
test("子代理执行时 onSubagentProgress 回调被触发并携带 sessionId/toolCallId", async () => {
	// 参考 agent-manager.test.ts 现有 subagent 测试的 setup（mock spawn 或 fake-pi）
	// 断言：触发 delegate 后，onSubagentProgress 被调用，参数含正确 sessionId 和 toolCallId
	// 具体实现参照文件中现有 spawn 测试的 mock 注入方式
});
```
若 agent-manager 测试 setup 过重（需完整 session），可降级为：在 Task 5 仅做接线 + 手动验证，E2E 覆盖放第四层。**但必须至少有一个测试证明 onProgress 闭包调用了 onSubagentProgress**——可用直接调 `makeSpawnFn` + 注入 mock onSubagentProgress 的方式单元测试闭包逻辑（不经过完整 AgentManager）。

- [ ] **Step 6: 跑 kernel 全量测试**

```bash
cd /Users/pipi/work/HiAgent && bun test packages/kernel/tests/ 2>&1 | tail -25
```
预期：无新增失败。

- [ ] **Step 7: Commit**

```bash
git add packages/kernel/src/agent-manager.ts packages/kernel/src/index.ts packages/kernel/tests/agent-manager.test.ts
git commit -m "feat(agent-manager): 接通 onProgress 断点，子代理进度经 onSubagentProgress 广播到 SSE"
```

---

### Task 6: ws-server /bridge/tool 端点流式响应

**Files:**
- Modify: `packages/kernel/src/ws-server.ts:397-413`（/bridge/tool 端点）

**Interfaces:**
- Consumes: `handleBridgeStream`（Task 4）

**背景**：参考 `/api/events` 的 `ReadableStream` + `controller.enqueue(TextEncoder().encode())` 模式（`ws-server.ts:367-390`）。

- [ ] **Step 1: 改造 /bridge/tool 端点**

`ws-server.ts:397-413`，把当前：
```ts
const r = await handleBridgeRequest(body);
// ...
return Response.json(r.result, { status: 200 });
```
改为：先尝试流式，流式返回 null 时说明是非流式工具走旧路径：
```ts
// 流式分支：delegate/fleet 走 NDJSON 流；其余走旧同步 JSON
let write: ((line: string) => void) | null = null;
const enc = new TextEncoder();
const stream = new ReadableStream<Uint8Array>({
	start(controller) {
		write = (line) => controller.enqueue(enc.encode(line));
	},
});
const r = await handleBridgeStream(body, (line) => write!(line));
if (r) {
	// 非流式工具（ask/memory）：旧路径
	if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
	return Response.json(r.result, { status: 200 });
}
// 流式工具：关闭流并返回 NDJSON 响应
// 注意：handleBridgeStream 已通过 write 写完所有帧（同步 await 完成），
// 此处关闭流即可。delegate 的 handleTool 已 await 完，帧已全部 enqueue。
return new Response(stream, {
	headers: {
		"content-type": "application/x-ndjson",
		"cache-control": "no-cache",
	},
});
```

> **重要时序问题**：`ReadableStream` 的 `start` 是同步执行的，但 `write` 闭包在 `start` 里赋值。`handleBridgeStream` 是 async 的，它的 `await ctx.handleTool` 期间 `write` 必须已就绪。由于 `new ReadableStream` 的 `start` 在构造时同步运行，`write` 在 `await handleBridgeStream` 前已被赋值——**但 `controller.enqueue` 写入的数据只有在 Response 被 return 后才会被消费方读取**。
>
> 这里的关键：我们需要在 `handleTool` 执行**期间**就能 enqueue（这样进度帧是流式产出的，而不是全部攒到最后）。当前写法 `await handleBridgeStream` 会阻塞到所有帧写完才 return Response——**这违背了流式语义**（消费方要等 Response return 才开始读，进度帧其实是攒齐后一次性发的）。
>
> **修正**：不能 `await handleBridgeStream` 再 return。必须 return Response 在前，handleBridgeStream 在后台跑、边跑边 enqueue。见 Step 2 修正。

- [ ] **Step 2: 修正为真正的流式（return Response 在前，执行在后）**

把 Step 1 改为：
```ts
const enc = new TextEncoder();
let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
const stream = new ReadableStream<Uint8Array>({
	start(controller) { controllerRef = controller; },
});
const toolName = (body as any)?.tool;
// 后台执行：不 await，边跑边 enqueue 帧，结束后 close
void handleBridgeStream(body, (line) => {
	controllerRef?.enqueue(enc.encode(line));
}).then((r) => {
	if (r) {
		// 非流式工具：把结果也写成一帧（或退化为错误帧），保持统一
		const frame = r.ok
			? { type: "final", tool: toolName, toolCallId: (body as any).toolCallId, ok: true, result: r.result }
			: { type: "final", tool: toolName, toolCallId: (body as any).toolCallId, ok: false, error: r.error };
		controllerRef?.enqueue(enc.encode(JSON.stringify(frame) + "\n"));
	}
	controllerRef?.close();
}).catch(() => {
	controllerRef?.close();
});
return new Response(stream, {
	headers: { "content-type": "application/x-ndjson", "cache-control": "no-cache" },
});
```
这样 Response 立即返回（fetch 拿到响应头，满足 headersTimeout），handleBridgeStream 在后台边跑边 enqueue 进度帧（消费方边读边收到，重置 bodyTimeout）。

- [ ] **Step 3: 跑现有 bridge 测试**

```bash
cd /Users/pipi/work/HiAgent && bun test packages/kernel/tests/bridge.test.ts 2>&1 | tail -15
```
预期：PASS（bridge.test.ts 的全链路 HTTP 测试会覆盖新端点）。若有测试因响应格式变化失败，更新断言（delegate 的响应现在是 NDJSON 而非 JSON）。

- [ ] **Step 4: Commit**

```bash
git add packages/kernel/src/ws-server.ts
git commit -m "feat(ws-server): /bridge/tool 端点 delegate/fleet 返回 NDJSON 流式响应"
```

---

### Task 7: wa-pi-bridge 扩展 callBridge 流式读取

**Files:**
- Modify: `packages/kernel/src/wa-pi-bridge.extension.ts:64-119`（callBridge）、`:43`（DELEGATE_TIMEOUT_MS 收窄）
- Test: `packages/kernel/tests/bridge-extension.test.ts`（新增，或并入 bridge.test.ts）

**Interfaces:**
- Consumes: NDJSON 流（Task 6 产出）
- Produces: callBridge 对流式响应逐行读帧，final 帧组装 BridgeToolResult

- [ ] **Step 1: DELEGATE_TIMEOUT_MS 收窄**

`wa-pi-bridge.extension.ts:43`：
```ts
const DELEGATE_TIMEOUT_MS = 600_000; // delegate/fleet：10 分钟无任何帧才判死（流式后"无帧"才是真卡死）
```

- [ ] **Step 2: 写失败测试——callBridge 流式读取（mock fetch 返回 NDJSON）**

在 `packages/kernel/tests/bridge-extension.test.ts`（新增）：
```ts
import { test, expect } from "bun:test";

// callBridge 是模块内私有函数，经 execute 间接测；这里直接测 delegate 工具的 execute
// 需要 import 扩展 default 并 mock pi.registerTool 捕获 execute
test("delegate execute 读取 NDJSON 流并组装最终结果", async () => {
	// mock fetch 返回 3 行 NDJSON
	const ndjson = [
		JSON.stringify({ type: "started", protocol: 1, tool: "delegate", toolCallId: "tc1" }),
		JSON.stringify({ type: "progress", tool: "delegate", toolCallId: "tc1", progress: { agent: "a", status: "running", output: "x", tools: [], elapsedMs: 1 } }),
		JSON.stringify({ type: "final", tool: "delegate", toolCallId: "tc1", ok: true, result: { content: [{ type: "text", text: "子代理结果" }] } }),
	].join("\n") + "\n";
	const origFetch = globalThis.fetch;
	globalThis.fetch = (async () => ({
		ok: true,
		status: 200,
		body: new ReadableStream({
			start(c) {
				c.enqueue(new TextEncoder().encode(ndjson));
				c.close();
			},
		}),
		json: async () => ({}),
	})) as any;

	// 注入 bridge 环境变量（模块顶部读取）
	process.env.WA_PI_BRIDGE_URL = "http://test";
	process.env.WA_PI_BRIDGE_TOKEN = "t";
	process.env.WA_PI_SESSION_ID = "s";

	const mod = await import("../src/wa-pi-bridge.extension.ts");
	const registered: any[] = [];
	const fakePi = { registerTool: (t: any) => registered.push(t) };
	mod.default(fakePi);
	const delegateTool = registered.find((t) => t.name === "delegate");
	const res = await delegateTool.execute("tc1", { agent: "general-purpose", task: "hi" }, new AbortController().signal);

	globalThis.fetch = origFetch;
	expect(res.content[0].text).toBe("子代理结果");
});

test("流中断（无 final）退化为错误结果", async () => {
	const ndjson = JSON.stringify({ type: "started", protocol: 1, tool: "delegate", toolCallId: "tc2" }) + "\n";
	const origFetch = globalThis.fetch;
	globalThis.fetch = (async () => ({
		ok: true, status: 200,
		body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(ndjson)); c.close(); } }),
		json: async () => ({}),
	})) as any;
	process.env.WA_PI_BRIDGE_URL = "http://test";
	process.env.WA_PI_BRIDGE_TOKEN = "t";
	process.env.WA_PI_SESSION_ID = "s";
	const mod = await import("../src/wa-pi-bridge.extension.ts");
	const registered: any[] = [];
	mod.default({ registerTool: (t: any) => registered.push(t) });
	const delegateTool = registered.find((t) => t.name === "delegate");
	const res = await delegateTool.execute("tc2", { agent: "general-purpose", task: "hi" }, new AbortController().signal);
	globalThis.fetch = origFetch;
	expect(res.details?.error).toBeTruthy();
	expect(res.content[0].text).toContain("bridge 调用失败");
});
```

- [ ] **Step 3: 运行测试验证失败**

```bash
cd /Users/pipi/work/HiAgent && bun test packages/kernel/tests/bridge-extension.test.ts 2>&1 | tail -15
```
预期：FAIL（当前 callBridge 用 `await res.json()`，读不了流）。

- [ ] **Step 4: 改 callBridge 支持 NDJSON 流式读取**

`wa-pi-bridge.extension.ts` 的 `callBridge`，把 `const res = await fetch(...); const data = await res.json()` 那段改为：
```ts
const res = await fetch(BRIDGE_URL + "/bridge/tool", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ token: BRIDGE_TOKEN, sessionId: BRIDGE_SESSION_ID, toolCallId, tool, params }),
	signal: ctrl.signal,
});
// 流式协议：读 NDJSON，按帧处理
const isStream = (res.headers.get("content-type") ?? "").includes("x-ndjson");
if (isStream && res.body) {
	const reader = res.body.getReader();
	const dec = new TextDecoder();
	let buf = "";
	let finalFrame: any = null;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true });
		const lines = buf.split("\n");
		buf = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			let frame: any;
			try { frame = JSON.parse(line); } catch { continue; }
			if (frame.type === "final") { finalFrame = frame; break; }
			// started/progress 帧仅证明存活，不消费（进度已由 kernel SSE 直推前端）
		}
		if (finalFrame) break;
	}
	if (finalFrame) {
		if (finalFrame.ok) return { content: finalFrame.result.content, details: finalFrame.result.details };
		return failResult("bridge 调用失败: " + (finalFrame.error ?? "unknown"), finalFrame.error ?? "unknown");
	}
	// 流结束但无 final 帧
	return failResult("bridge 调用失败: 连接中断（未收到 final 帧）", "stream_interrupted");
}
// 降级：非流式响应（老 kernel 或 ask/memory），走旧 JSON 解析
const data = (await res.json().catch(() => null)) as any;
if (!res.ok) {
	const errMsg = data && typeof data.error === "string" ? data.error : "http_" + res.status;
	return failResult("bridge 调用失败: " + errMsg, errMsg);
}
if (!data || !Array.isArray(data.content)) return failResult("bridge 调用失败: 响应格式非法", "invalid_response");
return { content: data.content, details: data.details };
```

- [ ] **Step 5: 跑测试验证通过**

```bash
cd /Users/pipi/work/HiAgent && bun test packages/kernel/tests/bridge-extension.test.ts 2>&1 | tail -15
```
预期：两个测试 PASS。

- [ ] **Step 6: 跑 kernel 全量测试**

```bash
cd /Users/pipi/work/HiAgent && bun test packages/kernel/tests/ 2>&1 | tail -25
```
预期：无新增失败。

- [ ] **Step 7: Commit**

```bash
git add packages/kernel/src/wa-pi-bridge.extension.ts packages/kernel/tests/bridge-extension.test.ts
git commit -m "feat(bridge-ext): callBridge 流式读取 NDJSON，超时收窄到 10 分钟"
```

---

### Task 8: 前端 session store 消费 subagent:progress

**Files:**
- Modify: `packages/frontend/src/store/session.ts`（新增 progressByToolCall state + 处理器）
- Modify: `packages/frontend/src/App.tsx` 或订阅 SSE 处（新增 onEventType("subagent:progress") 订阅）

**Interfaces:**
- Consumes: `SubagentProgressServerEvent`（Task 1）

**背景**：前端 `events.ts` 的 `onEventType(type, handler)` 按类型订阅（`:98`）。现有 `sdk:event` 在 App.tsx 订阅后调 `session.handleSDKEvent`。照此模式新增 `subagent:progress` 订阅。

- [ ] **Step 1: session store 新增 progressByToolCall state**

`packages/frontend/src/store/session.ts`，在 state 定义区加：
```ts
progressByToolCall: {} as Record<string, SubagentProgressEvent>,  // key: toolCallId
```
import：
```ts
import type { SubagentProgressEvent } from "@wa-pi/shared";
```
新增 action：
```ts
handleSubagentProgress: (sessionId: string, toolCallId: string, progress: SubagentProgressEvent) => {
	// 可选：校验 sessionId 匹配当前会话（若 store 按 session 分，则直接存）
	set((s) => ({
		progressByToolCall: { ...s.progressByToolCall, [toolCallId]: progress },
	}));
},
clearSubagentProgress: (toolCallId: string) => {
	set((s) => {
		const next = { ...s.progressByToolCall };
		delete next[toolCallId];
		return { progressByToolCall: next };
	});
},
```

- [ ] **Step 2: App.tsx 订阅 subagent:progress**

在 `packages/frontend/src/App.tsx` 找到现有 `onEventType("sdk:event", ...)` 订阅处，旁边加：
```ts
onEventType("subagent:progress", (e: any) => {
	useSessionStore.getState().handleSubagentProgress(e.sessionId, e.toolCallId, e.progress);
});
```
（确认 `onEventType` 已在组件 mount 时注册且未 cleanup——参照现有 sdk:event 的注册方式。）

- [ ] **Step 3: 写组件测试前的 store 测试（可选，纯逻辑）**

在 `packages/frontend/tests/session-progress.test.ts`（新增）：
```ts
import { test, expect } from "bun:test";
import { useSessionStore } from "../src/store/session";

test("handleSubagentProgress 存储并按 toolCallId 索引", () => {
	useSessionStore.setState({ progressByToolCall: {} });
	useSessionStore.getState().handleSubagentProgress("s1", "tc1", {
		agent: "a", status: "running", output: "x", tools: [], elapsedMs: 1,
	});
	expect(useSessionStore.getState().progressByToolCall["tc1"].output).toBe("x");
});
```

- [ ] **Step 4: 跑测试**

```bash
cd /Users/pipi/work/HiAgent && bun test packages/frontend/tests/session-progress.test.ts 2>&1 | tail -10
```
预期：PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/store/session.ts packages/frontend/src/App.tsx packages/frontend/tests/session-progress.test.ts
git commit -m "feat(frontend): session store 消费 subagent:progress 事件，按 toolCallId 索引"
```

---

### Task 9: DelegateCard 默认折叠展示进度摘要

**Files:**
- Modify: `packages/frontend/src/components/blocks/DelegateCard.tsx`
- Test: `packages/frontend/tests/DelegateCard.test.tsx`

**Interfaces:**
- Consumes: `useSessionStore.getState().progressByToolCall[toolCall.id]`

**渲染规则**：
- 默认折叠：一行摘要 `子智能体 · {状态} · {耗时}s · {工具数} 个工具调用`
- 展开后：完整 output（可滚动）+ 工具时间线
- 完成/失败也默认折叠

- [ ] **Step 1: 写失败测试——折叠态显示摘要、展开态显示详情**

在 `packages/frontend/tests/DelegateCard.test.tsx` 加：
```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { DelegateCard } from "../src/components/blocks/DelegateCard";
import { useSessionStore } from "../src/store/session";

test("有进度时默认折叠显示摘要，展开后显示 output 和工具", () => {
	useSessionStore.setState({
		progressByToolCall: {
			"tc-1": {
				agent: "general-purpose",
				status: "running",
				output: "正在分析代码",
				tools: [{ id: "t1", name: "Bash", status: "done" }, { id: "t2", name: "Read", status: "running" }],
				elapsedMs: 12000,
			},
		},
	});
	render(<DelegateCard sessionId="s1" toolCall={{ id: "tc-1", name: "delegate", input: { agent: "general-purpose", task: "hi" } } as any} />);
	// 摘要可见
	expect(screen.getByText(/运行中/)).toBeTruthy();
	expect(screen.getByText(/2 个工具/)).toBeTruthy();
	// output 默认不可见
	expect(screen.queryByText("正在分析代码")).toBeNull();
	// 展开后可见
	fireEvent.click(screen.getByText(/展开|▶/));
	expect(screen.getByText("正在分析代码")).toBeTruthy();
});
```

- [ ] **Step 2: 运行测试验证失败**

```bash
cd /Users/pipi/work/HiAgent && bun test packages/frontend/tests/DelegateCard.test.tsx 2>&1 | tail -15
```
预期：FAIL（当前无进度渲染逻辑）。

- [ ] **Step 3: DelegateCard 改造**

读 `DelegateCard.tsx` 现有结构，加入：
```tsx
import { useState } from "react";
import { useSessionStore } from "../../store/session";

// 在组件内：
const progress = useSessionStore((s) => s.progressByToolCall[toolCall.id]);
const [expanded, setExpanded] = useState(false);
```
渲染逻辑（在原有"执行中"占位处替换）：
```tsx
{progress && !result && (
	<div className="delegate-progress">
		<div className="summary" onClick={() => setExpanded(!expanded)}>
			<span>子智能体 · {progress.status === "running" ? "运行中" : progress.status === "done" ? "完成" : "出错"}</span>
			<span> · {Math.round(progress.elapsedMs / 1000)}s · {progress.tools.length} 个工具</span>
			<span>{expanded ? "▼" : "▶"}</span>
		</div>
		{expanded && (
			<div className="details">
				{progress.output && <pre className="output">{progress.output}</pre>}
				{progress.tools.length > 0 && (
					<ul className="tools">
						{progress.tools.map((t) => (
							<li key={t.id}>{t.name} · {t.status}</li>
						))}
					</ul>
				)}
			</div>
		)}
	</div>
)}
```
> className 沿用项目现有样式约定（参考相邻卡片）。完成态（`result` 存在时）保持原渲染，但也可加折叠——按现有完成态逻辑调整。

- [ ] **Step 4: 跑测试验证通过**

```bash
cd /Users/pipi/work/HiAgent && bun test packages/frontend/tests/DelegateCard.test.tsx 2>&1 | tail -15
```
预期：PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/components/blocks/DelegateCard.tsx packages/frontend/tests/DelegateCard.test.tsx
git commit -m "feat(DelegateCard): 默认折叠展示子代理进度摘要，展开看 output 和工具时间线"
```

---

### Task 10: FleetCard 按 agent 分组展示进度

**Files:**
- Modify: `packages/frontend/src/components/blocks/FleetCard.tsx`
- Test: `packages/frontend/tests/FleetCard.test.tsx`

**背景**：fleet 所有子任务共享同一个 toolCallId，进度帧用 `progress.agent` 区分各子代理。前端把同一个 toolCallId 下的进度按 agent 聚合。需要 store 支持"按 toolCallId 取多个 agent 进度"——由于 `progressByToolCall` 是单值（最后到达的覆盖），fleet 需改为存数组或 map。

- [ ] **Step 1: 调整 store 支持 fleet 多 agent 进度**

`session.ts` 的 `progressByToolCall` 改为按 toolCallId 存 `Record<agentName, SubagentProgressEvent>`：
```ts
progressByToolCall: {} as Record<string, Record<string, SubagentProgressEvent>>,  // [toolCallId][agent]
handleSubagentProgress: (sessionId, toolCallId, progress) => {
	set((s) => {
		const prev = s.progressByToolCall[toolCallId] ?? {};
		return {
			progressByToolCall: { ...s.progressByToolCall, [toolCallId]: { ...prev, [progress.agent]: progress } },
		};
	});
},
```
DelegateCard 的取值相应改为 `progressByToolCall[toolCall.id]?.[""]`（单 agent 时 agent 名即子代理名）——**或保留单值语义给 delegate，fleet 单独处理**。为简化，统一用 map：DelegateCard 取 `Object.values(map)[0]`。

- [ ] **Step 2: 写失败测试——FleetCard 按 agent 分组**

```tsx
test("FleetCard 按 agent 分组展示进度摘要", () => {
	useSessionStore.setState({
		progressByToolCall: {
			"tc-fleet": {
				"agent-a": { agent: "agent-a", status: "running", output: "a", tools: [], elapsedMs: 1000 },
				"agent-b": { agent: "agent-b", status: "done", output: "b", tools: [], elapsedMs: 2000 },
			},
		},
	});
	render(<FleetCard sessionId="s1" toolCall={{ id: "tc-fleet", name: "fleet", input: { tasks: [] } } as any} />);
	// 摘要：2 个子智能体：1 运行中 / 1 完成
	expect(screen.getByText(/1 运行中/)).toBeTruthy();
});
```

- [ ] **Step 3: 运行验证失败 → 实现 → 验证通过**

参照 DelegateCard 模式，FleetCard 渲染摘要 + 分组列表（每组同 DelegateCard 展开态）。

```bash
cd /Users/pipi/work/HiAgent && bun test packages/frontend/tests/FleetCard.test.tsx 2>&1 | tail -15
```

- [ ] **Step 4: Commit**

```bash
git add packages/frontend/src/components/blocks/FleetCard.tsx packages/frontend/src/store/session.ts packages/frontend/tests/FleetCard.test.tsx
git commit -m "feat(FleetCard): 按 agent 分组展示子代理进度，默认折叠"
```

---

### Task 11: 集成验证 + API 接口测试 + CHANGELOG

**Files:**
- Test: 手动/curl 集成测试
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 启动 kernel，curl 验证 /bridge/tool 流式响应**

启动开发服务后，构造一个 delegate 的 bridge 请求（需有效 token，可从日志或临时打印获取）：
```bash
# token 和 sessionId 需替换为实际的（启动一个会话后从 kernel 日志或注入点拿）
curl -N -X POST http://localhost:<port>/bridge/tool \
  -H "content-type: application/json" \
  -d '{"token":"<token>","sessionId":"<sid>","toolCallId":"tc-int-1","tool":"delegate","params":{"agent":"general-purpose","task":"列出当前目录文件"}}'
```
预期：
- 响应头 `content-type: application/x-ndjson`
- body 逐行输出 started → progress（多次）→ final
- 不再出现 5 分钟超时（可跑一个耗时 > 5min 的任务验证）

- [ ] **Step 2: 验证非流式工具仍走旧路径**

```bash
curl -X POST http://localhost:<port>/bridge/tool \
  -H "content-type: application/json" \
  -d '{"token":"<token>","sessionId":"<sid>","toolCallId":"tc-int-2","tool":"memory_add","params":{"target":"global","content":"test"}}'
```
预期：返回普通 JSON（非 NDJSON）。

- [ ] **Step 3: 跑全量测试**

```bash
cd /Users/pipi/work/HiAgent && bun test packages/kernel/tests/ packages/frontend/tests/ 2>&1 | tail -30
```
预期：全部通过。

- [ ] **Step 4: 更新 CHANGELOG.md**

在 `CHANGELOG.md` 顶部新增：
```markdown
## 2026-07-31

- **新增功能** — 流式 bridge + 子代理进度直推前端
  - 根因修复：delegate/fleet 的 bridge 调用从一次性阻塞改为 NDJSON 流式（started→progress→final），根治子代理执行超 5 分钟被 undici idle timeout 砍断（"bridge 调用失败: The operation timed out."）的问题。
  - 实时显示：接通 agent-manager.ts:534 断点闲置的 SubagentProgressEvent 管道，子代理执行过程经 SSE 实时推给前端，DelegateCard/FleetCard 默认折叠展示摘要、展开看 output 和工具时间线。
  - 影响范围：packages/shared（types）、packages/kernel（bridge-registry/agent-manager/ws-server/wa-pi-bridge.extension）、packages/frontend（store/DelegateCard/FleetCard）
```

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md
git commit -m "test+docs: 流式 bridge 集成验证 + CHANGELOG"
```

---

## Self-Review

**1. Spec 覆盖**：
- 根因（undici 5min idle timeout）→ Task 6（流式 Response 持续 flush）+ Task 7（bridge 读流）覆盖 ✓
- 流式协议（started/progress/final）→ Task 4（写）+ Task 7（读）覆盖 ✓
- 进度直推前端 → Task 5（断点修复）+ Task 8（store）+ Task 9/10（卡片）覆盖 ✓
- toolCallId 透传 → Task 3 覆盖 ✓
- 默认折叠 → Task 9/10 覆盖 ✓
- 向后兼容（非流式工具不变）→ Task 4（STREAM_TOOLS）+ Task 6/7 降级覆盖 ✓
- ask/memory 不变 → Task 4 分流覆盖 ✓

**2. 占位符扫描**：Task 5 Step 5 的 agent-manager 测试标注了"若 setup 过重可降级"——这是合理的灵活性，但应尽量提供完整测试。Task 9/10 的 className 标注"沿用项目现有"——可接受（前端样式不在本计划硬编码范围）。无 TBD/TODO。

**3. 类型一致性**：`SubagentProgressEvent`（Task 1 定义于 shared）在 Task 2-10 全程一致引用；`BridgeStreamFrame`（Task 1）在 Task 4 写、Task 7 读，字段名 type/tool/toolCallId/progress/result/error 一致；`handleTool` 第 5 参数 `onProgress?: (e: SubagentProgressEvent) => void`（Task 4）与 Task 5 透传一致。

**4. 已知风险**：
- Task 5 的 `currentSubagentOnProgress` 槽位方案有并发隐患（fleet 并发多子代理时槽位被覆盖）——fleet 的进度靠 `progress.agent` 区分，slot 只存"最新回调指针"，但 fleet 并发时多个 onProgress 可能交错。**缓解**：slot 只在单次 handleTool 调用内有效，fleet 虽并发但都在同一个 handleTool await 内，onProgress 闭包是同一个。需 Task 10 验证 fleet 多 agent 进度不串。
- Task 6 的 `controllerRef` 在 `ReadableStream.start` 赋值，后台 async 写入——需确认 Bun 的 ReadableStream 支持在 start 之外 enqueue（标准 Web Stream 支持，Bun 应兼容，Task 11 curl 验证）。

## Execution Handoff

计划已保存到 `docs/superpowers/plans/2026-07-31-streaming-bridge-subagent-progress.md`。两种执行方式：

**1. Subagent-Driven（推荐）** — 每个 Task 派发独立子代理，任务间 review，快速迭代。

**2. Inline Execution** — 在当前会话按 executing-plans 批量执行，带检查点。

选哪种？
