import { test, expect, mock, afterEach } from "bun:test";
import { testProviderConnection, setTestTimeoutMs } from "../src/provider-test";
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
		async (_input: string, _init?: any) => new Response("{}", { status: 200 }),
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
	// 结构化失败载荷：code + params 供前端按字典渲染，detail 带上游响应原文
	expect(result.failure).toEqual({
		code: "provider.httpStatus",
		params: { status: 401 },
		detail: expect.stringContaining("invalid api key"),
	});
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
		async (_input: string, _init?: any) => new Response("{}", { status: 200 }),
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
	// error 兜底串改英文（技术兜底，用户可读文案由前端按 failure.code 查字典渲染）
	expect(result.error).toBe("network error");
	expect(result.failure).toEqual({ code: "provider.testNetwork" });
	// 结构化通道不透传原始错误码
	expect(JSON.stringify(result.failure)).not.toContain("ECONNREFUSED");
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

// ── 代理诊断后缀：只服务网络层失败，不再污染上游已应答的错误 ──

const ORIGINAL_HTTPS_PROXY = process.env.HTTPS_PROXY;
const ORIGINAL_HTTP_PROXY = process.env.HTTP_PROXY;

function withProxyEnv(fn: () => Promise<void>) {
	process.env.HTTPS_PROXY = "http://127.0.0.1:61614";
	return async () => {
		try {
			await fn();
		} finally {
			if (ORIGINAL_HTTPS_PROXY === undefined) delete process.env.HTTPS_PROXY;
			else process.env.HTTPS_PROXY = ORIGINAL_HTTPS_PROXY;
			if (ORIGINAL_HTTP_PROXY === undefined) delete process.env.HTTP_PROXY;
			else process.env.HTTP_PROXY = ORIGINAL_HTTP_PROXY;
		}
	};
}

test(
	"上游已应答的 HTTP 错误（如 401 错误 key）不附带代理诊断",
	withProxyEnv(async () => {
		mockFetch(401, { error: "invalid api key" });
		const result = await testProviderConnection({
			baseUrl: "https://api.z.ai/api/paas/v4",
			apiKey: "wrong-key",
			api: "openai-completions",
			models,
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("401");
		expect(result.failure).toEqual({
			code: "provider.httpStatus",
			params: { status: 401 },
			detail: expect.stringContaining("invalid api key"),
		});
		expect(result.error).not.toContain("代理");
		expect(result.error).not.toContain("127.0.0.1");
	}),
);

test(
	"网络层异常返回结构化 failure + 英文兜底串，不透传技术细节与代理信息",
	withProxyEnv(async () => {
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
		expect(result.error).toBe("network error");
		expect(result.failure).toEqual({ code: "provider.testNetwork" });
		// 代理与技术细节对用户隐藏
		expect(result.error).not.toContain("代理");
		expect(result.error).not.toContain("127.0.0.1");
		expect(result.error).not.toContain("ECONNREFUSED");
	}),
);

test("超时显示用户可读文案，不附带代理信息", async () => {
	process.env.HTTPS_PROXY = "http://127.0.0.1:61614";
	setTestTimeoutMs(30);
	try {
		// 真实超时路径：fetch 永不 resolve，直到 controller.abort() 触发 signal 才 reject
		globalThis.fetch = mock(
			(_input: any, init?: any) =>
				new Promise((_res, rej) => {
					init?.signal?.addEventListener("abort", () =>
						rej(new DOMException("aborted", "AbortError")),
					);
				}),
		) as any;
		const result = await testProviderConnection({
			baseUrl: "https://slow.example.com/v1",
			apiKey: "sk-test",
			api: "openai-completions",
			models,
		});
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/^timeout after \d+s$/);
		expect(result.failure).toEqual({ code: "provider.testTimeout" });
		expect(result.error).not.toContain("代理");
	} finally {
		delete process.env.HTTPS_PROXY;
		setTestTimeoutMs(10_000);
	}
});
