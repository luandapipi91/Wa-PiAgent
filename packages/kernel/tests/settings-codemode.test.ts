import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import {
	loadCodemodeLevel,
	saveCodemodeLevel,
} from "../src/settings-store";

// codemode 三档（off/compat/full）在 settings.json 的读写。
// 存储形态：Wa-Pi 产品键 codemodeLevel + pi 引擎键 codemode.mode 联动——
//   full → 写 { codemode: { mode: "only" } }（pi 引擎自读）；
//   compat/off → 删除 codemode 键（"on" 是引擎默认，off 时工具未启用键无意义）。
// 另联动 mcp.json 顶层 autoEnableCodemode：pi 引擎对 codemode 曝光的 MCP 服务器
// 会无视 --tools 自动激活 codemode 工具（extensions/mcp/index.js setActiveTools），
// off 档必须显式写 false 才能真关；compat/full 删该键恢复引擎默认 true。
// 全程用 tmpdir 隔离文件，绝不触碰真实 ~/.pi/agent。

let dir: string;
let file: string;
let mcpFile: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "wa-pi-settings-codemode-"));
	file = join(dir, "settings.json");
	mcpFile = join(dir, "mcp.json");
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("loadCodemodeLevel", () => {
	it("未配置时返回默认档「兼容」（compat）", async () => {
		expect(await loadCodemodeLevel(file)).toBe("compat");
	});

	it("磁盘脏值（白名单外）→ 回落默认 compat", async () => {
		await writeFile(file, JSON.stringify({ codemodeLevel: "yolo" }), "utf8");
		expect(await loadCodemodeLevel(file)).toBe("compat");
	});

	it("已配置 off → off（用户显式关闭不被默认值覆盖）", async () => {
		await writeFile(file, JSON.stringify({ codemodeLevel: "off" }), "utf8");
		expect(await loadCodemodeLevel(file)).toBe("off");
	});
});

describe("saveCodemodeLevel", () => {
	it("round-trip：off / compat / full 各档写后读一致", async () => {
		for (const level of ["off", "compat", "full"] as const) {
			await saveCodemodeLevel(level, file, mcpFile);
			expect(await loadCodemodeLevel(file)).toBe(level);
		}
	});

	it("白名单外档位 → 抛错且不落盘", async () => {
		let thrown: unknown = null;
		try {
			await saveCodemodeLevel("yolo" as never, file, mcpFile);
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toContain("codemode");
		expect(await readFile(file, "utf8").catch(() => "")).toBe("");
	});

	it("full → 同步写 pi 引擎键 codemode.mode=only，且 mcp.json 不再压制自动启用", async () => {
		await writeFile(file, JSON.stringify({ codemode: { mode: "only" } }), "utf8");
		await writeFile(
			mcpFile,
			JSON.stringify({ autoEnableCodemode: false, mcpServers: { a: {} } }),
			"utf8",
		);
		await saveCodemodeLevel("full", file, mcpFile);
		const raw = JSON.parse(await readFile(file, "utf8"));
		expect(raw.codemodeLevel).toBe("full");
		expect(raw.codemode).toEqual({ mode: "only" });
		const mcp = JSON.parse(await readFile(mcpFile, "utf8"));
		expect(mcp.autoEnableCodemode).toBeUndefined();
		expect(mcp.mcpServers).toEqual({ a: {} });
	});

	it("compat → 删除 pi 引擎键 codemode，并删 mcp.json 的 autoEnableCodemode（恢复引擎默认自动启用）", async () => {
		await writeFile(
			file,
			JSON.stringify({ codemode: { mode: "only", inlineBudget: 500 } }),
			"utf8",
		);
		await writeFile(
			mcpFile,
			JSON.stringify({ autoEnableCodemode: false, mcpServers: {} }),
			"utf8",
		);
		await saveCodemodeLevel("compat", file, mcpFile);
		const raw = JSON.parse(await readFile(file, "utf8"));
		expect(raw.codemodeLevel).toBe("compat");
		expect(raw.codemode).toBeUndefined();
		const mcp = JSON.parse(await readFile(mcpFile, "utf8"));
		expect(mcp.autoEnableCodemode).toBeUndefined();
	});

	it("off → 同删 pi 引擎键，且 mcp.json 写 autoEnableCodemode:false（压引擎自动激活）", async () => {
		await writeFile(
			mcpFile,
			JSON.stringify({ mcpServers: { yunxiao: { url: "https://x" } } }),
			"utf8",
		);
		await saveCodemodeLevel("off", file, mcpFile);
		const raw = JSON.parse(await readFile(file, "utf8"));
		expect(raw.codemodeLevel).toBe("off");
		expect(raw.codemode).toBeUndefined();
		const mcp = JSON.parse(await readFile(mcpFile, "utf8"));
		expect(mcp.autoEnableCodemode).toBe(false);
		expect(mcp.mcpServers).toEqual({ yunxiao: { url: "https://x" } });
	});

	it("off + mcp.json 不存在 → 创建仅含 autoEnableCodemode:false 的最小文件", async () => {
		await saveCodemodeLevel("off", file, mcpFile);
		const mcp = JSON.parse(await readFile(mcpFile, "utf8"));
		expect(mcp).toEqual({ autoEnableCodemode: false });
	});

	it("read-modify-write：保留 retry / defaultTools 等其他键", async () => {
		await writeFile(
			file,
			JSON.stringify({
				retry: { maxRetries: 5, baseDelayMs: 1000 },
				defaultTools: ["read", "bash"],
			}),
			"utf8",
		);
		await saveCodemodeLevel("full", file);
		const raw = JSON.parse(await readFile(file, "utf8"));
		expect(raw.retry).toEqual({ maxRetries: 5, baseDelayMs: 1000 });
		expect(raw.defaultTools).toEqual(["read", "bash"]);
		expect(raw.codemode).toEqual({ mode: "only" });
	});
});
