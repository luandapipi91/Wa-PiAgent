import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { HttpRouter } from "../src/http-router";
import { loadWebSearchSettings } from "../src/settings-store";
import { registerSettingsRoutes } from "../src/routes/settings";

// settings 路由 GET/PUT /api/settings/websearch 往返；save 后 loadWebSearchSettings 生效。
// 通过 RouteContext.settingsFile 注入 tmpdir 里的隔离 settings.json，绝不触碰真实文件。
// 安全：GET/PUT 回包均不下发 apiKey 明文（脱敏为 hasApiKey）。
// PUT 保存后必须触发 ctx.markAllDirty（开关决定扩展注册面，需重建会话生效）。

let dir: string;
let file: string;
let router: HttpRouter;
let markDirtyMock: ReturnType<typeof mock>;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "wa-pi-settings-websearch-route-"));
	file = join(dir, "settings.json");
	const callApi = mock(async () => Response.json({}));
	markDirtyMock = mock();
	router = new HttpRouter();
	registerSettingsRoutes(router, callApi, {
		projectStore: {} as any,
		settingsFile: file,
		markAllDirty: markDirtyMock,
	});
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("GET /api/settings/websearch", () => {
	it("未配置时返回默认值（双开关开、hasApiKey: false），不下发 key 明文", async () => {
		const res = await router.handle(
			new Request("http://localhost/api/settings/websearch", { method: "GET" }),
		);
		expect(res?.status).toBe(200);
		expect(await res?.json()).toEqual({
			webSearch: {
				searchEnabled: true,
				fetchEnabled: true,
				hasApiKey: false,
			},
		});
	});
});

describe("PUT /api/settings/websearch", () => {
	it("写入后回包脱敏（hasApiKey: true），且 loadWebSearchSettings 生效", async () => {
		const res = await router.handle(
			new Request("http://localhost/api/settings/websearch", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					webSearch: {
						searchEnabled: true,
						fetchEnabled: false,
						apiKey: "sk-deepseek-abc",
					},
				}),
			}),
		);
		expect(res?.status).toBe(200);
		expect(await res?.json()).toEqual({
			webSearch: {
				searchEnabled: true,
				fetchEnabled: false,
				hasApiKey: true,
			},
		});
		expect(await loadWebSearchSettings(file)).toEqual({
			searchEnabled: true,
			fetchEnabled: false,
			apiKey: "sk-deepseek-abc",
		});
		// 保存后触发会话重建标记（开关决定注册面，需重建才对模型可见性生效）
		expect(markDirtyMock).toHaveBeenCalledTimes(1);
	});

	it("PUT 不带 apiKey 字段时保留已存 key（编辑开关不冲掉 key）", async () => {
		await router.handle(
			new Request("http://localhost/api/settings/websearch", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					webSearch: { searchEnabled: true, fetchEnabled: true, apiKey: "sk-first" },
				}),
			}),
		);
		await router.handle(
			new Request("http://localhost/api/settings/websearch", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					webSearch: { searchEnabled: false, fetchEnabled: true },
				}),
			}),
		);
		const res = await router.handle(
			new Request("http://localhost/api/settings/websearch", { method: "GET" }),
		);
		expect(await res?.json()).toEqual({
			webSearch: {
				searchEnabled: false,
				fetchEnabled: true,
				hasApiKey: true,
			},
		});
	});

	it("GET 往返读到刚 PUT 的开关状态", async () => {
		await router.handle(
			new Request("http://localhost/api/settings/websearch", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					webSearch: { searchEnabled: false, fetchEnabled: false, apiKey: "" },
				}),
			}),
		);
		const res = await router.handle(
			new Request("http://localhost/api/settings/websearch", { method: "GET" }),
		);
		expect(await res?.json()).toEqual({
			webSearch: {
				searchEnabled: false,
				fetchEnabled: false,
				hasApiKey: false,
			},
		});
	});
});
