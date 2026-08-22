import type { ProviderApi, ProviderModel } from "@wa-pi/shared";

interface TestInput {
	baseUrl: string;
	apiKey: string;
	api: ProviderApi;
	models: ProviderModel[];
}

export interface TestResult {
	ok: boolean;
	error?: string;
}

/** 超时 10 秒 */
const TIMEOUT_MS = 10000;

/** 当前代理环境变量诊断（仅在检测到代理时附加，帮助定位「走没走代理」问题） */
function proxyDiagnostic(): string {
	const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
	return proxy ? `【代理: ${proxy}】` : "";
}

/**
 * 连通测试：kernel 直接 fetch 探测供应商（不走 Pi 注册链路）。
 * - openai-completions → GET {baseUrl}/models，Authorization: Bearer
 * - anthropic-messages → POST {baseUrl}/v1/messages 最小请求，x-api-key + anthropic-version
 * 2xx 视为成功，其他返回失败 + 错误信息。
 */
export async function testProviderConnection(
	input: TestInput,
): Promise<TestResult> {
	const base = input.baseUrl.replace(/\/+$/, ""); // 去尾部斜杠
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

	try {
		if (input.api === "openai-completions") {
			const res = await fetch(`${base}/models`, {
				headers: { Authorization: `Bearer ${input.apiKey}` },
				signal: controller.signal,
			});
			if (res.ok) return { ok: true };
			const body = await res.text().catch(() => "");
			return {
				ok: false,
				error: `HTTP ${res.status} ${body.slice(0, 200)} ${proxyDiagnostic()}`.trim(),
			};
		} else {
			// anthropic-messages：发最小请求（路径与 Anthropic SDK 一致，用 /v1/messages）
			const modelId = input.models[0]?.id ?? "test";
			const res = await fetch(`${base}/v1/messages`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-api-key": input.apiKey,
					"anthropic-version": "2023-06-01",
				},
				body: JSON.stringify({
					model: modelId,
					max_tokens: 1,
					messages: [{ role: "user", content: "ping" }],
				}),
				signal: controller.signal,
			});
			if (res.ok) return { ok: true };
			const body = await res.text().catch(() => "");
			return {
				ok: false,
				error: `HTTP ${res.status} ${body.slice(0, 200)} ${proxyDiagnostic()}`.trim(),
			};
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			error: controller.signal.aborted
				? `超时（${TIMEOUT_MS}ms）${proxyDiagnostic()}`.trim()
				: `${msg} ${proxyDiagnostic()}`.trim(),
		};
	} finally {
		clearTimeout(timer);
	}
}
