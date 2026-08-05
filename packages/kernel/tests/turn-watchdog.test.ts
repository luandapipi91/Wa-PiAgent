// turn-watchdog.test.ts — checkStuckSessions（turn 静默看门狗）单元测试
//
// 背景：pi 的 LLM 请求静默挂起（半开连接 / 代理挂死 / httpIdleTimeout 配为 disabled）时
// 不发任何事件，kernel 此前无超时机制 → 前端永远"对话中"。看门狗对 busy 且静默超阈值的
// 会话主动 abort + 合成 message_end{stopReason:"error"} 播报（classifySdkError 默认归
// fatal → 前端红色错误 + failTurn 复位）。
//
// 排除条件（合法长静默，不得误杀）：
//   - 工具执行中（长 bash / delegate 子代理）
//   - 上下文压缩中（大摘要 LLM 调用可能数分钟无事件）
//   - 扩展 dialog 等待用户应答（可无限挂起）
//
// 构造范式与 idle-reap.test.ts 一致。
import { test, expect, afterEach } from "bun:test";
import { AgentManager } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import { extUiRegistry } from "../src/ext-ui-registry";
import { fakeClientFactory, FakeSessionClient } from "./fixtures/fake-session-client";
import { rmSync } from "node:fs";

const managers: AgentManager[] = [];
const tmpFiles: string[] = [];

afterEach(async () => {
	for (const am of managers.splice(0)) await am.disposeAll().catch(() => {});
	for (const f of tmpFiles.splice(0)) {
		try { rmSync(f, { force: true, recursive: true }); } catch {}
	}
	extUiRegistry.reset();
});

async function setup() {
	const tmpFile = `/tmp/wa-pi-turn-watchdog-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
	tmpFiles.push(tmpFile);
	const projectStore = new ProjectStore(tmpFile);
	const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
	const session = await projectStore.createSession({
		projectId: project.id, primaryAgent: "dev", title: "t",
	});
	const fakes: FakeSessionClient[] = [];
	const events: Array<{ sessionId: string; event: any }> = [];
	const am = new AgentManager({
		projectStore,
		configStore: null,
		onEvent: (sessionId, _projectId, _agentName, event) => {
			events.push({ sessionId, event });
		},
		createClientFn: fakeClientFactory(fakes),
	});
	managers.push(am);
	await am.ensureStarted(project.id, "dev", session.id);
	return { session, am, fakes, events };
}

/** 把会话置于"busy 且静默 durationMs"的挂起状态 */
function makeStuck(am: AgentManager, sessionId: string, durationMs: number) {
	const handle = (am as any).sessions.get(sessionId) as any;
	handle.busy = true;
	handle.thinkingSince = Date.now() - durationMs;
	handle.lastEventAt = Date.now() - durationMs;
	return handle;
}

test("busy 且静默超阈值 → 主动 abort + 合成 fatal 错误事件 + 复位 busy", async () => {
	const { session, am, fakes, events } = await setup();
	makeStuck(am, session.id, 400_000); // 静默 400s（阈值 360s）

	const stuck = am.checkStuckSessions(360_000);

	expect(stuck).toEqual([session.id]);
	expect(fakes[0].aborts).toBe(1); // 主动断开
	const handle = (am as any).sessions.get(session.id) as any;
	expect(handle.busy).toBe(false);
	expect(handle.thinkingSince).toBeNull();
	// 合成 message_end{stopReason:"error"}：走 classifySdkError 默认归 fatal → 前端红色报错
	const errEvents = events.filter(
		(e) =>
			e.event.type === "message_end" &&
			e.event.message?.stopReason === "error",
	);
	expect(errEvents).toHaveLength(1);
	expect(errEvents[0].event.message.errorMessage).toContain("主动断开");
	// 文案不得命中 transient 正则（否则前端只挂 degraded 状态条、不进对话流）
	expect(errEvents[0].event.message.errorMessage).not.toMatch(
		/timeout|timed.?out|terminated|connection|network/i,
	);
});

test("静默未超阈值 → 不触发", async () => {
	const { session, am, fakes } = await setup();
	makeStuck(am, session.id, 60_000); // 静默 60s（阈值 360s）

	expect(am.checkStuckSessions(360_000)).toEqual([]);
	expect(fakes[0].aborts).toBe(0);
});

test("工具执行中（长 bash / delegate）→ 合法静默，不触发", async () => {
	const { session, am, fakes } = await setup();
	const handle = makeStuck(am, session.id, 400_000);
	handle.activeTools = 1;

	expect(am.checkStuckSessions(360_000)).toEqual([]);
	expect(fakes[0].aborts).toBe(0);
});

test("上下文压缩中 → 合法静默，不触发", async () => {
	const { session, am, fakes } = await setup();
	const handle = makeStuck(am, session.id, 400_000);
	handle.compacting = true;

	expect(am.checkStuckSessions(360_000)).toEqual([]);
	expect(fakes[0].aborts).toBe(0);
});

test("扩展 dialog 等待用户应答 → 合法静默，不触发", async () => {
	const { session, am, fakes } = await setup();
	makeStuck(am, session.id, 400_000);
	void extUiRegistry.register(session.id, {
		type: "extension_ui_request",
		id: "req-1",
		method: "confirm",
	} as any);

	expect(am.checkStuckSessions(360_000)).toEqual([]);
	expect(fakes[0].aborts).toBe(0);
});

test("非 busy 会话 → 不触发（看门狗只管挂起的 turn）", async () => {
	const { session, am, fakes } = await setup();
	const handle = makeStuck(am, session.id, 400_000);
	handle.busy = false;

	expect(am.checkStuckSessions(360_000)).toEqual([]);
	expect(fakes[0].aborts).toBe(0);
});

test("事件流动刷新 lastEventAt：tool_execution/compaction 事件驱动排除字段", async () => {
	const { session, am, fakes } = await setup();
	makeStuck(am, session.id, 400_000);
	// 事件经过 _onSessionEvent 后 lastEventAt 刷新 → 不再判为静默
	fakes[0].emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" } } as any);
	expect(am.checkStuckSessions(360_000)).toEqual([]);

	// tool_execution_start/end 维护 activeTools 计数（含 clamp 不为负）
	fakes[0].emit({ type: "tool_execution_start", toolName: "bash" } as any);
	const handle = (am as any).sessions.get(session.id) as any;
	expect(handle.activeTools).toBe(1);
	fakes[0].emit({ type: "tool_execution_end", toolName: "bash" } as any);
	expect(handle.activeTools).toBe(0);
	fakes[0].emit({ type: "tool_execution_end", toolName: "bash" } as any);
	expect(handle.activeTools).toBe(0); // clamp

	// compaction_start/end 维护 compacting 标记
	fakes[0].emit({ type: "compaction_start" } as any);
	expect(handle.compacting).toBe(true);
	fakes[0].emit({ type: "compaction_end" } as any);
	expect(handle.compacting).toBe(false);
});
