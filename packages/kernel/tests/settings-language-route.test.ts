import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { HttpRouter } from "../src/http-router";
import { loadLanguage } from "../src/settings-store";
import { registerSettingsRoutes } from "../src/routes/settings";

// language 路由 GET/PUT /api/settings/language 往返；save 后 loadLanguage 生效。
// 通过 RouteContext.settingsFile 注入 tmpdir 里的隔离 settings.json，
// 不依赖进程/模块缓存顺序，也绝不触碰真实 ~/.pi/agent/settings.json。

let dir: string;
let file: string;
let router: HttpRouter;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "wa-pi-settings-language-route-"));
	file = join(dir, "settings.json");
	const callApi = mock(async () => Response.json({}));
	router = new HttpRouter();
	registerSettingsRoutes(router, callApi, {
		projectStore: {} as any,
		settingsFile: file,
	});
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("GET /api/settings/language", () => {
	it("未配置时返回 { language: null }（跟随前端，不落默认值）", async () => {
		const res = await router.handle(
			new Request("http://localhost/api/settings/language", { method: "GET" }),
		);
		expect(res?.status).toBe(200);
		expect(await res?.json()).toEqual({ language: null });
	});
});

describe("PUT /api/settings/language", () => {
	it("写入 en 后返回 { language: 'en' }，且 loadLanguage 从隔离文件读到新值", async () => {
		const res = await router.handle(
			new Request("http://localhost/api/settings/language", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ language: "en" }),
			}),
		);
		expect(res?.status).toBe(200);
		expect(await res?.json()).toEqual({ language: "en" });
		// 路由写盘到隔离文件后，store 层再读该文件应看到新值
		expect(await loadLanguage(file)).toBe("en");
	});

	it("白名单外语言（fr）→ 500 {error}，不落盘", async () => {
		const res = await router.handle(
			new Request("http://localhost/api/settings/language", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ language: "fr" }),
			}),
		);
		expect(res?.status).toBe(500);
		const body = (await res?.json()) as { error?: string };
		expect(body.error).toBeTruthy();
		// 非法值不落盘
		expect(await loadLanguage(file)).toBeUndefined();
	});
});
