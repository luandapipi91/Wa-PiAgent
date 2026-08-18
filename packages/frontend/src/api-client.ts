/**
 * HTTP REST 客户端（阶段二·去 WS 化）
 *
 * 所有 kernel 请求走 `/api/*`：开发时 Vite 代理到 kernel，生产时与 kernel 同域。
 * 非 2xx 统一抛错，错误消息优先取 body.error。
 */

const API_BASE = "/api";

export class ApiError extends Error {
	status: number;
	constructor(message: string, status: number) {
		super(message);
		this.status = status;
		this.name = "ApiError";
	}
}

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
			body !== undefined ? { "content-type": "application/json" } : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined,
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
		throw new ApiError(message, res.status);
	}
	return data;
}

export const api = {
	get(path: string): Promise<unknown> {
		return request("GET", path);
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
