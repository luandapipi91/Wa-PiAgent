// 任务 3：pi-mcp-adapter 旧配置 → 内置 schema / <cwd>/.pi/mcp.json 的一次性迁移。
// 三类断言：
//   1. 规格 §4.2 映射表逐行（adapter 字段 → 内置 exposure / toolExposure / timeout）
//   2. 规格 §8 硬约束：旧文件保留（adapter 仍读它）+ 备份 + 迁移失败绝不半写
//   3. 幂等：连续两次调用新文件内容不变；无旧文件时不动盘
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateProjectMcpFile, migrateServerEntry } from "../mcp-migrate.ts";

let dir = "";

afterEach(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
	dir = "";
});

/** 造一个含旧 <cwd>/.mcp.json 的项目目录 */
async function setupProject(legacy: unknown, raw = false): Promise<string> {
	dir = await mkdtemp(join(tmpdir(), "mcpmigrate-"));
	await writeFile(
		join(dir, ".mcp.json"),
		raw ? String(legacy) : JSON.stringify(legacy, null, 2),
	);
	return dir;
}

describe("adapter → 内置 schema 映射（规格 §4.2）", () => {
	test("请求超时毫秒转秒并向上取整", () => {
		expect(migrateServerEntry({ command: "x", requestTimeoutMs: 1500 }).timeout).toBe(2);
	});

	test("directTools=true 映射为 direct", () => {
		expect(migrateServerEntry({ command: "x", directTools: true }).exposure).toBe("direct");
	});

	test("directTools=false 映射为 codemode", () => {
		expect(migrateServerEntry({ command: "x", directTools: false }).exposure).toBe("codemode");
	});

	test("directTools 名单映射为 codemode + 逐工具 direct", () => {
		const out = migrateServerEntry({ command: "x", directTools: ["a", "b"] });
		expect(out.exposure).toBe("codemode");
		expect(out.toolExposure).toEqual({ a: "direct", b: "direct" });
	});

	test("excludeTools 映射为 hidden", () => {
		expect(migrateServerEntry({ command: "x", excludeTools: ["c"] }).toolExposure).toEqual({ c: "hidden" });
	});

	test("adapter 独有字段被丢弃", () => {
		const out = migrateServerEntry({ command: "x", lifecycle: 1, idleTimeout: 2, debug: true, exposeResources: true });
		expect(out).not.toHaveProperty("lifecycle");
		expect(out).not.toHaveProperty("idleTimeout");
		expect(out).not.toHaveProperty("debug");
		expect(out).not.toHaveProperty("exposeResources");
	});

	test("无 directTools 时默认写 direct（规格 §4.2 产品决策）", () => {
		expect(migrateServerEntry({ command: "x" }).exposure).toBe("direct");
	});

	test("已有 exposure 的条目不被默认值覆盖，其余字段原样保留", () => {
		const out = migrateServerEntry({
			command: "x",
			args: ["--flag"],
			enabled: false,
			exposure: "deferred",
			toolExposure: { t: "hidden" },
			unknownExtra: 1,
		});
		expect(out.exposure).toBe("deferred");
		expect(out.toolExposure).toEqual({ t: "hidden" });
		expect(out.args).toEqual(["--flag"]);
		expect(out.enabled).toBe(false);
		expect(out.unknownExtra).toBe(1);
	});
});

describe("项目级文件迁移（规格 §8）", () => {
	test("迁移：<cwd>/.mcp.json 落到 <cwd>/.pi/mcp.json，旧文件原样保留且另有备份", async () => {
		const cwd = await setupProject({
			mcpServers: {
				a: { command: "x", requestTimeoutMs: 2500, directTools: ["t1"], lifecycle: "lazy" },
			},
		});
		const res = await migrateProjectMcpFile(cwd);

		expect(res.migrated).toBe(1);
		expect(res.backup).toBeDefined();
		const written = JSON.parse(
			await readFile(join(cwd, ".pi", "mcp.json"), "utf8"),
		);
		expect(Object.keys(written.mcpServers)).toEqual(["a"]);
		expect(written.mcpServers.a.timeout).toBe(3);
		expect(written.mcpServers.a.exposure).toBe("codemode");
		expect(written.mcpServers.a.toolExposure).toEqual({ t1: "direct" });
		expect(written.mcpServers.a).not.toHaveProperty("lifecycle");

		// adapter 仍在读旧文件：内容一字不动
		const legacyRaw = await readFile(join(cwd, ".mcp.json"), "utf8");
		expect(JSON.parse(legacyRaw).mcpServers.a.directTools).toEqual(["t1"]);
		// 备份存在且与旧文件同内容
		const files = await readdir(cwd);
		const backups = files.filter((f) => f.startsWith(".mcp.json.bak-"));
		expect(backups).toHaveLength(1);
		expect(await readFile(join(cwd, backups[0]!), "utf8")).toBe(legacyRaw);
	});

	test("迁移幂等：连续两次调用，第二次新文件内容不变", async () => {
		const cwd = await setupProject({
			mcpServers: {
				a: { command: "x", directTools: true },
				b: { url: "https://x/mcp", excludeTools: ["t"] },
			},
		});
		const target = join(cwd, ".pi", "mcp.json");
		const first = await migrateProjectMcpFile(cwd);
		const afterFirst = await readFile(target, "utf8");

		const second = await migrateProjectMcpFile(cwd);
		expect(second.migrated).toBe(first.migrated);
		expect(await readFile(target, "utf8")).toBe(afterFirst);
	});

	test("迁移合并进已有 .pi/mcp.json：其他服务器与顶层字段不动，同名条目按旧配置覆盖", async () => {
		const cwd = await setupProject({ mcpServers: { a: { command: "legacy" } } });
		await mkdir(join(cwd, ".pi"), { recursive: true });
		await writeFile(
			join(cwd, ".pi", "mcp.json"),
			JSON.stringify(
				{
					mcpServers: { a: { command: "old" }, keep: { command: "k" } },
					autoEnableCodemode: false,
				},
				null,
				2,
			),
		);
		await migrateProjectMcpFile(cwd);
		const written = JSON.parse(
			await readFile(join(cwd, ".pi", "mcp.json"), "utf8"),
		);
		expect(written.mcpServers.keep).toEqual({ command: "k" });
		expect(written.mcpServers.a.command).toBe("legacy");
		expect(written.autoEnableCodemode).toBe(false);
	});

	test("迁移：文件级 settings.directTools 作为缺省值，条目自身配置优先", async () => {
		const cwd = await setupProject({
			settings: { directTools: false },
			mcpServers: {
				inherit: { command: "x" },
				own: { command: "y", directTools: true },
			},
		});
		await migrateProjectMcpFile(cwd);
		const written = JSON.parse(
			await readFile(join(cwd, ".pi", "mcp.json"), "utf8"),
		);
		expect(written.mcpServers.inherit.exposure).toBe("codemode");
		expect(written.mcpServers.own.exposure).toBe("direct");
	});

	test("迁移：无 <cwd>/.mcp.json 时不动盘（连 .pi 目录都不创建）", async () => {
		dir = await mkdtemp(join(tmpdir(), "mcpmigrate-"));
		const res = await migrateProjectMcpFile(dir);
		expect(res.migrated).toBe(0);
		expect(res.backup).toBeUndefined();
		expect(existsSync(join(dir, ".pi"))).toBe(false);
		expect(await readdir(dir)).toEqual([]);
	});

	test("迁移：旧文件损坏时不半写（不创建新文件、不写任何东西）", async () => {
		const cwd = await setupProject("{ 这不是 JSON", true);
		const res = await migrateProjectMcpFile(cwd);
		expect(res.migrated).toBe(0);
		expect(existsSync(join(cwd, ".pi"))).toBe(false);
		expect(await readdir(cwd)).toEqual([".mcp.json"]);
	});

	test("迁移：目标 .pi/mcp.json 损坏时整体放弃，不覆盖用户既有数据", async () => {
		const cwd = await setupProject({ mcpServers: { a: { command: "x" } } });
		await mkdir(join(cwd, ".pi"), { recursive: true });
		await writeFile(join(cwd, ".pi", "mcp.json"), "{ 坏掉的目标文件");
		const res = await migrateProjectMcpFile(cwd).catch(() => ({ migrated: 0 }));
		expect(res.migrated).toBe(0);
		expect(await readFile(join(cwd, ".pi", "mcp.json"), "utf8")).toBe("{ 坏掉的目标文件");
	});

	test("迁移：旧文件无 mcpServers 时返回 0 且不创建新文件", async () => {
		const cwd = await setupProject({ settings: { directTools: true } });
		const res = await migrateProjectMcpFile(cwd);
		expect(res.migrated).toBe(0);
		expect(existsSync(join(cwd, ".pi"))).toBe(false);
	});
});
