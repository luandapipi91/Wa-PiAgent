// queue-immediate.test.ts — 「立即」语义：中断当前轮执行该条，其余排队消息保留继续按序发。
//
// 用户报告的路线断裂（2026-11-18）：
//   运行中「立即」按钮被隐藏 → 提示「停止当前后可点击立即」；但「停止」= 中断 + 丢弃
//   全部排队（内存双队列 + pending WAL 全清）。停完队列空了，「立即」按钮连同要立即
//   执行的那条一起消失——UI 上写着的那条操作路径实际走不通。
//
// 定稿语义（用户 2026-11-18 拍板）：
//   ① 「立即」只中断当前轮，其它排队消息保留；该条先跑，跑完其余继续按序发出。
//      「丢弃全部排队」是「清空」按钮的职责，两个按钮不重叠。
//   ② 「停止」只中断当前轮，队列保留但暂停（不自动续跑）——否则「停止」会立刻被
//      下一条排队消息顶起来，「停下来」这件事做不到。用户后续任一操作（立即/引导/
//      再发消息）即恢复续跑，「清空」是唯一会丢队列的入口。
//   ③ 「清空」丢队列：内存双队列 + pending WAL 一并清。
//
// 详见 AgentManager.abort / steerImmediate / clearQueue。
import { test, expect, afterEach } from "bun:test";
import { AgentManager } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import {
	FakeSessionClient,
	fakeClientFactory,
} from "./fixtures/fake-session-client";
import { askRegistry } from "../src/ask-registry";
import { listAll, pendingFile } from "../src/pending-messages";
import { rmSync } from "node:fs";
import type { RpcClient, RpcClientOpts } from "../src/rpc-client";

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

interface CapturedEvent {
	sessionId: string;
	e: any;
}

async function setup(events: CapturedEvent[] = []) {
	const tmpFile = `/tmp/wa-pi-qi-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
	tmpFiles.push(tmpFile);
	const projectStore = new ProjectStore(tmpFile);
	const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
	const session = await projectStore.createSession({
		projectId: project.id,
		primaryAgent: "dev",
		title: "测试",
	});
	const fakes: FakeSessionClient[] = [];
	const am = new AgentManager({
		projectStore,
		configStore: null,
		onEvent: (sessionId, _pid, _name, e) => events.push({ sessionId, e }),
		createClientFn: fakeClientFactory(fakes),
	});
	managers.push(am);
	tmpFiles.push(pendingFile(session.id));
	await am.ensureStarted(project.id, "dev", session.id);
	return { project, session, am, fake: fakes[0] };
}

// ---- ② 停止：只中断当前轮，队列保留但暂停 ----

test("停止只中断当前轮：排队消息保留在队列里，不会被丢弃", async () => {
	const { session, am, fake } = await setup();
	fake.autoSettle = false;

	await am.prompt(session.id, "进行中", { model: MODEL }); // busy
	await am.prompt(session.id, "排队A", { model: MODEL }); // → followUpList
	await am.prompt(session.id, "排队B", { model: MODEL }); // → followUpList

	await am.abort(session.id);

	expect(fake.aborts).toBe(1);
	const handle = (am as any).sessions.get(session.id);
	expect(handle.followUpList.map((e: any) => e.text)).toEqual([
		"排队A",
		"排队B",
	]);
});

test("停止后不自动续跑排队消息（停下来就是停下来），也不丢 pending WAL", async () => {
	const { session, am, fake } = await setup();
	fake.autoSettle = false;

	await am.prompt(session.id, "进行中", { model: MODEL });
	await am.prompt(session.id, "排队A", { model: MODEL });
	expect((await listAll(session.id)).map((e) => e.text)).toContain("排队A");

	await am.abort(session.id);

	// 被中止轮的 settled 到达：队列暂停，不自动发
	fake.prompted = [];
	fake.emit({ type: "agent_settled" });
	await new Promise((r) => setTimeout(r, 50));
	expect(fake.prompted).toEqual([]);

	// 队列与 WAL 都还在（重启后仍可重投）
	const handle = (am as any).sessions.get(session.id);
	expect(handle.followUpList.map((e: any) => e.text)).toEqual(["排队A"]);
	expect((await listAll(session.id)).map((e) => e.text)).toContain("排队A");
});

test("停止后用户对队列的操作恢复续跑：立即发出该条，跑完其余继续", async () => {
	const { session, am, fake } = await setup();
	fake.autoSettle = false;

	await am.prompt(session.id, "进行中", { model: MODEL });
	await am.prompt(session.id, "排队A", { model: MODEL });
	await am.prompt(session.id, "排队B", { model: MODEL });

	await am.abort(session.id);
	fake.emit({ type: "agent_settled" });

	// 用户在暂停的队列上点「立即」（第一条）：立刻发出去
	fake.prompted = [];
	await am.steerImmediate(session.id, "排队A");
	await until(() => fake.prompted.length === 1);
	expect(fake.prompted).toEqual(["排队A"]);

	// 这轮跑完，剩下的一条继续按序发出
	fake.emit({ type: "agent_settled" });
	await until(() => fake.prompted.length === 2);
	expect(fake.prompted).toEqual(["排队A", "排队B"]);
});

test("清空是唯一丢队列的入口：clearQueue 清空双队列与 pending WAL", async () => {
	const { session, am, fake } = await setup();
	fake.autoSettle = false;

	await am.prompt(session.id, "进行中", { model: MODEL });
	await am.prompt(session.id, "排队中", { model: MODEL });
	await am.abort(session.id);

	await am.clearQueue(session.id);

	const handle = (am as any).sessions.get(session.id);
	expect(handle.followUpList).toEqual([]);
	expect(handle.steerList).toEqual([]);
	// 清空是明确的「我不要这些消息了」：WAL 同步清掉，防重启后诈尸重投
	expect(await listAll(session.id)).toHaveLength(0);
});

// ---- ① 立即：中断当前轮 + 立刻执行该条，其余保留 ----

test("立即：中断当前轮并立刻发送该条，其余排队消息保留", async () => {
	const { session, am, fake } = await setup();
	fake.autoSettle = false;

	await am.prompt(session.id, "进行中", { model: MODEL }); // busy
	await am.prompt(session.id, "排队A", { model: MODEL });
	await am.prompt(session.id, "排队B", { model: MODEL });

	fake.prompted = [];
	await am.steerImmediate(session.id, "排队B");

	// 当前轮被中断 + 该条立刻发出
	expect(fake.aborts).toBe(1);
	expect(fake.prompted).toEqual(["排队B"]);

	// 其它排队消息保留，且顺序不变
	const handle = (am as any).sessions.get(session.id);
	expect(handle.followUpList.map((e: any) => e.text)).toEqual(["排队A"]);
	// 被立即执行的那条不再是排队项
	expect((await listAll(session.id)).map((e) => e.text)).not.toContain("排队B");
});

test("立即：随后这轮跑完，保留的排队消息继续按序发出", async () => {
	const { session, am, fake } = await setup();
	fake.autoSettle = false;

	await am.prompt(session.id, "进行中", { model: MODEL });
	await am.prompt(session.id, "排队A", { model: MODEL });
	await am.prompt(session.id, "排队B", { model: MODEL });

	fake.prompted = [];
	await am.steerImmediate(session.id, "排队B");
	await until(() => fake.prompted.length === 1);

	// 立即那条这轮结束后 → 排队A 继续发
	fake.emit({ type: "agent_settled" });
	await until(() => fake.prompted.length === 2);
	expect(fake.prompted).toEqual(["排队B", "排队A"]);
});

test("立即：被中止轮自己的 settled 不得抢先把其它排队消息发出去", async () => {
	// 真实管道时序：pi 被 abort 时先广播该轮 agent_settled、再回 abort 响应。
	// 若这声 settled 触发 drain，别的排队消息会抢在「立即」那条之前发出。
	const { session, am, fake } = await setup();
	fake.autoSettle = false;

	await am.prompt(session.id, "进行中", { model: MODEL });
	await am.prompt(session.id, "排队A", { model: MODEL });
	await am.prompt(session.id, "排队B", { model: MODEL });

	fake.prompted = [];
	// 模拟：abort RPC 挂起期间 pi 先广播被中止轮的 settled
	let releaseAbort!: () => void;
	fake.abortGate = new Promise<void>((r) => (releaseAbort = r));
	const immediate = am.steerImmediate(session.id, "排队B");
	await until(() => fake.aborts > 0);
	fake.emit({ type: "agent_settled" });
	releaseAbort!();
	await immediate;

	// 该 settled 不得把 排队A 顶出去：此刻只应有「立即」那条
	expect(fake.prompted).toEqual(["排队B"]);
	const handle = (am as any).sessions.get(session.id);
	expect(handle.followUpList.map((e: any) => e.text)).toEqual(["排队A"]);
});

test("立即：带附件的排队消息保留图片一起投递", async () => {
	const { session, am, fake } = await setup();
	fake.autoSettle = false;
	const images = [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }];

	await am.prompt(session.id, "进行中", { model: MODEL });
	await am.prompt(session.id, "带图排队", { model: MODEL, attachments: [] });
	// 直接往队列塞图（模拟图片排队后的立即提升：附件无法从 UI 重传，必须继承队列条目）
	const handle = (am as any).sessions.get(session.id);
	handle.followUpList[0].images = images as any;

	fake.prompted = [];
	fake.promptImages = [];
	await am.steerImmediate(session.id, "带图排队");

	expect(fake.prompted).toEqual(["带图排队"]);
	expect(fake.promptImages[0]).toEqual(images);
	expect(handle.followUpList).toEqual([]);
});

test("立即：空闲时（无在跑轮次）等价于直接发送该条", async () => {
	const { session, am, fake } = await setup();
	fake.autoSettle = true;

	await am.prompt(session.id, "已结束", { model: MODEL }); // 自动 settle → idle
	const handle = (am as any).sessions.get(session.id);
	handle.followUpList = [{ text: "排队A", images: [] }];

	fake.prompted = [];
	await am.steerImmediate(session.id, "排队A");

	expect(fake.prompted).toEqual(["排队A"]);
	expect(handle.followUpList).toEqual([]);
});
