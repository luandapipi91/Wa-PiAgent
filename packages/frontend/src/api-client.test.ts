// api-client.test.ts — ApiError.failure 结构化错误透传测试（任务 4 i18n）
//
// 契约：非 2xx 时 ApiError 携带 failure（kernel 的 { code, params, detail }），
// 优先读响应体 failure 嵌套（routes 层本批形态），兼容顶层 code/params（任务 3 files.ts 形态）。
import { test, expect, afterEach } from "bun:test";
import { ApiError, api } from "./api-client";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("非 2xx 响应体带 failure 时 ApiError 携带 failure", async () => {
	globalThis.fetch = (async () =>
		new Response(
			JSON.stringify({
				error: "paths 为空",
				failure: { code: "share.pathsRequired" },
			}),
			{ status: 400 },
		)) as any;
	try {
		await api.post("/api/share/upload", {});
		expect.unreachable();
	} catch (e) {
		expect(e).toBeInstanceOf(ApiError);
		expect((e as ApiError).failure?.code).toBe("share.pathsRequired");
		expect((e as ApiError).message).toBe("paths 为空");
	}
});

test("兼容顶层 code/params 形态（任务 3 files.ts 先例）", async () => {
	globalThis.fetch = (async () =>
		new Response(
			JSON.stringify({
				error: "文件超过 20MB 上限",
				code: "attachment.tooLarge",
				params: { maxMb: 20 },
			}),
			{ status: 413 },
		)) as any;
	try {
		await api.post("/api/files/upload", {});
		expect.unreachable();
	} catch (e) {
		expect((e as ApiError).failure?.code).toBe("attachment.tooLarge");
		expect((e as ApiError).failure?.params?.maxMb).toBe(20);
	}
});

test("无结构化错误时 failure 为 undefined（行为不变）", async () => {
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ error: "boom" }), { status: 500 })) as any;
	try {
		await api.get("/api/x");
		expect.unreachable();
	} catch (e) {
		expect((e as ApiError).failure).toBeUndefined();
		expect((e as ApiError).message).toBe("boom");
	}
});
