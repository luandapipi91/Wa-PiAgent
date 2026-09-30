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
import { migrateGlobalMcpFile, migrateProjectMcpFile, migrateServerEntry } from "../mcp-migrate.ts";

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

/** 造一个含全局 <waPiDir>/mcp.json 的数据目录 */
async function setupGlobal(cfg: unknown): Promise<string> {
	dir = await mkdtemp(join(tmpdir(), "mcpmigrateglobal-"));
	await writeFile(join(dir, "mcp.json"), JSON.stringify(cfg, null, 2));
	return dir;
}

/** 读回全局文件 */
async function readGlobal(waPiDir: string): Promise<Record<string, any>> {
	return JSON.parse(await readFile(join(waPiDir, "mcp.json"), "utf8"));
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

describe("全局 mcp.json 加法迁移（共享文件：只补写、不破坏性改写）", () => {
	test("settings.directTools=true → 每个 server 补出 exposure direct，旧字段与 settings 全保留", async () => {
		const waPiDir = await setupGlobal({
			settings: { directTools: true, toolPrefix: "p" },
			mcpServers: {
				a: { command: "x", lifecycle: "lazy", requestTimeoutMs: 2500 },
				b: { url: "https://x/mcp" },
			},
			autoEnableCodemode: false,
			unknownTop: { keep: 1 },
		});
		const res = await migrateGlobalMcpFile(waPiDir);

		expect(res.migrated).toBe(2);
		expect(res.backup).toBeDefined();
		const written = await readGlobal(waPiDir);
		expect(written.mcpServers.a.exposure).toBe("direct");
		expect(written.mcpServers.b.exposure).toBe("direct");
		// 加法映射：adapter 时代的旧字段一个都不删（任务 6 前 adapter 仍读它们）
		expect(written.mcpServers.a.lifecycle).toBe("lazy");
		expect(written.mcpServers.a.requestTimeoutMs).toBe(2500);
		expect(written.mcpServers.a.timeout).toBe(3);
		// settings 段与未知顶层字段原样保留
		expect(written.settings).toEqual({ directTools: true, toolPrefix: "p" });
		expect(written.unknownTop).toEqual({ keep: 1 });
		expect(written.autoEnableCodemode).toBe(false);
	});

	test("settings.directTools 名单 → 逐 server 展开为 exposure codemode + 逐工具 direct", async () => {
		const waPiDir = await setupGlobal({
			settings: { directTools: ["a", "b"] },
			mcpServers: { s: { command: "x" } },
		});
		await migrateGlobalMcpFile(waPiDir);

		const written = await readGlobal(waPiDir);
		expect(written.mcpServers.s.exposure).toBe("codemode");
		expect(written.mcpServers.s.toolExposure).toEqual({ a: "direct", b: "direct" });
		expect(written.settings.directTools).toEqual(["a", "b"]);
	});

	test("server/tool 限定名：前缀等于当前服务器才生效（取 / 之后），前缀不符则丢弃", async () => {
		const waPiDir = await setupGlobal({
			settings: { directTools: ["s1/t1", "s2/t2", "plain"] },
			mcpServers: { s1: { command: "x" }, s2: { command: "y" } },
		});
		await migrateGlobalMcpFile(waPiDir);

		const written = await readGlobal(waPiDir);
		expect(written.mcpServers.s1.toolExposure).toEqual({ t1: "direct", plain: "direct" });
		expect(written.mcpServers.s2.toolExposure).toEqual({ t2: "direct", plain: "direct" });
		// 前缀不是本服务器的条目被丢弃（不得把 s2/t2 挂到 s1 上）
		expect(written.mcpServers.s1.toolExposure).not.toHaveProperty("t2");
		expect(written.mcpServers.s2.toolExposure).not.toHaveProperty("t1");
	});

	test("仅带 requestTimeoutMs 的全局条目：补 timeout（并按规格默认 direct），旧字段保留", async () => {
		const waPiDir = await setupGlobal({
			mcpServers: { a: { command: "x", requestTimeoutMs: 1500 } },
		});
		await migrateGlobalMcpFile(waPiDir);

		const written = await readGlobal(waPiDir);
		expect(written.mcpServers.a.timeout).toBe(2);
		expect(written.mcpServers.a.exposure).toBe("direct");
		expect(written.mcpServers.a.requestTimeoutMs).toBe(1500);
	});

	test("备份 mcp.json.bak-<ts> 内容是迁移前的原文，原文件为合法 JSON 且无残留临时文件", async () => {
		const waPiDir = await setupGlobal({
			settings: { directTools: false },
			mcpServers: { a: { command: "x", directTools: true } },
		});
		const before = await readFile(join(waPiDir, "mcp.json"), "utf8");
		await migrateGlobalMcpFile(waPiDir);

		const files = await readdir(waPiDir);
		const backups = files.filter((f) => f.startsWith("mcp.json.bak-"));
		expect(backups).toHaveLength(1);
		expect(await readFile(join(waPiDir, backups[0]!), "utf8")).toBe(before);
		expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
		await readGlobal(waPiDir); // 原文件仍是合法 JSON
		// 条目自身配置优先于 settings 缺省值
		expect((await readGlobal(waPiDir)).mcpServers.a.exposure).toBe("direct");
	});

	test("没有 settings 段也没有旧字段时不动盘：不写文件、不产生备份", async () => {
		const waPiDir = await setupGlobal({
			mcpServers: { a: { command: "x", args: ["--y"], enabled: false } },
		});
		const before = await readFile(join(waPiDir, "mcp.json"), "utf8");
		const res = await migrateGlobalMcpFile(waPiDir);

		expect(res.migrated).toBe(0);
		expect(res.backup).toBeUndefined();
		expect(await readFile(join(waPiDir, "mcp.json"), "utf8")).toBe(before);
		expect(await readdir(waPiDir)).toEqual(["mcp.json"]);
	});

	test("没有全局 mcp.json 时不创建任何文件", async () => {
		dir = await mkdtemp(join(tmpdir(), "mcpmigrateglobal-"));
		const res = await migrateGlobalMcpFile(dir);

		expect(res.migrated).toBe(0);
		expect(res.backup).toBeUndefined();
		expect(await readdir(dir)).toEqual([]);
	});

	test("全局文件损坏时绝不半写：原文件原样、无备份", async () => {
		const waPiDir = await setupGlobal({ mcpServers: { a: { command: "x", directTools: true } } });
		await writeFile(join(waPiDir, "mcp.json"), "{ 这不是 JSON");
		const res = await migrateGlobalMcpFile(waPiDir);

		expect(res.migrated).toBe(0);
		expect(await readFile(join(waPiDir, "mcp.json"), "utf8")).toBe("{ 这不是 JSON");
		expect(await readdir(waPiDir)).toEqual(["mcp.json"]);
	});

	test("全局迁移幂等：第二次调用不写盘、不再产生备份", async () => {
		const waPiDir = await setupGlobal({
			settings: { directTools: true },
			mcpServers: { a: { command: "x" } },
		});
		const first = await migrateGlobalMcpFile(waPiDir);
		const afterFirst = await readFile(join(waPiDir, "mcp.json"), "utf8");

		const second = await migrateGlobalMcpFile(waPiDir);
		expect(first.migrated).toBe(1);
		expect(second.migrated).toBe(0);
		expect(second.backup).toBeUndefined();
		expect(await readFile(join(waPiDir, "mcp.json"), "utf8")).toBe(afterFirst);
		expect(
			(await readdir(waPiDir)).filter((f) => f.startsWith("mcp.json.bak-")),
		).toHaveLength(1);
	});
});
