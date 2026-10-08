import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { HttpRouter } from "../src/http-router";
import { loadCodemodeLevel } from "../src/settings-store";
import { registerSettingsRoutes } from "../src/routes/settings";

// codemode 路由 GET/PUT /api/settings/codemode；ctx.settingsFile 注入 tmpdir 隔离
// 文件，markAllDirty 用 mock 记录调用（保存必须标脏重建 pi 进程）。

let dir: string;
let file: string;
let mcpFile: string;
let router: HttpRouter;
let markAllDirty: ReturnType<typeof mock>;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "wa-pi-settings-codemode-route-"));
	file = join(dir, "settings.json");
	mcpFile = join(dir, "mcp.json");
	markAllDirty = mock(() => {});
	router = new HttpRouter();
	registerSettingsRoutes(router, mock(async () => Response.json({})), {
		projectStore: {} as any,
		settingsFile: file,
		mcpFile,
		markAllDirty,
	});
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("GET /api/settings/codemode", () => {
	it("未配置时返回默认档 { level: 'compat' }", async () => {
		const res = await router.handle(
			new Request("http://localhost/api/settings/codemode", { method: "GET" }),
		);
		expect(res?.status).toBe(200);
		expect(await res?.json()).toEqual({ level: "compat" });
	});
});

describe("PUT /api/settings/codemode", () => {
	it("写入 compat 后回显 + markAllDirty 调用一次，pi 引擎键不残留", async () => {
		const res = await router.handle(
			new Request("http://localhost/api/settings/codemode", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ level: "compat" }),
			}),
		);
		expect(res?.status).toBe(200);
		expect(await res?.json()).toEqual({ level: "compat" });
		expect(await loadCodemodeLevel(file)).toBe("compat");
		const raw = JSON.parse(await readFile(file, "utf8"));
		expect(raw.codemode).toBeUndefined();
		// mcp.json 联动：compat 非关闭档，不压制引擎自动启用
		const mcp = JSON.parse(await readFile(mcpFile, "utf8"));
		expect(mcp.autoEnableCodemode).toBeUndefined();
		expect(markAllDirty).toHaveBeenCalledTimes(1);
	});

	it("写入 off → mcp.json 顶层 autoEnableCodemode:false（压引擎自动激活）", async () => {
		await router.handle(
			new Request("http://localhost/api/settings/codemode", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ level: "off" }),
			}),
		);
		const mcp = JSON.parse(await readFile(mcpFile, "utf8"));
		expect(mcp.autoEnableCodemode).toBe(false);
	});

	it("写入 compat 后 pi 引擎键被删除", async () => {
		await router.handle(
			new Request("http://localhost/api/settings/codemode", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ level: "compat" }),
			}),
		);
		const raw = JSON.parse(await readFile(file, "utf8"));
		expect(raw.codemodeLevel).toBe("compat");
		expect(raw.codemode).toBeUndefined();
	});

	it("白名单外档位 → 500 {error}，markAllDirty 不调用", async () => {
		const res = await router.handle(
			new Request("http://localhost/api/settings/codemode", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ level: "yolo" }),
			}),
		);
		expect(res?.status).toBe(500);
		expect((await res?.json())?.error).toBeTruthy();
		expect(markAllDirty).not.toHaveBeenCalled();
	});
});
