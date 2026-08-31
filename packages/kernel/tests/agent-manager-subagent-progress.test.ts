// Task 5 单测：验证子代理进度管道 onProgress → onSubagentProgress 接通正确。
//
// 触发链路（RPC 迁移后真实路径）：
//   getBridgeSession(sessionId).handleTool("delegate", toolCallId, params, signal, onProgress)
//   → delegateTool.execute → spawnFn
//   → runSubagentAgent（此处 mock：调用 opts.onProgress 触发进度帧，再返回成功）
//   → spawnFn 的 onProgress 闭包：先从槽位取 handleTool 注入的 onProgress 转发，
//     再调 this.opts.onSubagentProgress(sessionId, toolCallId, event) 广播到 SSE。
//
// 本文件覆盖三点：
// 1. handleTool 的 onProgress 参数被 spawn 闭包正确转发（槽位透传）
// 2. onSubagentProgress 被触发且携带正确 sessionId / toolCallId / event
// 3. fleet 并发多子代理共享同一 onProgress + toolCallId（槽位在 handleTool await 期间稳定）
//
// mock 策略：mock.module("../src/subagent-runner") 进程级生效，捕获 runSubagentAgent
// 收到的 onProgress 并立即触发一次进度帧（不真正 spawn 子进程）。
import { test, expect, mock, afterEach } from "bun:test";
import { AgentManager } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import {
	type FakeSessionClient,
	fakeClientFactory,
} from "./fixtures/fake-session-client";
import { NOOP_BROWSER_MANAGER } from "./helpers/fake-browser-manager";
import { getBridgeSession } from "../src/bridge-registry";
import { WA_PI_DIR } from "@wa-pi/shared";
import { rmSync } from "node:fs";
import { join } from "node:path";

// ─── Mock：subagent-runner ───────────────────────────────────────────────────
// 捕获 runSubagentAgent 收到的 opts.onProgress 并触发一次确定性进度帧，
// 让 spawn 闭包的 onProgress 链路被实际执行（验证槽位 + onSubagentProgress 接线）。
// 不真正 spawn 子进程，避免依赖 pi CLI / 网络。
const capturedProgressCbs: Array<{
	toolCallId: string | null;
	cb: (event: any) => void;
}> = [];
mock.module("../src/subagent-runner", () => ({
	runSubagentAgent: mock(
		async (_config: any, _task: string, _cwd: string, opts: any) => {
			// 记录本次调用的 onProgress（spawn 闭包注入 toolCallId 后包了一层），
			// 并立即触发一次 running 进度帧验证整条链路
			if (typeof opts?.onProgress === "function") {
				capturedProgressCbs.push({ toolCallId: null, cb: opts.onProgress });
				opts.onProgress({
					agent: _config?.name ?? "test-agent",
					status: "running",
					output: "mock 进度",
					tools: [],
					elapsedMs: 1,
				});
			}
			return { text: "ok", isError: false, elapsedMs: 1 };
		},
	),
}));

const managers: AgentManager[] = [];

afterEach(async () => {
	for (const am of managers.splice(0)) await am.disposeAll().catch(() => {});
	capturedProgressCbs.length = 0;
});

function newProjectStore() {
	const tmpFile = `/tmp/wa-pi-am-progress-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
	return new ProjectStore(tmpFile);
}

function cleanupPromptFile(sessionId: string) {
	try {
		rmSync(join(WA_PI_DIR, "tmp", "sysprompts", `${sessionId}.md`), {
			force: true,
		});
	} catch {
		/* 清理临时提示词文件，不存在即忽略 */
	}
}

const devConfig = { displayName: "dev", partners: { askTo: [] } };

test("delegate：handleTool 的 onProgress 被转发 + onSubagentProgress 携带正确 sessionId/toolCallId", async () => {
	const projectStore = newProjectStore();
	const project = await projectStore.createProject({
		name: "测试",
		cwd: "/tmp",
	});
	const session = await projectStore.createSession({
		projectId: project.id,
		primaryAgent: "dev",
		title: "测试",
	});
	const sessionId = session.id;
	const toolCallId = "tc-delegate-001";

	// handleTool 的 onProgress：经 handleBridgeStream 注入，emit 闭包已绑定 toolCallId
	const forwardedToHandle: any[] = [];
	const handleOnProgress = (event: any) => forwardedToHandle.push(event);

	// 会话级广播出口：spawn 闭包 onProgress 末段调用，注入 sessionId
	const broadcasted: Array<{
		sessionId: string;
		toolCallId: string;
		event: any;
	}> = [];
	const fakes: FakeSessionClient[] = [];
	const am = new AgentManager({
		projectStore,
		configStore: { getAgent: mock(async () => devConfig) } as any,
		onEvent: () => {},
		onSubagentProgress: (sid, tcId, event) =>
			broadcasted.push({ sessionId: sid, toolCallId: tcId, event }),
		createClientFn: fakeClientFactory(fakes),
		browserManager: NOOP_BROWSER_MANAGER,
	});
	managers.push(am);
	await am.ensureStarted(project.id, "dev", sessionId);

	const ctx = getBridgeSession(sessionId);
	expect(ctx).toBeDefined();
	// handleTool 第 5 个参数 onProgress：流式 bridge 经 handleBridgeStream 注入
	await ctx!.handleTool(
		"delegate",
		toolCallId,
		{ agent: "Plan", task: "设计个方案" },
		new AbortController().signal,
		handleOnProgress,
	);

	// 1. handleTool 的 onProgress 被转发（槽位透传成功）：收到一次 running 帧
	expect(forwardedToHandle.length).toBe(1);
	expect(forwardedToHandle[0]).toMatchObject({
		status: "running",
		output: "mock 进度",
	});

	// 2. onSubagentProgress 被触发，参数含正确 sessionId 与本次调用的 toolCallId
	expect(broadcasted.length).toBe(1);
	expect(broadcasted[0].sessionId).toBe(sessionId);
	expect(broadcasted[0].toolCallId).toBe(toolCallId);
	expect(broadcasted[0].event).toMatchObject({
		status: "running",
		agent: "Plan",
	});

	cleanupPromptFile(sessionId);
});

test("fleet：并发多子代理共享同一 onProgress + toolCallId，槽位期间稳定不串", async () => {
	const projectStore = newProjectStore();
	const project = await projectStore.createProject({
		name: "测试",
		cwd: "/tmp",
	});
	const session = await projectStore.createSession({
		projectId: project.id,
		primaryAgent: "dev",
		title: "测试",
	});
	const sessionId = session.id;
	const fleetToolCallId = "tc-fleet-001";

	const forwardedToHandle: any[] = [];
	const handleOnProgress = (event: any) => forwardedToHandle.push(event);

	const broadcasted: Array<{
		sessionId: string;
		toolCallId: string;
		event: any;
	}> = [];
	const fakes: FakeSessionClient[] = [];
	const am = new AgentManager({
		projectStore,
		configStore: { getAgent: mock(async () => devConfig) } as any,
		onEvent: () => {},
		onSubagentProgress: (sid, tcId, event) =>
			broadcasted.push({ sessionId: sid, toolCallId: tcId, event }),
		createClientFn: fakeClientFactory(fakes),
		browserManager: NOOP_BROWSER_MANAGER,
	});
	managers.push(am);
	await am.ensureStarted(project.id, "dev", sessionId);

	const ctx = getBridgeSession(sessionId);
	// fleet 派发 3 个内置类型子任务，共享同一个 fleet 工具调用的 toolCallId
	await ctx!.handleTool(
		"fleet",
		fleetToolCallId,
		{
			tasks: [
				{ agent: "Explore", task: "搜 A" },
				{ agent: "Plan", task: "设计 B" },
				{ agent: "general-purpose", task: "通用 C" },
			],
		},
		new AbortController().signal,
		handleOnProgress,
	);

	// 3 个子代理各触发一次 running 帧：handleTool 的 onProgress 应被转发 3 次
	expect(forwardedToHandle.length).toBe(3);
	// onSubagentProgress 同样 3 次，全部带 fleet 的 toolCallId + 会话 sessionId（不串到别的 toolCallId）
	expect(broadcasted.length).toBe(3);
	expect(broadcasted.every((b) => b.toolCallId === fleetToolCallId)).toBe(true);
	expect(broadcasted.every((b) => b.sessionId === sessionId)).toBe(true);
	// 3 个子代理名应分别出现在广播事件里（fleet 内部按 agent 区分）
	const agents = broadcasted.map((b) => b.event.agent).sort();
	expect(agents).toEqual(["Explore", "Plan", "general-purpose"].sort());
	// taskIndex 端到端透传：3 个子任务各带不同 taskIndex（0/1/2），前端 FleetCard 据此区分同名任务
	const indices = broadcasted
		.map((b) => b.event.taskIndex)
		.sort((a, b) => a - b);
	expect(indices).toEqual([0, 1, 2]);

	cleanupPromptFile(sessionId);
});

test("fleet：同名 agent 多任务各带不同 taskIndex 透传到广播（集成层忠实复现）", async () => {
	// 复现根因场景：LLM 把多个任务派给同一智能体（同名 agent），
	// 验证 taskIndex 经 fleet execute → spawn 闭包 → agent-manager → 广播全链路透传
	const projectStore = newProjectStore();
	const project = await projectStore.createProject({
		name: "测试",
		cwd: "/tmp",
	});
	const session = await projectStore.createSession({
		projectId: project.id,
		primaryAgent: "dev",
		title: "测试",
	});
	const sessionId = session.id;

	const broadcasted: Array<{
		sessionId: string;
		toolCallId: string;
		event: any;
	}> = [];
	const fakes: FakeSessionClient[] = [];
	const am = new AgentManager({
		projectStore,
		configStore: { getAgent: mock(async () => devConfig) } as any,
		onEvent: () => {},
		onSubagentProgress: (sid, tcId, event) =>
			broadcasted.push({ sessionId: sid, toolCallId: tcId, event }),
		createClientFn: fakeClientFactory(fakes),
		browserManager: NOOP_BROWSER_MANAGER,
	});
	managers.push(am);
	await am.ensureStarted(project.id, "dev", sessionId);

	const ctx = getBridgeSession(sessionId);
	// 同名 agent 派发 2 个任务
	await ctx!.handleTool(
		"fleet",
		"tc-fleet-dup",
		{
			tasks: [
				{ agent: "Explore", task: "搜 A" },
				{ agent: "Explore", task: "搜 B" },
			],
		},
		new AbortController().signal,
		() => {},
	);

	// 两个同名 agent 任务各触发一次广播
	expect(broadcasted.length).toBe(2);
	// taskIndex 各不相同（0 和 1），前端 store 据此区分，不再互相覆盖
	const indices = broadcasted
		.map((b) => b.event.taskIndex)
		.sort((a, b) => a - b);
	expect(indices).toEqual([0, 1]);
	// 两个事件都是 Explore（同名），但靠 taskIndex 区分
	expect(broadcasted.every((b) => b.event.agent === "Explore")).toBe(true);

	cleanupPromptFile(sessionId);
});

test("handleTool 未传 onProgress 时 onSubagentProgress 仍被触发（槽位为空走广播出口）", async () => {
	// 覆盖非流式调用路径：handleTool 不传第 5 参（如旧同步 handleBridgeRequest 路径），
	// 槽位为空，spawn 闭包的 onProgress 仅走 onSubagentProgress 广播分支，不报错。
	const projectStore = newProjectStore();
	const project = await projectStore.createProject({
		name: "测试",
		cwd: "/tmp",
	});
	const session = await projectStore.createSession({
		projectId: project.id,
		primaryAgent: "dev",
		title: "测试",
	});
	const sessionId = session.id;

	const broadcasted: Array<{
		sessionId: string;
		toolCallId: string;
		event: any;
	}> = [];
	const fakes: FakeSessionClient[] = [];
	const am = new AgentManager({
		projectStore,
		configStore: { getAgent: mock(async () => devConfig) } as any,
		onEvent: () => {},
		onSubagentProgress: (sid, tcId, event) =>
			broadcasted.push({ sessionId: sid, toolCallId: tcId, event }),
		createClientFn: fakeClientFactory(fakes),
		browserManager: NOOP_BROWSER_MANAGER,
	});
	managers.push(am);
	await am.ensureStarted(project.id, "dev", sessionId);

	const ctx = getBridgeSession(sessionId);
	// 不传第 5 个参数 onProgress（旧同步路径）
	await ctx!.handleTool(
		"delegate",
		"tc-no-prog",
		{ agent: "Plan", task: "设计" },
		new AbortController().signal,
	);

	// 槽位为空不报错，onSubagentProgress 仍触发（spawn 闭包兜底走广播分支）
	expect(broadcasted.length).toBe(1);
	expect(broadcasted[0]).toMatchObject({ sessionId, toolCallId: "tc-no-prog" });
	expect(broadcasted[0].event).toMatchObject({ status: "running" });

	cleanupPromptFile(sessionId);
});
