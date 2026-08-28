/** kernel 面向用户错误的稳定契约：code 由前端字典渲染，params 做插值；detail 是技术细节（默认不展示） */
export interface KernelErrorPayload {
	code: string;
	params?: Record<string, string | number>;
	detail?: string;
}

/** provider 连通测试的结构化失败载荷：与 KernelErrorPayload 同构（code/params/detail） */
export type ProviderTestFailure = KernelErrorPayload;

export class KernelError extends Error {
	readonly code: string;
	readonly params?: Record<string, string | number>;
	readonly detail?: string;
	constructor(
		code: string,
		params?: Record<string, string | number>,
		detail?: string,
	) {
		super(code);
		this.code = code;
		this.params = params;
		this.detail = detail;
	}
}

export function toKernelPayload(e: unknown): KernelErrorPayload | null {
	if (e instanceof KernelError) {
		const params = e.params
			? Object.fromEntries(
					Object.entries(e.params).map(([k, v]) => [k, String(v)]),
				)
			: undefined;
		return { code: e.code, params, detail: e.detail };
	}
	return null;
}
