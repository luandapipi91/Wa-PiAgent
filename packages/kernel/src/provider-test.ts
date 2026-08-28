import type { ProviderApi, ProviderModel, ProviderTestFailure } from "@wa-pi/shared";

interface TestInput {
	baseUrl: string;
	apiKey: string;
	api: ProviderApi;
	models: ProviderModel[];
}

export interface TestResult {
	ok: boolean;
	/** 英文技术兑底串（用户可读文案由前端按 failure.code 查字典渲染） */
	error?: string;
	/** 结构化失败载荷：前端按 code 查 kernelMsg 字典渲染，优先于 error */
	failure?: ProviderTestFailure;
}

/** 超时 10 秒 */
const DEFAULT_TIMEOUT_MS = 10000;
let timeoutMs = DEFAULT_TIMEOUT_MS;

/** 测试用：调整连通测试超时（毫秒） */
export function setTestTimeoutMs(ms: number): void {
	timeoutMs = ms;
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
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		if (input.api === "openai-completions") {
			const res = await fetch(`${base}/models`, {
				headers: { Authorization: `Bearer ${input.apiKey}` },
				signal: controller.signal,
			});
			if (res.ok) return { ok: true };
			const body = await res.text().catch(() => "");
			// 上游已应答的 HTTP 错误（401/404 等）：错误已在眼前，不再附带代理诊断
			// （代理后缀只服务「连接层失败走没走代理」的定位，混入会误导用户）
			return {
				ok: false,
				error: `HTTP ${res.status} ${body.slice(0, 200)}`.trim(),
				failure: {
					code: "provider.httpStatus",
					params: { status: res.status },
					detail: body.slice(0, 200),
				},
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
			// 同上：HTTP 状态错误不附带代理诊断
			return {
				ok: false,
				error: `HTTP ${res.status} ${body.slice(0, 200)}`.trim(),
				failure: {
					code: "provider.httpStatus",
					params: { status: res.status },
					detail: body.slice(0, 200),
				},
			};
		}
	} catch {
		// error 兑底串改英文：人话文案由前端按 failure.code 查字典渲染（i18n），
		// 代理/错误码等基础设施细节同样不透传
		return {
			ok: false,
			error: controller.signal.aborted
				? `timeout after ${Math.round(timeoutMs / 1000)}s`
				: "network error",
			failure: controller.signal.aborted
				? { code: "provider.testTimeout" }
				: { code: "provider.testNetwork" },
		};
	} finally {
		clearTimeout(timer);
	}
}
