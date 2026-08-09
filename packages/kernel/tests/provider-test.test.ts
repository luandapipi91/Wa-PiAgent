import { test, expect, mock, afterEach } from "bun:test";
import { testProviderConnection } from "../src/provider-test";
import type { ProviderModel } from "@wa-pi/shared";

// mock 全局 fetch
const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function mockFetch(status: number, body: unknown = {}) {
	globalThis.fetch = mock(
		async () =>
			new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			}),
	) as any;
}

const models: ProviderModel[] = [
	{ id: "test-model", contextWindow: 128000, maxTokens: 4096 },
];

test("openai-completions GET /models 2xx 成功", async () => {
	mockFetch(200, { data: [] });
	const result = await testProviderConnection({
		baseUrl: "https://api.deepseek.com/v1",
		apiKey: "sk-test",
		api: "openai-completions",
		models,
	});
	expect(result.ok).toBe(true);
});

test("openai-completions 请求带 Authorization Bearer", async () => {
	const fetchMock = mock(
		async (input: string, init?: any) => new Response("{}", { status: 200 }),
	);
	globalThis.fetch = fetchMock as any;
	await testProviderConnection({
		baseUrl: "https://api.deepseek.com/v1",
		apiKey: "sk-test",
		api: "openai-completions",
		models,
	});
	expect(fetchMock).toHaveBeenCalledTimes(1);
	const [url, init] = fetchMock.mock.calls[0];
	expect(String(url)).toBe("https://api.deepseek.com/v1/models");
	expect(init.headers["Authorization"]).toBe("Bearer sk-test");
});

test("openai-completions 非 2xx 失败带状态码", async () => {
	mockFetch(401, { error: "invalid api key" });
	const result = await testProviderConnection({
		baseUrl: "https://api.deepseek.com/v1",
		apiKey: "sk-test",
		api: "openai-completions",
		models,
	});
	expect(result.ok).toBe(false);
	expect(result.error).toContain("401");
});

test("anthropic-messages POST /v1/messages 2xx 成功", async () => {
	mockFetch(200, { id: "msg_1", content: [] });
	const result = await testProviderConnection({
		baseUrl: "https://api.anthropic.com",
		apiKey: "sk-ant-test",
		api: "anthropic-messages",
		models,
	});
	expect(result.ok).toBe(true);
});

test("anthropic-messages 带 x-api-key + anthropic-version header", async () => {
	const fetchMock = mock(
		async (input: string, init?: any) => new Response("{}", { status: 200 }),
	);
	globalThis.fetch = fetchMock as any;
	await testProviderConnection({
		baseUrl: "https://api.anthropic.com",
		apiKey: "sk-ant-test",
		api: "anthropic-messages",
		models,
	});
	const [url, init] = fetchMock.mock.calls[0];
	// URL 必须是 /v1/messages（与 Anthropic SDK 一致），而非 /messages
	expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
	expect(init.headers["x-api-key"]).toBe("sk-ant-test");
	expect(init.headers["anthropic-version"]).toBe("2023-06-01");
});

test("anthropic-messages Kimi Code baseUrl 不带 /v1 也能拼出正确路径", async () => {
	// 回归测试：Kimi Code 端点 baseUrl 为 https://api.kimi.com/coding（不带 /v1），
	// provider-test 必须拼出 /coding/v1/messages（与 Anthropic SDK 一致），
	// 而非 /coding/messages（会导致 404 resource_not_found_error）
	const fetchMock = mock(async () => new Response("{}", { status: 200 }));
	globalThis.fetch = fetchMock as any;
	await testProviderConnection({
		baseUrl: "https://api.kimi.com/coding",
		apiKey: "sk-kimi-test",
		api: "anthropic-messages",
		models,
	});
	const [url] = fetchMock.mock.calls[0] as any;
	expect(String(url)).toBe("https://api.kimi.com/coding/v1/messages");
	expect(String(url)).not.toBe("https://api.kimi.com/coding/messages");
});

test("网络错误（fetch reject）返回失败", async () => {
	globalThis.fetch = mock(async () => {
		throw new Error("ECONNREFUSED");
	}) as any;
	const result = await testProviderConnection({
		baseUrl: "https://unreachable.example.com/v1",
		apiKey: "sk-test",
		api: "openai-completions",
		models,
	});
	expect(result.ok).toBe(false);
	expect(result.error).toContain("ECONNREFUSED");
});

test("baseUrl 结尾无 / 自动补全路径", async () => {
	const fetchMock = mock(async () => new Response("{}", { status: 200 }));
	globalThis.fetch = fetchMock as any;
	await testProviderConnection({
		baseUrl: "https://api.deepseek.com/v1/", // 带尾 /
		apiKey: "sk-test",
		api: "openai-completions",
		models,
	});
	const [url] = fetchMock.mock.calls[0] as any;
	// 不应出现双斜杠
	expect(String(url)).not.toContain("//models");
});
