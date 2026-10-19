// agent-manager-pending.test.ts — AgentManager 接线 pending WAL 的行为测试
//
// 验证「进程交接窗口不丢消息」的三条关键链路（2026-10-08 P0 事故修复 · 任务 1）：
// 1. handle 未就绪（冷启动中/进程被回收重建中）时 prompt → 消息入 pending WAL，
//    进程 ready 后自动重投（此前：throw session.notStarted 或静默 return）。
// 2. client.steer reject → 消息保留在 pending（此前：火后不理静默吞掉）。
// 3. abort 清空内存队列时同步清空 pending WAL（防已放弃的消息在进程重启后被
//    drain 重投「诈尸」）。
import { test, expect, afterEach } from "bun:test";
import { AgentManager } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import {
	FakeSessionClient,
	fakeClientFactory,
} from "./fixtures/fake-session-client";
import { NOOP_BROWSER_MANAGER } from "./helpers/fake-browser-manager";
import { askRegistry } from "../src/ask-registry";
import { WA_PI_DIR } from "@wa-pi/shared";
import type { RpcClient, RpcClientOpts } from "../src/rpc-client";
import { listAll, pendingFile } from "../src/pending-messages";
import { rmSync } from "node:fs";
import { join } from "node:path";

const MODEL = "anthropic/test-model";

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

/** 轮询等待条件满足（drain/重投是异步链路，断言前需让出宏任务） */
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

/** 慢启动工厂：client.start 延迟 ms 毫秒（模拟冷启动进行中，handle 未就绪） */
function slowStartFactory(fakes: FakeSessionClient[], ms: number) {
	return (o: RpcClientOpts) => {
		const fake = new FakeSessionClient(o);
		fake.start = async () => {
			await new Promise((r) => setTimeout(r, ms));
		};
		fakes.push(fake);
		return fake as unknown as RpcClient;
	};
}

interface SetupOpts {
	/** client.start 延迟毫秒数：设置时不 await ensureStarted（冷启动进行中） */
	startDelayMs?: number;
}

/** 造测试项目 + 会话实体 + 注入 fake client 的 AgentManager（同 steer-queue-poc.test.ts） */
async function setup(opts: SetupOpts = {}) {
	const tmpFile = `/tmp/wa-pi-am-pending-${Date.now()}-${Math.random()
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
		// 冷启动进行中（不等待，handle 尚未就绪）
		am.ensureStarted(project.id, "dev", session.id).catch(() => {});
		return { project, session, am, fakes, fake: undefined };
	}
	await am.ensureStarted(project.id, "dev", session.id);
	return { project, session, am, fakes, fake: fakes[0] };
}

test("handle 未就绪时 prompt → 消息进入 pending，进程 ready 后自动投递", async () => {
	const { project, session, am, fakes } = await setup({ startDelayMs: 80 });
	// 冷启动进行中发消息：不得 throw，也不得丢——先落 pending WAL
	await am.prompt(session.id, "交接窗口消息", { model: MODEL });
	const pendings = await listAll(session.id);
	expect(pendings).toHaveLength(1);
	expect(pendings[0].text).toBe("交接窗口消息");

	// 进程 ready（ensureStarted 完成）后自动重投；starting 复用同一次冷启动 promise
	await am.ensureStarted(project.id, "dev", session.id);
	const fake = fakes[0]!;
	await until(() => fake.prompted.includes("交接窗口消息"));
	// 投递成功（RPC resolve）后 ack → WAL 条目删除
	await until(async () => (await listAll(session.id)).length === 0);
});

test("client.steer reject → 消息保留在 pending", async () => {
	const { session, am, fake } = await setup();
	expect(fake).toBeTruthy();
	fake!.autoSettle = false;
	await am.prompt(session.id, "运行中", { model: MODEL }); // 置 busy
	fake!.nextSteerError = new Error("EPIPE: rpc 写失败");
	await am.steerMessage(session.id, "引导消息");
	// steer 的 catch 链是异步的，让出宏任务
	await new Promise((r) => setTimeout(r, 20));
	const pendings = await listAll(session.id);
	const steerEntry = pendings.find((e) => e.text === "引导消息");
	expect(steerEntry).toBeDefined(); // 消息保留，未丢失
	expect(steerEntry!.failures).toBe(1); // 失败次数 +1
});

test("abort 清空内存队列时同步清空 pending WAL（防已放弃消息重启后诈尸）", async () => {
	const { session, am, fake } = await setup();
	expect(fake).toBeTruthy();
	fake!.autoSettle = false;
	await am.prompt(session.id, "运行中", { model: MODEL }); // busy
	await am.prompt(session.id, "排队中", { model: MODEL }); // followUpList + pending WAL
	expect((await listAll(session.id)).map((e) => e.text)).toContain("排队中");
	await am.abort(session.id);
	expect(await listAll(session.id)).toHaveLength(0);
});
