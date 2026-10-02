// packages/kernel/tests/subagent-instance-store.test.ts
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertAgentId,
	jsonlPath,
	metaPath,
	newAgentId,
	readMeta,
	subagentDir,
	writeMeta,
	type SubagentMeta,
} from "../src/subagent-instance-store";

let dir: string;
/**
 * 模块加载期快照：全局 preload（packages/kernel/tests/setup.ts）已把 WA_PI_DIR 指到隔离临时目录，
 * 测试结束必须**恢复原值**而不是 delete —— delete 会清掉 preload 的隔离，让后续测试读到正式 ~/.pi/agent
 * （仓库既有惯例：另外 4 个碰 WA_PI_DIR 的测试都是快照→恢复）。
 */
const ORIGINAL_WA_PI_DIR = process.env.WA_PI_DIR;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "sa-store-"));
	process.env.WA_PI_DIR = dir;
});
afterEach(async () => {
	if (ORIGINAL_WA_PI_DIR === undefined) delete process.env.WA_PI_DIR;
	else process.env.WA_PI_DIR = ORIGINAL_WA_PI_DIR;
	await rm(dir, { recursive: true, force: true });
});

const SID = "s-5112adb4-2c89-4833-a071-128e8061e65d";

describe("newAgentId", () => {
	test("形如 a + 8 位小写 hex，且两次不重样", () => {
		const a = newAgentId();
		const b = newAgentId();
		expect(a).toMatch(/^a[0-9a-f]{8}$/);
		expect(b).toMatch(/^a[0-9a-f]{8}$/);
		expect(a).not.toBe(b);
	});
});

describe("assertAgentId", () => {
	test("合法 id 通过", () => {
		expect(() => assertAgentId("a3f8c1d0a")).not.toThrow();
	});
	test.each([
		["路径穿越", "../../etc/passwd"],
		["大写 hex", "A3F8C1D0A"],
		["长度不足", "a3f8c1d"],
		["缺前缀", "3f8c1d0a"],
		["含斜杠", "a3f8c1d0a/../x"],
	])("拒绝 %s", (_label, bad) => {
		expect(() => assertAgentId(bad)).toThrow();
	});
});

describe("路径计算", () => {
	test("jsonl 与 meta 落在 subagents/<sessionId>/ 下", () => {
		const p = jsonlPath(SID, "a3f8c1d0a");
		expect(p).toBe(join(dir, "subagents", SID, "a3f8c1d0a.jsonl"));
		expect(metaPath(SID, "a3f8c1d0a")).toBe(join(dir, "subagents", SID, "a3f8c1d0a.meta.json"));
		expect(subagentDir(SID)).toBe(join(dir, "subagents", SID));
	});
	test("拒绝非法 sessionId（防路径穿越）", () => {
		expect(() => jsonlPath("../../evil", "a3f8c1d0a")).toThrow();
	});
});

describe("meta 读写", () => {
	const meta: SubagentMeta = {
		agentId: "a3f8c1d0a",
		parentSessionId: SID,
		toolCallId: "call_00_abc",
		taskIndex: null,
		subagentType: "Explore",
		requestedAgent: "Explore",
		task: "调查 X",
		status: "running",
		createdAt: 1_790_000_000_000,
		updatedAt: 1_790_000_000_000,
		resumeCount: 0,
	};
	test("写入后可原样读回；不存在的 meta 返回 null", async () => {
		expect(await readMeta(SID, "a3f8c1d0a")).toBeNull();
		await writeMeta(meta);
		expect(await readMeta(SID, "a3f8c1d0a")).toEqual(meta);
	});
	test("原子写：目录不存在时自动创建，且不残留临时文件", async () => {
		await writeMeta(meta);
		const raw = await readFile(metaPath(SID, "a3f8c1d0a"), "utf8");
		expect(JSON.parse(raw).agentId).toBe("a3f8c1d0a");
		expect(raw).not.toContain(".tmp");
	});
	test("meta 损坏时读回 null 而不是抛错", async () => {
		await writeMeta(meta);
		await Bun.write(metaPath(SID, "a3f8c1d0a"), "{ 坏 JSON");
		expect(await readMeta(SID, "a3f8c1d0a")).toBeNull();
	});
});
