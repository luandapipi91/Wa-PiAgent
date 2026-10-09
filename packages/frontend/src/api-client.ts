/**
 * HTTP REST 客户端（阶段二·去 WS 化）
 *
 * 所有 kernel 请求走 `/api/*`：开发时 Vite 代理到 kernel，生产时与 kernel 同域。
 * 非 2xx 统一抛错，错误消息优先取 body.error。
 */

import type { KernelErrorPayload, McpFieldError } from "@wa-pi/shared";

const API_BASE = "/api";

export class ApiError extends Error {
	status: number;
	/** kernel 结构化错误（code 由前端字典渲染）；无结构化信息时 undefined */
	failure?: KernelErrorPayload;
	/** 字段级校验错误（`POST /api/mcp` 的 400 回包 `errors[]`）：表单据此把提示绑到对应输入框 */
	errors?: McpFieldError[];
	constructor(
		message: string,
		status: number,
		failure?: KernelErrorPayload,
		errors?: McpFieldError[],
	) {
		super(message);
		this.status = status;
		this.failure = failure;
		this.errors = errors;
		this.name = "ApiError";
	}
}

/**
 * MCP 面板走 `pi mcp list` 的请求超时：kernel 冷缓存要真 spawn pi（一台慢 server 单台
 * 可耗 60s+，kernel 缺省上限 70s，见 kernel/src/mcp-admin.ts DEFAULT_LIST_TIMEOUT_MS），
 * 前端必须等得比 kernel 更久，否则 kernel 还在读状态、前端先把请求掐了——表现为
 * 「加载中…」后列表空白（一台坏 server 拖垮整个面板）。
 */
export const MCP_RPC_TIMEOUT_MS = 80_000;

async function request(
	method: string,
	path: string,
	body?: unknown,
	timeoutMs = 30_000,
): Promise<unknown> {
	const url = path.startsWith("/api/") ? path : `${API_BASE}${path}`;
	const init: RequestInit = {
		method,
		headers:
			body === undefined ? undefined : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	};
	const res = await fetch(url, {
		...init,
		signal: AbortSignal.timeout(timeoutMs),
	});
	let data: any;
	try {
		data = await res.json();
	} catch {
		data = null;
	}
	if (!res.ok) {
		const message =
			data?.error ?? data?.message ?? `${res.status} ${res.statusText}`;
		// 结构化错误：优先 failure 嵌套（routes 层本批形态），兼容顶层 code/params（任务 3 先例）
		const failure: KernelErrorPayload | undefined =
			data?.failure ??
			(data?.code
				? { code: data.code, params: data.params, detail: data.detail }
				: undefined);
		// 字段级校验错误（MCP 保存的 400）：与 failure 并存，形状 { field, message }[]
		const errors: McpFieldError[] | undefined = Array.isArray(data?.errors)
			? data.errors
			: undefined;
		throw new ApiError(message, res.status, failure, errors);
	}
	return data;
}

export const api = {
	get(path: string, timeoutMs?: number): Promise<unknown> {
		return request("GET", path, undefined, timeoutMs);
	},
	post(path: string, body?: unknown, timeoutMs?: number): Promise<unknown> {
		return request("POST", path, body, timeoutMs);
	},
	put(path: string, body?: unknown): Promise<unknown> {
		return request("PUT", path, body);
	},
	del(path: string, body?: unknown): Promise<unknown> {
		return request("DELETE", path, body);
	},
	patch(path: string, body?: unknown): Promise<unknown> {
		return request("PATCH", path, body);
	},
};
