// agent-manager-logging.test.ts — 消息/进程全链路日志测试（2026-10-08 事故修复 · 任务 4）
//
// 背景：desktop.log 此前对 prompt/steer 收发、pending 投递确认、空闲回收、spawn
// 耗时零记录——「消息无回复无报错」事故排障时全程无痕（观测盲区）。本文件锁定
// 关键路径必须落日志的行为：
// 1. prompt 收到（sessionId/长度/图片数）
// 2. steer 收到
// 3. pending 投递确认（RPC resolve → ack 成功）
// 4. 空闲回收决定（含空闲时长）
// 5. pi 进程就绪（含 spawn 耗时）
import { test, expect, spyOn, afterEach } from "bun:test";
import { AgentManager } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import {
	FakeSessionClient,
	fakeClientFactory,
} from "./fixtures/fake-session-client";
import { NOOP_BROWSER_MANAGER } from "./helpers/fake-browser-manager";
import { WA_PI_DIR } from "@wa-pi/shared";
import { pendingFile } from "../src/pending-messages";
import { rmSync } from "node:fs";
import { join } from "node:path";

const MODEL = "anthropic/test-model";

const managers: AgentManager[] = [];
const tmpFiles: string[] = [];
let logCalls: string[] = [];
let logSpy: { mockRestore(): void } | undefined;

afterEach(async () => {
	logSpy?.mockRestore();
	logSpy = undefined;
	logCalls = [];
	for (const am of managers.splice(0)) await am.disposeAll().catch(() => {});
	for (const f of tmpFiles.splice(0)) {
		try {
			rmSync(f, { force: true });
		} catch {
			// 尽力清理，失败不阻断
		}
	}
});

/** 开启 console.log 间谍：把字符串参数收进 logCalls */
function spyLog(): void {
	logCalls = [];
	logSpy = spyOn(console, "log").mockImplementation((msg?: unknown) => {
		if (typeof msg === "string") logCalls.push(msg);
	});
}

/** 造测试项目 + 会话实体 + 注入 fake client 的 AgentManager（同其他 lifecycle 测试） */
async function setup(): Promise<{
	project: { id: string };
	session: { id: string };
	am: AgentManager;
	fake: FakeSessionClient | undefined;
}> {
	const tmpFile = `/tmp/wa-pi-am-logging-${Date.now()}-${Math.random()
		.toString(36)
		.slice(2)}.json`;
	tmpFiles.push(tmpFile);
	const projectStore = new ProjectStore(tmpFile);
	const project = await projectStore.createProject({
		name: "测试",
		cwd: "/tmp",
	});
	const session = await projectStore.createSession({
		projectId: project.id,
		primaryAgent: "dev",
		title: "测试",
	});
	tmpFiles.push(join(WA_PI_DIR, "tmp", "sysprompts", `${session.id}.md`));
	tmpFiles.push(pendingFile(session.id));

	const fakes: FakeSessionClient[] = [];
	const am = new AgentManager({
		projectStore,
		configStore: null,
		onEvent: () => {},
		createClientFn: fakeClientFactory(fakes),
		browserManager: NOOP_BROWSER_MANAGER,
	});
	managers.push(am);
	await am.ensureStarted(project.id, "dev", session.id);
	return { project, session, am, fake: fakes[0] };
}

test("prompt 收到即落日志（sessionId/长度/图片数）", async () => {
	const s = await setup();
	spyLog();
	await s.am.prompt(s.session.id, "你好", { model: MODEL });
	expect(
		logCalls.some(
			(c) =>
				c.includes(`[agent-manager] prompt session=${s.session.id}`) &&
				c.includes("len=2") &&
				c.includes("images=0"),
		),
	).toBe(true);
});

test("steer 收到即落日志", async () => {
	const s = await setup();
	expect(s.fake).toBeTruthy();
	s.fake!.autoSettle = false;
	await s.am.prompt(s.session.id, "运行中", { model: MODEL }); // 置 busy
	spyLog();
	await s.am.steerMessage(s.session.id, "引导一下");
	expect(
		logCalls.some((c) => c.includes(`[agent-manager] steer session=${s.session.id}`)),
	).toBe(true);
});

test("pending 投递确认落日志（RPC resolve → ack 成功）", async () => {
	const s = await setup();
	spyLog();
	await s.am.prompt(s.session.id, "直发消息", { model: MODEL });
	// ack 在 RPC resolve 后异步写盘，轮询等待
	const start = Date.now();
	while (!logCalls.some((c) => c.includes("pending 已投递"))) {
		if (Date.now() - start > 2000) break;
		await new Promise((r) => setTimeout(r, 5));
	}
	expect(logCalls.some((c) => c.includes("pending 已投递"))).toBe(true);
});

test("空闲回收决定落日志（含空闲时长）", async () => {
	const s = await setup();
	spyLog();
	await s.am.reapIdleSessions(-1);
	expect(
		logCalls.some(
			(c) =>
				c.includes(`[agent-manager] 空闲回收 session=${s.session.id}`) &&
				c.includes("空闲"),
		),
	).toBe(true);
});

test("pi 进程就绪落日志（含 spawn 耗时）", async () => {
	spyLog(); // 必须在 setup 之前：_createSession 在 setup 内完成
	await setup();
	expect(
		logCalls.some(
			(c) => c.includes("pi 进程就绪 session=") && c.includes("耗时="),
		),
	).toBe(true);
});
