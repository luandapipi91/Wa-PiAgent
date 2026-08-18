// 把产物分享相关 REST 调用封装成 Promise。
// 与 fs-client 同款 transport 注入模式：默认走真实 api-client；
// 单测可通过 `_setShareTransport` 注入伪传输，避免 bun mock.module 跨文件缓存污染。
import { api } from "./api-client";

/** 产物分享上传返回（与 kernel POST /api/share/upload 契约一致） */
export interface ShareUploadResult {
	url: string;
	expiresAt: number;
	projectName: string;
	channel: string;
}

/** 分享设置读取结果（GET /api/settings/share 的 share 字段；token 脱敏为 hasToken，不下发明文） */
export interface ShareSettingsInfo {
	hasToken: boolean;
	channel: string;
}

/** 分享设置保存入参（PUT /api/settings/share 的 share 字段；token 为用户明文输入） */
export interface ShareSettingsInput {
	token: string;
	channel: string;
}

/**
 * 底层传输抽象。默认走真实 api-client；单测可通过 `_setShareTransport` 注入伪传输。
 * put/get 必选：接口中已声明为必选方法，与 fs-client 一致的可注入形态。
 */
export interface ShareTransport {
	post: (path: string, body?: unknown) => Promise<unknown>;
	put: (path: string, body?: unknown) => Promise<unknown>;
	get: (path: string) => Promise<unknown>;
}

const defaultTransport: ShareTransport = {
	post: (path, body) => api.post(path, body),
	put: (path, body) => api.put(path, body),
	get: (path) => api.get(path),
};
let transport: ShareTransport = defaultTransport;

/** 测试注入传输层；传 null 恢复默认（真实 api-client）。 */
export function _setShareTransport(t: ShareTransport | null): void {
	transport = t ?? defaultTransport;
}

/** 上传产物生成分享链接。未配置 token 时 kernel 返回 400（ApiError）。 */
export async function shareUpload(
	paths: string[],
	sessionId?: string,
): Promise<ShareUploadResult> {
	return (await transport.post("/api/share/upload", {
		paths,
		sessionId,
	})) as ShareUploadResult;
}

/** 读取分享设置（是否已配置 token + 渠道）。token 不明文下发，只有 hasToken 布尔。 */
export async function shareSettings(): Promise<ShareSettingsInfo> {
	const res = (await transport.get("/api/settings/share")) as {
		share?: Partial<ShareSettingsInfo>;
	};
	return {
		hasToken: res.share?.hasToken === true,
		channel: res.share?.channel ?? "",
	};
}

/** 保存分享设置（token 明文仅 PUT 上行，回包不落盘读取）。 */
export async function saveShareSettings(
	share: ShareSettingsInput,
): Promise<void> {
	await transport.put("/api/settings/share", { share });
}
