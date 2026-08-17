import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { HttpRouter } from "../src/http-router";
import { loadShareSettings } from "../src/settings-store";
import { registerSettingsRoutes } from "../src/routes/settings";

// settings 路由 GET/PUT /api/settings/share 往返；save 后 loadShareSettings 生效。
// 通过 RouteContext.settingsFile 注入 tmpdir 里的隔离 settings.json，
// 不依赖进程/模块缓存顺序，也绝不触碰真实 ~/.pi/agent/settings.json。

let dir: string;
let file: string;
let router: HttpRouter;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "wa-pi-settings-share-route-"));
	file = join(dir, "settings.json");
	const callApi = mock(async () => Response.json({}));
	router = new HttpRouter();
	registerSettingsRoutes(router, callApi, { projectStore: {} as any, settingsFile: file });
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("GET /api/settings/share", () => {
	it("未配置时返回默认值 { token: '', channel: 'edgeone' }", async () => {
		const res = await router.handle(
			new Request("http://localhost/api/settings/share", { method: "GET" }),
		);
		expect(res?.status).toBe(200);
		expect(await res?.json()).toEqual({
			share: { token: "", channel: "edgeone" },
		});
	});
});

describe("PUT /api/settings/share", () => {
	it("写入 share 后接口返回保存值，且 loadShareSettings 生效", async () => {
		const res = await router.handle(
			new Request("http://localhost/api/settings/share", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ share: { token: "tk_abc", channel: "edgeone" } }),
			}),
		);
		expect(res?.status).toBe(200);
		expect(await res?.json()).toEqual({
			share: { token: "tk_abc", channel: "edgeone" },
		});
		// 路由写盘到隔离文件后，store 层再读该文件也应看到新值
		expect(await loadShareSettings(file)).toEqual({
			token: "tk_abc",
			channel: "edgeone",
		});
	});

	it("再 GET 一次能往返读到刚 PUT 的 share", async () => {
		await router.handle(
			new Request("http://localhost/api/settings/share", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ share: { token: "tk_roundtrip", channel: "edgeone" } }),
			}),
		);
		const res = await router.handle(
			new Request("http://localhost/api/settings/share", { method: "GET" }),
		);
		expect(await res?.json()).toEqual({
			share: { token: "tk_roundtrip", channel: "edgeone" },
		});
	});
});
