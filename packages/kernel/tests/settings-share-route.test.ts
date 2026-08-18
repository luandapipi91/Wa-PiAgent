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
	registerSettingsRoutes(router, callApi, {
		projectStore: {} as any,
		settingsFile: file,
	});
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("GET /api/settings/share", () => {
	it("未配置时返回脱敏默认值 { hasToken: false, channel: 'edgeone' }，不下发 token 明文", async () => {
		const res = await router.handle(
			new Request("http://localhost/api/settings/share", { method: "GET" }),
		);
		expect(res?.status).toBe(200);
		expect(await res?.json()).toEqual({
			share: { hasToken: false, channel: "edgeone", customDomain: "" },
		});
	});
});

describe("PUT /api/settings/share", () => {
	it("写入 share 后接口返回脱敏值（hasToken: true），且 loadShareSettings 生效", async () => {
		const res = await router.handle(
			new Request("http://localhost/api/settings/share", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ share: { token: "tk_abc", channel: "edgeone" } }),
			}),
		);
		expect(res?.status).toBe(200);
		// 回包不再带 token 明文（脱敏为 hasToken）
		expect(await res?.json()).toEqual({
			share: { hasToken: true, channel: "edgeone", customDomain: "" },
		});
		// 路由写盘到隔离文件后，store 层再读该文件也应看到新值（明文仍在落盘侧）
		expect(await loadShareSettings(file)).toEqual({
			token: "tk_abc",
			channel: "edgeone",
			customDomain: "",
		});
	});

	it("再 GET 一次能往返读到刚 PUT 的 share（hasToken: true）", async () => {
		await router.handle(
			new Request("http://localhost/api/settings/share", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					share: { token: "tk_roundtrip", channel: "edgeone" },
				}),
			}),
		);
		const res = await router.handle(
			new Request("http://localhost/api/settings/share", { method: "GET" }),
		);
		expect(await res?.json()).toEqual({
			share: { hasToken: true, channel: "edgeone", customDomain: "" },
		});
	});

	it("customDomain 读写 + token 空串保留原值", async () => {
		// PUT 完整值
		const put1 = await router.handle(
			new Request("http://localhost/api/settings/share", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					share: {
						token: "t-1",
						channel: "edgeone",
						customDomain: "share.example.com",
					},
				}),
			}),
		);
		expect((await put1?.json()).share.customDomain).toBe("share.example.com");
		// GET 回读（token 仍脱敏）
		const got = await router.handle(
			new Request("http://localhost/api/settings/share", { method: "GET" }),
		);
		expect(await got?.json()).toEqual({
			share: {
				hasToken: true,
				channel: "edgeone",
				customDomain: "share.example.com",
			},
		});
		// PUT 只改域名（token 传空串）→ 原 token 保留
		await router.handle(
			new Request("http://localhost/api/settings/share", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					share: { token: "", channel: "edgeone", customDomain: "cdn.example.com" },
				}),
			}),
		);
		const got2 = await router.handle(
			new Request("http://localhost/api/settings/share", { method: "GET" }),
		);
		const share2 = (await got2?.json()).share;
		expect(share2.hasToken).toBe(true);
		expect(share2.customDomain).toBe("cdn.example.com");
	});

	it("token 字段缺省（undefined）同样保留原值", async () => {
		await router.handle(
			new Request("http://localhost/api/settings/share", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ share: { token: "t-keep", channel: "edgeone" } }),
			}),
		);
		// PUT 不带 token 字段 → 原 token 保留
		await router.handle(
			new Request("http://localhost/api/settings/share", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					share: { channel: "edgeone", customDomain: "x.example.com" },
				}),
			}),
		);
		expect((await loadShareSettings(file)).token).toBe("t-keep");
	});
});
