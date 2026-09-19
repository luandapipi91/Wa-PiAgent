import { describe, test, expect, mock, afterEach } from "bun:test";
// 注意：不能留 node:fs/promises 的引用当“真实实现”——mock.module 会原地改写
// 该命名空间，引用也随之变成 mock 自己（无限递归）。改用未被 mock 的 node:fs。
import { renameSync } from "node:fs";
import { rm } from "node:fs/promises"; // promise 版 rm；mock 只覆盖 rename，其余导出保持原版
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProjectStore as ProjectStoreType } from "../project-store";

// ---------------------------------------------------------------------------
// 场景：Windows 上 projects.json 被杀软/并发读者短暂持有时，
// save() 的 rename(MoveFileEx) 报 EPERM，错误沿发送链路冒泡成 "Send failed: EPERM"。
// 期望行为：save() 对 EPERM 做退避重试（等句柄释放），非 EPERM 立即抛。
//
// 本机（macOS/Linux）rename 是原子的、无法复现 EPERM，故用 mock.module 拦截
// node:fs/promises 的 rename 注入失败。mock 必须先于 project-store 加载生效，
// 因此这里动态 import ProjectStore。
// ---------------------------------------------------------------------------

/** 剩余 EPERM 注入次数；0 表示放行（走真实 rename） */
let epermLeft = 0;
/** 非 EPERM 的致命错误注入；非 null 时 rename 直接抛它 */
let fatalErr: Error | null = null;
let renameCalls = 0;

mock.module("node:fs/promises", () => ({
	...require("node:fs/promises"),
	rename: async (from: string, to: string) => {
		renameCalls++;
		if (fatalErr) throw fatalErr;
		if (epermLeft > 0) {
			epermLeft--;
			const e: any = new Error(
				"EPERM: operation not permitted, rename 'projects.json.xxx.tmp' -> 'projects.json'",
			);
			e.code = "EPERM";
			e.errno = -20;
			e.syscall = "rename";
			throw e;
		}
		return renameSync(from, to);
	},
}));

const { ProjectStore } = await import("../project-store");

const DIR = join(tmpdir(), `wa-pi-eperm-${process.pid}-${Date.now()}`);
const FILE = join(DIR, "projects.json");

describe("ProjectStore.save() EPERM 退避重试（Windows 锁定场景）", () => {
	afterEach(async () => {
		epermLeft = 0;
		fatalErr = null;
		renameCalls = 0;
		await rm(DIR, { recursive: true, force: true });
	});

	test("rename 连续撞 2 次 EPERM 后重试成功，写入最终落盘", async () => {
		const store = new ProjectStore(FILE);
		epermLeft = 2;
		const s = await store.createSession({
			projectId: "p1",
			primaryAgent: "coder",
			title: "重试场景",
		});
		// 失败 2 次 + 成功 1 次
		expect(renameCalls).toBe(3);
		const data = await store.load();
		expect(data.sessions.find((x) => x.id === s.id)?.title).toBe("重试场景");
		// 成功后 tmp 不残留
		const { readdir } = await import("node:fs/promises");
		expect((await readdir(DIR)).some((f) => f.endsWith(".tmp"))).toBe(false);
	});

	test("非 EPERM 错误不重试，立即抛出", async () => {
		const store = new ProjectStore(FILE);
		fatalErr = Object.assign(new Error("ENOENT: no such file or directory"), {
			code: "ENOENT",
		});
		await expect(
			store.createSession({ projectId: "p1", primaryAgent: "coder", title: "x" }),
		).rejects.toThrow("ENOENT");
		expect(renameCalls).toBe(1);
	});

	test("EPERM 超过重试上限后抛出最后一次错误", async () => {
		const store = new ProjectStore(FILE);
		epermLeft = 99; // 永远 EPERM
		await expect(
			store.createSession({ projectId: "p1", primaryAgent: "coder", title: "x" }),
		).rejects.toThrow("EPERM");
		// 1 次首发 + 4 次重试
		expect(renameCalls).toBe(5);
	});
});

// ---------------------------------------------------------------------------
// 写方法串行化：所有「读-改-写」写方法必须互斥（save 永不交叠），
// 否则并发写既会 lost update（旧快照覆盖），Windows 上还会撞 rename EPERM。
// 与 EPERM mock 同文件：mock.module 是进程级全局的，两个文件并行跑会互相污染。
// ---------------------------------------------------------------------------

/** 给 store 的 save 挂探针：记录最大并发度，并放大窗口让交叠确定性暴露 */
function instrument(store: ProjectStoreType) {
	const state = { inFlight: 0, maxConcurrent: 0 };
	const proto = Object.getPrototypeOf(store) as any;
	const origSave = proto.save.bind(store);
	(store as any).save = async (data: any) => {
		state.inFlight++;
		state.maxConcurrent = Math.max(state.maxConcurrent, state.inFlight);
		// 窗口放大：未串行化时 10ms 足以让两次 save 必然交叠
		await new Promise((r) => setTimeout(r, 10));
		await origSave(data);
		state.inFlight--;
	};
	return state;
}

describe("ProjectStore 写方法串行化", () => {
	afterEach(async () => {
		await rm(DIR, { recursive: true, force: true });
	});

	test("fillSessionTitleIfEmpty 与 touchSession 并发：save 不交叠且两个修改都保留", async () => {
		const store = new ProjectStore(FILE);
		const s = await store.createSession({
			projectId: "p1",
			primaryAgent: "coder",
			title: "",
		});
		const state = instrument(store);

		const [filled] = await Promise.all([
			store.fillSessionTitleIfEmpty(s.id, "首条消息命名"),
			store.touchSession(s.id),
		]);

		// 串行化契约：save 一次只有一个在飞
		expect(state.maxConcurrent).toBe(1);
		// 无 lost update：命名成功，且记录仍在（touch 的旧快照没有覆盖掉命名）
		expect(filled).toBe(true);
		const data = await store.load();
		const row = data.sessions.find((x) => x.id === s.id)!;
		expect(row.title).toBe("首条消息命名");
		expect(row.placeholder).toBeUndefined();
	});

	test("createSession 与 touchSession 并发：新会话记录与已有会话都不丢", async () => {
		const store = new ProjectStore(FILE);
		const first = await store.createSession({
			projectId: "p1",
			primaryAgent: "coder",
			title: "first",
		});
		await store.touchSession(first.id);
		const state = instrument(store);

		await Promise.all([
			store.createSession({
				projectId: "p1",
				primaryAgent: "coder",
				title: "second",
			}),
			store.touchSession(first.id),
		]);

		expect(state.maxConcurrent).toBe(1);
		const data = await store.load();
		expect(data.sessions.find((x) => x.title === "second")).toBeDefined();
		expect(data.sessions.find((x) => x.id === first.id)).toBeDefined();
	});
});
