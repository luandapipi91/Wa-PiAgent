// agent-manager-lifecycle.test.ts — 进程生命周期防护行为测试（2026-10-08 事故修复 · 任务 3）
//
// 对准「空闲回收 → prompt 触发重生」交接窗口事故（对方 Windows 机实证）：
// 1. 缓存命中但 projectId 变更 → 拆除重建，cwd 跟随记录归属（不继承旧目录进程，
//    会话 2 操作会话 1 工作目录事故的 kernel 侧根治）
// 2. 有 pending 消息的会话不被空闲回收（避免交接窗口被无谓放大）
// 3. 回收后立刻发消息 → 入 pending，重生进程消费（事故时序回归锁）
// 4. 同一会话并发 ensureStarted 只 spawn 一个进程（双进程防护回归锁）
// 5. dispose 后进程仍存活 → 探活重试强杀（事故实证：强杀后 31 秒 jsonl 仍有写入）
// 6. projectId 变更且会话忙碌 → 重建后排队消息仍由新进程投递（WAL 兜底，不丢消息）
import { test, expect, afterEach } from "bun:test";
import { AgentManager } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import {
	FakeSessionClient,
	fakeClientFactory,
} from "./fixtures/fake-session-client";
import { NOOP_BROWSER_MANAGER } from "./helpers/fake-browser-manager";
import { WA_PI_DIR } from "@wa-pi/shared";
import {
	clearSession as clearPending,
	enqueue as enqueuePending,
	listAll,
	pendingFile,
} from "../src/pending-messages";
import { rmSync } from "node:fs";
import { join } from "node:path";

const MODEL = "anthropic/test-model";
const P2_CWD = "/tmp/wa-pi-lifecycle-p2";

const managers: AgentManager[] = [];
const tmpFiles: string[] = [];

afterEach(async () => {
	for (const am of managers.splice(0)) await am.disposeAll().catch(() => {});
	for (const f of tmpFiles.splice(0)) {
		try {
			rmSync(f, { force: true });
		} catch {
			// 尽力清理，失败不阻断
		}
	}
});

/** 轮询等待条件满足（探活重试/重投是异步延迟链路，断言前需让出宏任务） */
async function until(
	fn: () => boolean | Promise<boolean>,
	timeoutMs = 2000,
): Promise<void> {
	const start = Date.now();
	while (!(await fn())) {
		if (Date.now() - start > timeoutMs) throw new Error("until 超时");
		await new Promise((r) => setTimeout(r, 5));
	}
}

/** 慢启动工厂：client.start 延迟 ms 毫秒（模拟冷启动进行中） */
function slowStartFactory(fakes: FakeSessionClient[], ms: number) {
	return (o: import("../src/rpc-client").RpcClientOpts) => {
		const fake = new FakeSessionClient(o);
		fake.start = async () => {
			await new Promise((r) => setTimeout(r, ms));
		};
		fakes.push(fake);
		return fake as unknown as import("../src/rpc-client").RpcClient;
	};
}

interface SetupResult {
	project: { id: string };
	session: { id: string };
	am: AgentManager;
	fakes: FakeSessionClient[];
	fake: FakeSessionClient | undefined;
	projectStore: ProjectStore;
}

/** 造测试项目 + 会话实体 + 注入 fake client 的 AgentManager（同 agent-manager-pending.test.ts） */
async function setup(
	opts: { startDelayMs?: number } = {},
): Promise<SetupResult> {
	const tmpFile = `/tmp/wa-pi-am-lifecycle-${Date.now()}-${Math.random()
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
		createClientFn: opts.startDelayMs
			? slowStartFactory(fakes, opts.startDelayMs)
			: fakeClientFactory(fakes),
		browserManager: NOOP_BROWSER_MANAGER,
	});
	managers.push(am);
	if (opts.startDelayMs) {
		am.ensureStarted(project.id, "dev", session.id).catch(() => {});
		return { project, session, am, fakes, fake: undefined, projectStore };
	}
	await am.ensureStarted(project.id, "dev", session.id);
	return { project, session, am, fakes, fake: fakes[0], projectStore };
}

test("ensureStarted 缓存命中但 projectId 变更 → 拆除重建，cwd 跟随记录归属", async () => {
	const s = await setup();
	expect(s.fakes.length).toBe(1);
	const h1 = await s.am.ensureStarted(s.project.id, "dev", s.session.id);
	expect(h1.cwd).toBe("/tmp");

	// 会话改归属到项目二（同 setSessionProjectId 纠正后的状态）
	const p2 = await s.projectStore.createProject({ name: "项目二", cwd: P2_CWD });
	await s.projectStore.setSessionProjectId(s.session.id, p2.id);

	// 复用旧进程 = 会话 2 操作会话 1 工作目录——必须拆除重建
	const h2 = await s.am.ensureStarted(p2.id, "dev", s.session.id);
	expect(h2.cwd).toBe(P2_CWD);
	expect(s.fakes.length).toBe(2); // 新进程
	expect(s.fakes[0]!.alive).toBe(false); // 旧进程已拆除
});

test("有 pending 消息的会话不被空闲回收", async () => {
	const s = await setup();
	await enqueuePending(s.session.id, { text: "未投递消息" });
	const reaped = await s.am.reapIdleSessions(-1); // threshold -1：全部视为可回收
	expect(reaped).not.toContain(s.session.id); // ← 有 pending 必须跳过
	expect(s.am.isSessionAlive(s.session.id)).toBe(true);

	// pending 清空后恢复正常回收
	await clearPending(s.session.id);
	const reaped2 = await s.am.reapIdleSessions(-1);
	expect(reaped2).toContain(s.session.id);
});

test("空闲回收后立刻发消息 → 入 pending，重生进程消费（事故时序回归）", async () => {
	const s = await setup();
	await s.am.reapIdleSessions(-1); // 回收（此刻无 pending）
	expect(s.am.isSessionAlive(s.session.id)).toBe(false);

	// 交接窗口内消息到达：不丢；kernel 层契约是只入队，重生由 ensureStarted 驱动
	// （生产中 ws-server/channel-manager 调 prompt 前必调 ensureStarted）
	await s.am.prompt(s.session.id, "交接窗口消息", { model: MODEL });
	await s.am.ensureStarted(s.project.id, "dev", s.session.id);
	await until(() => s.fakes.some((f) => f.prompted.includes("交接窗口消息")));
	await until(async () => (await listAll(s.session.id)).length === 0);
});

test("同一会话并发 ensureStarted 只 spawn 一个进程（双进程防护回归锁）", async () => {
	const s = await setup({ startDelayMs: 50 }); // 冷启动进行中
	const [a, b, c] = await Promise.all([
		s.am.ensureStarted(s.project.id, "dev", s.session.id),
		s.am.ensureStarted(s.project.id, "dev", s.session.id),
		s.am.ensureStarted(s.project.id, "dev", s.session.id),
	]);
	expect(s.fakes.length).toBe(1); // 只允许一个 pi 进程
	expect(a).toBe(b);
	expect(b).toBe(c);
});

test("dispose 后进程仍存活 → 探活重试强杀", async () => {
	const s = await setup();
	s.fake!.surviveDisposes = 1; // 第一次 dispose 强杀未落地
	await s.am.reapIdleSessions(-1); // 触发 teardown
	// 探活复查是异步延迟路径：重试 dispose 后真死
	await until(() => s.fake!.disposeCalls >= 2);
	expect(s.fake!.alive).toBe(false);
});

test("projectId 变更且会话忙碌 → 重建后排队消息仍由新进程投递（WAL 兜底）", async () => {
	const s = await setup();
	expect(s.fake).toBeTruthy();
	s.fake!.autoSettle = false;
	await s.am.prompt(s.session.id, "运行中", { model: MODEL }); // busy

	const p2 = await s.projectStore.createProject({ name: "项目二", cwd: P2_CWD });
	await s.projectStore.setSessionProjectId(s.session.id, p2.id);
	await s.am.prompt(s.session.id, "排队消息", { model: MODEL }); // busy → followUp + WAL

	const h2 = await s.am.ensureStarted(p2.id, "dev", s.session.id); // 命中重建
	expect(h2.cwd).toBe(P2_CWD);
	// 旧进程内未投递的排队消息经 WAL 由新进程重投，不丢
	await until(() => s.fakes.some((f) => f.prompted.includes("排队消息")));
});
