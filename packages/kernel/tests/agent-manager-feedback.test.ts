// agent-manager-feedback.test.ts — 投递失败回执（任务 2：消灭静默缺口）
//
// 任何一条用户消息的结局必须三选一：已投递 / 已排队（可见）/ 失败（UI 可见）。
// 任务 1（pending WAL）已让消息不丢；本文件锁定「回执」：
// 1. steer RPC reject → 广播会话级错误事件（此前 agent-manager 静默 catch，用户零感知）；
// 2. handle 未就绪 prompt 入 pending → 广播排队回执事件 pending_update
//    （此前完全无事件，前端无从得知消息已排队）；
// 3. steer 时 handle 不存在入 pending → 同样广播排队回执。
//
// 错误广播沿用 kernel 现有 extension_error 通道（_onProcessExit 崩溃广播同款：
// 经 onEvent → index.ts 包 sdk:event 信封 → 前端 toast + 诊断列表），不新造机制。
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
import type { RpcClient } from "../src/rpc-client";
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

type CapturedEvent = { sessionId: string; projectId: string; agentName: string; e: any };

interface SetupOpts {
	/** client.start 延迟毫秒数：设置时不 await ensureStarted（handle 未就绪） */
	startDelayMs?: number;
}

async function setup(
	opts: SetupOpts & { events?: CapturedEvent[] } = {},
) {
	const tmpFile = `/tmp/wa-pi-am-fb-${Date.now()}-${Math.random()
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
		onEvent: (sid, pid, name, e) =>
			opts.events?.push({ sessionId: sid, projectId: pid, agentName: name, e }),
		createClientFn: opts.startDelayMs
			? (o) => {
					const fake = new FakeSessionClient(o);
					fake.start = async () => {
						await new Promise((r) => setTimeout(r, opts.startDelayMs));
					};
					fakes.push(fake);
					return fake as unknown as RpcClient;
				}
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

test("steer RPC reject → 广播会话级错误事件（extension_error 通道）", async () => {
	const events: CapturedEvent[] = [];
	const { session, am, fake } = await setup({ events });
	expect(fake).toBeTruthy();
	fake!.autoSettle = false;
	await am.prompt(session.id, "运行中", { model: MODEL }); // 置 busy
	const before = events.length;
	fake!.nextSteerError = new Error("EPIPE: broken pipe");
	await am.steerMessage(session.id, "引导消息");
	// catch 回调是异步链路，让出宏任务
	await new Promise((r) => setTimeout(r, 20));

	const errEvents = events
		.slice(before)
		.filter((x) => x.e.type === "extension_error");
	expect(errEvents.length).toBeGreaterThanOrEqual(1); // 此前：0，静默吞掉
	expect(errEvents[0].sessionId).toBe(session.id); // 会话级
	expect(JSON.stringify(errEvents[0].e)).toContain("EPIPE"); // 携带原始错误
});

test("handle 未就绪时 prompt 入 pending → 广播排队回执（pending_update）", async () => {
	const events: CapturedEvent[] = [];
	const { session, am } = await setup({ events, startDelayMs: 80 });
	// 冷启动进行中发消息：落 pending WAL 的同时必须有回执事件
	await am.prompt(session.id, "交接窗口消息", { model: MODEL });
	const receipt = events.find((x) => x.e.type === "pending_update");
	expect(receipt).toBeDefined(); // 此前：无任何事件，消息排队用户不可知
	expect(receipt!.sessionId).toBe(session.id);
	expect(receipt!.e.count).toBeGreaterThanOrEqual(1);
	// 任务 5：事件必须携带待投递文本，前端队列面板才能渲染「待投递」条目
	expect(receipt!.e.texts).toContain("交接窗口消息");
	expect((await listAll(session.id)).length).toBe(1); // 消息确实在 WAL
});

test("steer 时 handle 不存在入 pending → 同样广播排队回执（pending_update）", async () => {
	const events: CapturedEvent[] = [];
	const { session, am } = await setup({ events, startDelayMs: 80 });
	await am.steerMessage(session.id, "引导消息");
	const receipt = events.find((x) => x.e.type === "pending_update");
	expect(receipt).toBeDefined();
	expect(receipt!.sessionId).toBe(session.id);
	// 任务 5：同上，携带待投递文本
	expect(receipt!.e.texts).toContain("引导消息");
	expect((await listAll(session.id)).map((e) => e.text)).toContain("引导消息");
});
