// ProjectStore 写路径严格读（loadStrict）单测
//
// 背景：projects.json 反复「变空」事故——load() 读失败（文件被占用的瞬间/
// 解析失败）静默回退空库，写路径拿到空快照后全量写回 = 清库。
// 修复：所有写方法改用 loadStrict()——文件存在但读失败时抛错拒绝写，
// 不产生任何写回；文件不存在（ENOENT，首次启动）仍是合法空库。
// 纯只读路径（load/loadActive/loadTrash）保持 catch-empty（展示层不炸）。

import { describe, test, expect, afterEach } from "bun:test";
import { ProjectStore } from "../project-store";
import { rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_FILE = join(tmpdir(), `test-loadstrict-${Date.now()}.json`);

function makeStore() {
	return new ProjectStore(TEST_FILE);
}

describe("ProjectStore loadStrict（读失败不反写）", () => {
	afterEach(async () => {
		await rm(TEST_FILE, { force: true });
	});

	test("文件损坏时写操作抛错，绝不把空库写回覆盖原文件", async () => {
		const s = makeStore();
		await s.createProject({ name: "A", cwd: "/tmp/a" });
		const corrupted = '{ "projects": [损坏的内容';
		await writeFile(TEST_FILE, corrupted, "utf8");
		// 写路径全部拒绝（抛错而非写空库）
		await expect(
			s.createProject({ name: "B", cwd: "/tmp/b" }),
		).rejects.toThrow();
		await expect(s.touchSession("s-x")).rejects.toThrow();
		await expect(s.emptyTrash()).rejects.toThrow();
		// 原文件原样保留（未被空库覆盖）
		expect(await readFile(TEST_FILE, "utf8")).toBe(corrupted);
	});

	test("文件不存在（首次启动）时写操作正常初始化", async () => {
		const s = makeStore();
		const p = await s.createProject({ name: "First", cwd: "/tmp/first" });
		const data = await s.load();
		expect(data.projects).toHaveLength(1);
		expect(data.projects[0].id).toBe(p.id);
	});

	test("纯只读路径对损坏文件保持 catch-empty（展示层不炸）", async () => {
		const s = makeStore();
		await writeFile(TEST_FILE, "不是 JSON", "utf8");
		const data = await s.load();
		expect(data.projects).toEqual([]);
		expect(data.sessions).toEqual([]);
	});
});
