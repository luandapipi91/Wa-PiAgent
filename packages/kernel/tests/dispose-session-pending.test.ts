// dispose-session-pending.test.ts — disposeSession 的 pending WAL 语义
//
// 背景（2026-11-18「立即」语义修正的连带影响）：停止/立即不再丢队列，排队消息会
// 长期留在内存队列与 pending WAL 里。disposeSession 被两条路径共用：
//   ① session:delete（删除会话）：排队消息再无归属 → WAL 必须清掉，否则重启后
//      会给一个已删除的会话重投消息，孤儿 WAL 也会阻止空闲回收（reap 见 WAL 非空就跳过）
//   ② 空闲回收 / 进程退出：排队消息属于用户 → WAL 必须保留，下次冷启动重投
// 本文件锁定这两条语义不被混用。
import { test, expect, afterEach } from "bun:test";
import { AgentManager } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import {
	FakeSessionClient,
	fakeClientFactory,
} from "./fixtures/fake-session-client";
import { enqueue, listAll, pendingFile } from "../src/pending-messages";
import { rmSync } from "node:fs";
import type { RpcClient, RpcClientOpts } from "../src/rpc-client";

const managers: AgentManager[] = [];
const tmpFiles: string[] = [];

afterEach(async () => {
	for (const am of managers.splice(0)) await am.disposeAll().catch(() => {});
	for (const f of tmpFiles.splice(0)) {
		try {
			rmSync(f, { force: true });
		} catch {
			// 尽力清理
		}
	}
});

async function setup() {
	const tmpFile = `/tmp/wa-pi-dsp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
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
		onEvent: () => {},
		createClientFn: fakeClientFactory(fakes),
	});
	managers.push(am);
	tmpFiles.push(pendingFile(session.id));
	await am.ensureStarted(project.id, "dev", session.id);
	return { project, session, am, fake: fakes[0] };
}

test("删除会话（dropPending）→ pending WAL 一并清掉", async () => {
	const { session, am } = await setup();
	await enqueue(session.id, { text: "排队中", images: [] });
	expect(await listAll(session.id)).toHaveLength(1);

	await am.disposeSession(session.id, { dropPending: true });

	expect(await listAll(session.id)).toHaveLength(0);
});

test("空闲回收 / 进程退出（默认）→ pending WAL 保留，冷启动后仍能重投", async () => {
	const { session, am } = await setup();
	await enqueue(session.id, { text: "排队中", images: [] });

	await am.disposeSession(session.id);

	// 排队消息属于用户：回收进程不等于放弃消息
	expect((await listAll(session.id)).map((e) => e.text)).toEqual(["排队中"]);
});
