// packages/kernel/tests/subagent-cleanup.test.ts
// 保留策略（规格 §10）：父会话被**永久删除**时级联清理 <WA_PI_DIR>/subagents/<parentSessionId>/。
// 覆盖三件事：① 清理函数自身语义（不存在静默 / 非法 id 拒绝且不误删）② 三个永久删除入口都级联
// ③ 软删除（回收站，可恢复）绝不清理。
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, stat, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cleanupSubagentDir,
	cleanupSubagentDirs,
} from "../src/subagent-instance-store";
import { createCascadingProjectStore } from "../src/subagent-cascade-store";
import { WSServer } from "../src/ws-server";

let dir: string;
/**
 * 模块加载期快照：全局 preload（packages/kernel/tests/setup.ts）已把 WA_PI_DIR 指到隔离临时目录，
 * 测试结束必须**恢复原值**而不是 delete —— delete 会清掉 preload 的隔离，让后续测试读到正式 ~/.pi/agent
 * （仓库既有惯例：另外 4 个碰 WA_PI_DIR 的测试都是快照→恢复）。
 */
const ORIGINAL_WA_PI_DIR = process.env.WA_PI_DIR;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "sa-clean-"));
	process.env.WA_PI_DIR = dir;
});
afterEach(async () => {
	if (ORIGINAL_WA_PI_DIR === undefined) delete process.env.WA_PI_DIR;
	else process.env.WA_PI_DIR = ORIGINAL_WA_PI_DIR;
	await rm(dir, { recursive: true, force: true });
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** 造一个父会话的子代理转录目录（含一个实例 jsonl），返回目录路径 */
async function seedSubagentDir(sessionId: string): Promise<string> {
	const p = join(dir, "subagents", sessionId);
	await mkdir(p, { recursive: true });
	await writeFile(join(p, "a3f8c1d0a.jsonl"), '{"type":"message"}\n', "utf8");
	return p;
}

async function exists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

/** 直接落一份 projects.json（绕过 store，避免测试依赖被测代码） */
async function seedProjects(
	file: string,
	rows: Array<Record<string, unknown>>,
): Promise<void> {
	await writeFile(
		file,
		JSON.stringify({
			projects: [{ id: "__system__", name: "默认工作区", cwd: "/tmp", createdAt: 1 }],
			sessions: rows.map((r) => ({
				projectId: "__system__",
				primaryAgent: "coder",
				title: String(r.id),
				createdAt: 1,
				lastActivity: Date.now(),
				...r,
			})),
		}),
		"utf8",
	);
}

async function readSessionIds(file: string): Promise<string[]> {
	const raw = JSON.parse(await readFile(file, "utf8")) as {
		sessions: Array<{ id: string }>;
	};
	return raw.sessions.map((s) => s.id);
}

describe("cleanupSubagentDir", () => {
	test("清理父会话的子代理目录（存在则删、不存在不报错）", async () => {
		const sdir = join(dir, "subagents", "s-3333");
		await mkdir(sdir, { recursive: true });
		await cleanupSubagentDir("s-3333");
		await expect(stat(sdir)).rejects.toThrow();
		await expect(cleanupSubagentDir("s-3333")).resolves.toBeUndefined();
	});

	test("非法 sessionId 拒绝，不误删目录外的内容", async () => {
		// 布局：<dir>/subagents/ 是根；"../evil" 解析到 <dir>/evil（若校验缺失就会被删）
		const escapee = join(dir, "evil");
		await mkdir(escapee, { recursive: true });
		await expect(cleanupSubagentDir("../evil")).rejects.toThrow();
		await expect(cleanupSubagentDir("../../evil")).rejects.toThrow();
		expect(await exists(escapee)).toBe(true);
	});
});

describe("cleanupSubagentDirs", () => {
	test("批量清理：单个 id 非法/不存在不影响其它 id，且不向调用方抛错", async () => {
		const a = await seedSubagentDir("s-aaaa");
		const b = await seedSubagentDir("s-bbbb");
		await cleanupSubagentDirs(["s-aaaa", "../evil", "s-不存在", "s-bbbb"]);
		expect(await exists(a)).toBe(false);
		expect(await exists(b)).toBe(false);
	});
});

describe("级联清理：只在父会话被永久删除时", () => {
	test("permanentlyDeleteSessions：清被删会话的目录，不碰其它会话", async () => {
		const file = join(dir, "projects.json");
		await seedProjects(file, [{ id: "s-gone" }, { id: "s-keep" }]);
		const gone = await seedSubagentDir("s-gone");
		const keep = await seedSubagentDir("s-keep");
		const store = createCascadingProjectStore(file);

		await store.permanentlyDeleteSessions(["s-gone"]);

		expect(await exists(gone)).toBe(false);
		expect(await exists(keep)).toBe(true);
		// store 既有语义不变：记录真的被移除、其它记录保留
		expect(await readSessionIds(file)).toEqual(["s-keep"]);
	});

	test("emptyTrash：清回收站会话的目录，活跃会话的目录保留", async () => {
		const file = join(dir, "projects.json");
		await seedProjects(file, [
			{ id: "s-live" },
			{ id: "s-trash1", deletedAt: Date.now() - DAY_MS },
			{ id: "s-trash2", deletedAt: Date.now() - 2 * DAY_MS },
		]);
		const live = await seedSubagentDir("s-live");
		const t1 = await seedSubagentDir("s-trash1");
		const t2 = await seedSubagentDir("s-trash2");
		const store = createCascadingProjectStore(file);

		expect(await store.emptyTrash()).toBe(2);

		expect(await exists(t1)).toBe(false);
		expect(await exists(t2)).toBe(false);
		expect(await exists(live)).toBe(true);
	});

	test("purgeOldTrashSessions：只清过期回收站会话的目录，未过期的保留", async () => {
		const file = join(dir, "projects.json");
		const cutoff = Date.now() - 7 * DAY_MS;
		await seedProjects(file, [
			{ id: "s-old", deletedAt: cutoff - DAY_MS },
			{ id: "s-recent", deletedAt: cutoff + DAY_MS },
			{ id: "s-live" },
		]);
		const old = await seedSubagentDir("s-old");
		const recent = await seedSubagentDir("s-recent");
		const live = await seedSubagentDir("s-live");
		const store = createCascadingProjectStore(file);

		expect(await store.purgeOldTrashSessions(cutoff)).toBe(1);

		expect(await exists(old)).toBe(false);
		expect(await exists(recent)).toBe(true); // 仍在回收站，可恢复
		expect(await exists(live)).toBe(true);
	});

	test("软删除（回收站）不清理子代理转录", async () => {
		const file = join(dir, "projects.json");
		await seedProjects(file, [
			{ id: "s-soft" },
			{ id: "s-stale", lastActivity: 1 },
		]);
		const soft = await seedSubagentDir("s-soft");
		const stale = await seedSubagentDir("s-stale");
		const store = createCascadingProjectStore(file);

		await store.deleteSession("s-soft"); // 用户手动删除 → 回收站
		await store.archiveStaleSessions(DAY_MS); // 自动归档 → 回收站

		expect(await exists(soft)).toBe(true);
		expect(await exists(stale)).toBe(true);
	});

	test("会话 id 非法（历史脏数据）时清理失败不阻断永久删除，也不删目录外内容", async () => {
		const file = join(dir, "projects.json");
		await seedProjects(file, [{ id: "bad..id" }, { id: "s-ok" }]);
		const outside = join(dir, "subagents-keep"); // "../subagents-keep" 的落点（目录外）
		await mkdir(outside, { recursive: true });
		const ok = await seedSubagentDir("s-ok");
		const store = createCascadingProjectStore(file);

		await expect(store.permanentlyDeleteSessions(["bad..id"])).resolves.toBeUndefined();

		expect(await exists(outside)).toBe(true);
		expect(await exists(ok)).toBe(true);
		expect(await readSessionIds(file)).toEqual(["s-ok"]);
	});

	test("删除后又出现在库里的会话（并发恢复出回收站）不被清理", async () => {
		const file = join(dir, "projects.json");
		await seedProjects(file, [{ id: "s-trash", deletedAt: Date.now() - DAY_MS }]);
		const trash = await seedSubagentDir("s-trash");
		const back = await seedSubagentDir("s-back");
		const store = createCascadingProjectStore(file);
		// 模拟并发窗口：清空回收站的同一瞬间，「s-back」被恢复/重建，仍然在库里
		const origLoad = store.load.bind(store);
		store.load = async () => {
			const data = await origLoad();
			data.sessions.push({
				id: "s-back",
				deletedAt: Date.now() - DAY_MS,
			} as any);
			return data;
		};

		await store.emptyTrash();

		expect(await exists(back)).toBe(true); // 还活着 → 目录必须保留
		expect(await exists(trash)).toBe(false); // 真被物理移除 → 目录清掉
	});

	test("真实入口：trash:delete / trash:empty 两个 WS 事件也级联清理", async () => {
		const file = join(dir, "projects.json");
		await seedProjects(file, [
			{ id: "s-del" },
			{ id: "s-trash", deletedAt: Date.now() - DAY_MS },
		]);
		const del = await seedSubagentDir("s-del");
		const trash = await seedSubagentDir("s-trash");
		const store = createCascadingProjectStore(file);
		const server = new WSServer({ projectStore: store, agentManager: {} } as any);

		const res1 = await server.callApi({
			type: "trash:delete",
			sessionIds: ["s-del"],
		} as any);
		expect(res1.status).toBe(200);
		expect(await exists(del)).toBe(false);
		expect(await exists(trash)).toBe(true); // 仍在回收站

		const res2 = await server.callApi({ type: "trash:empty" } as any);
		expect(res2.status).toBe(200);
		expect(await exists(trash)).toBe(false);
	});
});
