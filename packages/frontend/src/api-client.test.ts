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

test("get 支持自定义超时：传入 5ms 时挂起的请求快速中止", async () => {
	// mock：永不返回的 fetch，只响应 signal 的 abort（模拟真实 fetch 的中止语义）
	globalThis.fetch = ((_: unknown, init?: RequestInit) =>
		new Promise((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () =>
				reject(new DOMException("This operation was aborted", "AbortError")),
			);
		})) as any;
	await expect(api.get("/api/mcp", 5)).rejects.toThrow();
}, 2_000);

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

// MCP 保存（`POST /api/mcp`）的 400 回包带字段级 `errors[]`：ApiError 必须一并携带，
// 否则表单无法把提示绑到对应输入框（只能弹一个总错误）。
test("400 带字段级 errors 时 ApiError 携带 errors", async () => {
	globalThis.fetch = (async () =>
		new Response(
			JSON.stringify({
				error: "只允许字母、数字、下划线与连字符",
				errors: [{ field: "name", message: "只允许字母、数字、下划线与连字符" }],
			}),
			{ status: 400 },
		)) as any;
	try {
		await api.post("/api/mcp", { config: { name: "bad name!" } });
		expect.unreachable();
	} catch (e) {
		expect((e as ApiError).errors).toEqual([
			{ field: "name", message: "只允许字母、数字、下划线与连字符" },
		]);
		// 无 failure 时仍可读 message（顶层 error）
		expect((e as ApiError).failure).toBeUndefined();
		expect((e as ApiError).message).toContain("只允许字母");
	}
});

test("无 errors 字段时 ApiError.errors 为 undefined", async () => {
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ error: "boom" }), { status: 400 })) as any;
	try {
		await api.post("/api/mcp", {});
		expect.unreachable();
	} catch (e) {
		expect((e as ApiError).errors).toBeUndefined();
	}
});
