// McpFile：MCP 配置的唯一写入者。
// 两条核心不变量：
//   1. 保存时以**旧条目为基底**合并 —— 同文件内的未知字段（其他工具写入的键）必须原样保留。
//      历史 bug（F15）：旧实现整条替换 server 条目，用户/其他工具写的字段被静默抹掉。
//   2. 校验失败必须返回字段级错误且**不写盘**。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpFile, hasProjectMcpFile, projectMcpPath } from "../mcp-file.ts";

let dir = "";

afterEach(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
});

async function setup(initial: unknown) {
	dir = await mkdtemp(join(tmpdir(), "mcpfile-"));
	const globalPath = join(dir, "mcp.json");
	const projectPath = join(dir, "proj", ".pi", "mcp.json");
	await writeFile(globalPath, JSON.stringify(initial, null, 2));
	const file = new McpFile({ globalPath, projectPathFor: async () => projectPath });
	return { file, globalPath, projectPath };
}

describe("McpFile", () => {
	test("保存服务器时必须保留同文件的未知字段（F15 的教训）", async () => {
		const { file, globalPath } = await setup({
			mcpServers: {
				keep: {
					command: "x",
					toolExposure: { t: "hidden" },
					enabled: false,
					timeout: 45,
					extraUnknown: 1,
				},
			},
		});
		await file.save({ name: "keep", command: "y", args: ["--v"] });
		const raw = JSON.parse(await readFile(globalPath, "utf8"));
		expect(raw.mcpServers.keep.toolExposure).toEqual({ t: "hidden" });
		expect(raw.mcpServers.keep.enabled).toBe(false);
		expect(raw.mcpServers.keep.timeout).toBe(45);
		expect(raw.mcpServers.keep.extraUnknown).toBe(1);
		expect(raw.mcpServers.keep.command).toBe("y");
	});

	test("列表按作用域隔离", async () => {
		const { file } = await setup({ mcpServers: { g: { command: "a" } } });
		await file.save({ name: "p", url: "https://x/mcp" }, "p1");
		expect((await file.list("p1")).map((s) => s.name)).toEqual(["p"]);
		expect((await file.list()).map((s) => s.name)).toEqual(["g"]);
	});

	test("非法名或 type/command/url 冲突时返回字段级错误且不写盘", async () => {
		const { file, globalPath } = await setup({ mcpServers: {} });
		const bad = await file.save({
			name: "bad name!",
			command: "a",
			url: "https://x/mcp",
		} as never);
		expect(bad.ok).toBe(false);
		if (bad.ok) throw new Error("应当校验失败");
		expect(bad.errors.map((e) => e.field)).toEqual(["name", "url"]);
		expect(JSON.parse(await readFile(globalPath, "utf8")).mcpServers).toEqual({});
	});

	test("delete 只移除目标服务器，同文件其他服务器与顶层未知字段不动", async () => {
		const { file, globalPath } = await setup({
			mcpServers: { a: { command: "x" }, b: { command: "y" } },
			autoEnableCodemode: false,
			extraTop: 1,
		});
		await file.delete("a");
		const raw = JSON.parse(await readFile(globalPath, "utf8"));
		expect(Object.keys(raw.mcpServers)).toEqual(["b"]);
		expect(raw.mcpServers.b).toEqual({ command: "y" });
		expect(raw.autoEnableCodemode).toBe(false);
		expect(raw.extraTop).toBe(1);
	});

	test("delete 不存在的服务器 → 抛 mcp.serverNotFound", async () => {
		const { file } = await setup({ mcpServers: {} });
		let code: string | undefined;
		try {
			await file.delete("nope");
		} catch (e: unknown) {
			code = (e as { code?: string }).code;
		}
		expect(code).toBe("mcp.serverNotFound");
	});

	test("getAutoEnableCodemode：缺省 true，显式 false 时 false", async () => {
		const { file } = await setup({ mcpServers: {} });
		expect(await file.getAutoEnableCodemode()).toBe(true);
		const { file: off } = await setup({ mcpServers: {}, autoEnableCodemode: false });
		expect(await off.getAutoEnableCodemode()).toBe(false);
	});

	test("保存载荷里的显式 undefined 视为未填，不得抹掉盘上已保留的字段", async () => {
		const { file, globalPath } = await setup({
			mcpServers: {
				keep: { command: "x", toolExposure: { t: "hidden" }, enabled: false, timeout: 45 },
			},
		});
		// 任务 8 的路由按表单组装载荷：未填写的字段会是 undefined
		await file.save({
			name: "keep",
			command: "y",
			timeout: undefined,
			enabled: undefined,
			toolExposure: undefined,
			exposure: undefined,
		});
		const raw = JSON.parse(await readFile(globalPath, "utf8"));
		expect(raw.mcpServers.keep.command).toBe("y");
		expect(raw.mcpServers.keep.toolExposure).toEqual({ t: "hidden" });
		expect(raw.mcpServers.keep.enabled).toBe(false);
		expect(raw.mcpServers.keep.timeout).toBe(45);
	});

	test("mcpServers 为数组（用户手工清空列表）时 save 仍把服务器写进文件", async () => {
		const { file, globalPath } = await setup({ mcpServers: [] });
		const result = await file.save({ name: "added", command: "x" });
		expect(result).toEqual({ ok: true });
		const raw = JSON.parse(await readFile(globalPath, "utf8"));
		expect(Array.isArray(raw.mcpServers)).toBe(false);
		expect(raw.mcpServers.added).toEqual({ command: "x" });
	});

	test("根不是对象或 mcpServers 不是 map → 抛 mcp.configParseFailed，不泄漏裸 TypeError", async () => {
		const readCode = async (file: McpFile): Promise<string | undefined> => {
			try {
				await file.list();
				return undefined;
			} catch (e: unknown) {
				return (e as { code?: string }).code;
			}
		};
		for (const broken of [null, [], { mcpServers: "abc" }, { mcpServers: 0 }]) {
			const { file } = await setup(broken);
			expect(await readCode(file)).toBe("mcp.configParseFailed");
		}
	});

	test("projectMcpPath / hasProjectMcpFile 指向项目级 <cwd>/.pi/mcp.json", async () => {
		const { file } = await setup({ mcpServers: {} });
		const projectCwd = join(dir, "proj");
		expect(projectMcpPath(projectCwd)).toBe(join(projectCwd, ".pi", "mcp.json"));
		expect(hasProjectMcpFile(projectCwd)).toBe(false);
		await file.save({ name: "p", command: "x" }, "p1");
		expect(hasProjectMcpFile(projectCwd)).toBe(true);
	});
});

// 任务 8 把 REST 写接口接到本模块后，同进程并发写成为可达路径（前端 store 是 fire-and-forget，
// 连点保存/删除即产生并发写）。端点与既有调用面每次请求都可能 new 一个 McpFile，故串行化
// 必须挂在**模块级**、按目标路径分桶（实例级队列串不住不同实例）。
// 不串行化的后果：两个写者读到同一份基底（丢更新），且互踩同一个 `<path>.<pid>.tmp`
// （先完成者的 rename 把临时文件移走，后者的 rename 抛 ENOENT）。
describe("McpFile 同进程并发写（读-改-写串行化）", () => {
	test("并发 save 两个不同 server（不同实例）→ 两者都在盘上", async () => {
		dir = await mkdtemp(join(tmpdir(), "mcpfile-conc-"));
		const globalPath = join(dir, "mcp.json");
		const newFile = () =>
			new McpFile({ globalPath, projectPathFor: async () => globalPath });

		await Promise.all([
			newFile().save({ name: "srv-a", command: "node" }),
			newFile().save({ name: "srv-b", command: "node" }),
		]);

		const raw = JSON.parse(await readFile(globalPath, "utf8"));
		expect(Object.keys(raw.mcpServers).sort()).toEqual(["srv-a", "srv-b"]);
	});

	test("并发 delete 两个不同 server（不同实例）→ 两个都从盘上消失", async () => {
		const { file, globalPath } = await setup({
			mcpServers: { a: { command: "x" }, b: { command: "y" } },
		});
		const other = new McpFile({ globalPath, projectPathFor: async () => globalPath });

		await Promise.all([file.delete("a"), other.delete("b")]);

		const raw = JSON.parse(await readFile(globalPath, "utf8"));
		expect(Object.keys(raw.mcpServers)).toEqual([]);
	});
});
