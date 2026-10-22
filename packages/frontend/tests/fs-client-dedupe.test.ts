// 回归：fs 查询的「在途去重 + 短 TTL 缓存 + 批量合并」。
//
// 卡顿根因（2026-09-16 定位）：ExplorerPanel 每 5s 轮询会把「所有已展开目录」各列一遍、
// 消息里每个路径 chip 挂载即各探测一次、虚拟滚动滚回视口又重挂载重发 —— 同一时刻的大量
// 重复 list-dir / stat 请求集中返回、集中 setState，是界面卡顿的成因之一。
// 这里锁住三件事：同路径并发只发一次、TTL 内不重复请求、同 tick 的多次探测合并成一个 batch 请求。
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import {
	listDir,
	statFile,
	statFiles,
	statFilesBatched,
	_setFsTransport,
	_clearFsQueryCache,
} from "../src/fs-client";
import { makeFakeFsTransport } from "./fs-transport";

const fake = makeFakeFsTransport();
_setFsTransport(fake.transport);
afterAll(() => _setFsTransport(null));

beforeEach(() => {
	fake.calls.length = 0;
	fake.sent.length = 0;
	fake.responses.clear();
	_clearFsQueryCache();
});

const listDirCalls = () =>
	fake.calls.filter((c) => c.path === "/api/fs/list-dir");
const statBatchCalls = () =>
	fake.calls.filter((c) => c.path === "/api/fs/stat-batch");
const statCalls = () => fake.calls.filter((c) => c.path === "/api/fs/stat");

describe("listDir 去重与缓存", () => {
	test("同路径并发请求只发一次（在途复用）", async () => {
		const entries = [{ name: "a", isDir: false }];
		fake.setResponse("fs:listDir", { entries });
		const [r1, r2, r3] = await Promise.all([
			listDir("/tmp/dir"),
			listDir("/tmp/dir"),
			listDir("/tmp/dir"),
		]);
		expect(listDirCalls().length).toBe(1);
		expect(r1).toEqual(entries);
		expect(r2).toEqual(entries);
		expect(r3).toEqual(entries);
	});

	test("顺序调用不缓存（目录内容随时会变，只合并并发的重复请求）", async () => {
		fake.setResponse("fs:listDir", { entries: [] });
		await listDir("/tmp/dir");
		await listDir("/tmp/dir");
		expect(listDirCalls().length).toBe(2);
	});

	test("showHidden 不同视为不同请求", async () => {
		fake.setResponse("fs:listDir", { entries: [] });
		await listDir("/tmp/dir", false);
		await listDir("/tmp/dir", true);
		expect(listDirCalls().length).toBe(2);
	});

	test("请求失败不写入缓存（下次会真正重试）", async () => {
		const bad = makeFakeFsTransport(() => {
			throw new Error("boom");
		});
		_setFsTransport(bad.transport);
		await expect(listDir("/tmp/dir")).rejects.toThrow("boom");
		await expect(listDir("/tmp/dir")).rejects.toThrow("boom");
		expect(bad.calls.filter((c) => c.path === "/api/fs/list-dir").length).toBe(2);
		_setFsTransport(fake.transport);
	});
});

describe("stat 批量探测", () => {
	test("同一 tick 内的多次探测合并成一个 stat-batch 请求", async () => {
		fake.setResponse("fs:statBatch", {
			results: [
				{ path: "/tmp/a.txt", exists: true },
				{ path: "/tmp/b.txt", exists: false },
			],
		});
		const [a, b, aAgain] = await Promise.all([
			statFilesBatched(["/tmp/a.txt"]),
			statFilesBatched(["/tmp/b.txt"]),
			statFilesBatched(["/tmp/a.txt"]),
		]);
		expect(statBatchCalls().length).toBe(1);
		expect(a.get("/tmp/a.txt")).toBe(true);
		expect(b.get("/tmp/b.txt")).toBe(false);
		expect(aAgain.get("/tmp/a.txt")).toBe(true);
		// 合并后的请求体去重
		const body = statBatchCalls()[0].body as { paths: string[] };
		expect(body.paths.sort()).toEqual(["/tmp/a.txt", "/tmp/b.txt"]);
		// 不再走单路径接口
		expect(statCalls().length).toBe(0);
	});

	test("statFile 命中缓存后不再发请求", async () => {
		fake.setResponse("fs:statBatch", {
			results: [{ path: "/tmp/a.txt", exists: true }],
		});
		expect(await statFile("/tmp/a.txt")).toBe(true);
		expect(await statFile("/tmp/a.txt")).toBe(true);
		expect(statBatchCalls().length).toBe(1);
	});

	test("statFiles 一次请求覆盖多路径，未返回项按不存在处理", async () => {
		fake.setResponse("fs:statBatch", {
			results: [{ path: "/tmp/a.txt", exists: true }],
		});
		const m = await statFiles(["/tmp/a.txt", "/tmp/missing.txt"]);
		expect(m.get("/tmp/a.txt")).toBe(true);
		expect(m.get("/tmp/missing.txt")).toBe(false);
		expect(statBatchCalls().length).toBe(1);
	});
});
