// 把产物分享相关 REST 调用封装成 Promise。
// 与 fs-client 同款 transport 注入模式：默认走真实 api-client；
// 单测可通过 `_setShareTransport` 注入伪传输，避免 bun mock.module 跨文件缓存污染。
import { api } from "./api-client";

/** 产物分享上传返回（与 kernel POST /api/share/upload 契约一致） */
export interface ShareUploadResult {
	id: string;
	/** 分享名（文件夹名/URL 子路径） */
	name: string;
	/** 同名合并标志：true 表示该分享名之前已存在，本次为追加/覆盖合并 */
	merged?: boolean;
	/** 合并后分享内的文件总数（提示用） */
	filesCount?: number;
	url: string;
	expiresAt: number;
	projectName: string;
	channel: string;
}

/** 分享设置读取结果（GET /api/settings/share 的 share 字段；token 脱敏为 hasToken，不下发明文） */
export interface ShareSettingsInfo {
	hasToken: boolean;
	channel: string;
	customDomain: string;
	accountId: string;
}

/** 分享设置保存入参（PUT /api/settings/share 的 share 字段；token 为用户明文输入） */
export interface ShareSettingsInput {
	token: string;
	channel: string;
	customDomain: string;
	accountId: string;
}

/**
 * 底层传输抽象。默认走真实 api-client；单测可通过 `_setShareTransport` 注入伪传输。
 * put/get 必选：接口中已声明为必选方法，与 fs-client 一致的可注入形态。
 */
export interface ShareTransport {
	post: (path: string, body?: unknown, timeoutMs?: number) => Promise<unknown>;
	put: (path: string, body?: unknown) => Promise<unknown>;
	get: (path: string) => Promise<unknown>;
}

const defaultTransport: ShareTransport = {
	post: (path, body, timeoutMs) => api.post(path, body, timeoutMs),
	put: (path, body) => api.put(path, body),
	get: (path) => api.get(path),
};
let transport: ShareTransport = defaultTransport;

/** 测试注入传输层；传 null 恢复默认（真实 api-client）。 */
export function _setShareTransport(t: ShareTransport | null): void {
	transport = t ?? defaultTransport;
}

/** 上传产物生成分享链接。未配置 token 时 kernel 返回 400（ApiError）。
 *  name 为分享名（缺省 kernel 自动生成）；重复时 kernel 返回 409。
 *  上传含 COS 传输 + 部署轮询（最坏 40×5s），多文件/大文件远超默认 30s 超时，
 *  故用 10 分钟长超时（多选分享 signal timed out 回归）。 */
export async function shareUpload(
	paths: string[],
	sessionId?: string,
	name?: string,
): Promise<ShareUploadResult> {
	return (await transport.post(
		"/api/share/upload",
		{
			paths,
			sessionId,
			name,
		},
		600_000,
	)) as ShareUploadResult;
}

/** 按一组文件路径查询历史分享名（未分享过返回 { name: null }）。 */
export async function shareNameForPaths(
	paths: string[],
): Promise<{ name: string | null }> {
	return (await transport.post("/api/share/name-for-paths", { paths })) as {
		name: string | null;
	};
}

/** 读取分享设置（是否已配置 token + 渠道）。token 不明文下发，只有 hasToken 布尔。 */
export async function shareSettings(): Promise<ShareSettingsInfo> {
	const res = (await transport.get("/api/settings/share")) as {
		share?: Partial<ShareSettingsInfo>;
	};
	return {
		hasToken: res.share?.hasToken === true,
		channel: res.share?.channel ?? "",
		customDomain: res.share?.customDomain ?? "",
		accountId: res.share?.accountId ?? "",
	};
}

/** 保存分享设置（token 明文仅 PUT 上行，回包不落盘读取）。 */
export async function saveShareSettings(
	share: ShareSettingsInput,
): Promise<void> {
	await transport.put("/api/settings/share", { share });
}

/** 分享条目（GET /api/share/list 的 items 元素） */
export interface ShareItemInfo {
	id: string;
	name: string;
	files: string[];
	size: number;
	createdAt: number;
}

/** 分享列表结果 */
export interface ShareListResult {
	items: ShareItemInfo[];
	/** 未部署变更数（本地 state 与上次部署快照的差集） */
	pending: number;
	totalSize: number;
	totalLimit: number;
	/** 分享工作区目录（「打开分享文件夹」入口用） */
	workspaceDir: string;
}

/** 读取分享列表（kernel 读时自动对账：目录丢失的记录被剔除） */
export async function shareList(): Promise<ShareListResult> {
	return (await transport.get("/api/share/list")) as ShareListResult;
}

/** 重命名分享（分享名 = 文件夹名/URL 子路径）。重复时 kernel 返回 409。 */
export async function shareRename(
	id: string,
	name: string,
): Promise<ShareItemInfo> {
	const res = (await transport.post("/api/share/rename", { id, name })) as {
		item: ShareItemInfo;
	};
	return res.item;
}

/** 删除单条分享（仅本地；线上待「立即部署」生效） */
export async function shareDelete(id: string): Promise<void> {
	await transport.post("/api/share/delete", { id });
}

/** 清空全部分享（仅本地） */
export async function shareClear(): Promise<void> {
	await transport.post("/api/share/clear");
}

/** 立即部署：把当前本地状态全量发布到线上。含 COS 传输 + 部署轮询，用 10 分钟长超时 */
export async function shareDeploy(): Promise<void> {
	await transport.post("/api/share/deploy", undefined, 600_000);
}

/** 重新生成某条分享的 3h 时效链接 */
export async function shareRefreshLink(
	id: string,
): Promise<{ url: string; expiresAt: number }> {
	return (await transport.post("/api/share/refresh-link", { id })) as {
		url: string;
		expiresAt: number;
	};
}

/** 打开分享文件夹（浏览器/dev 端无 Electron 能力时由 kernel 调系统打开器） */
export async function shareOpenFolder(): Promise<void> {
	await transport.post("/api/share/open-folder");
}
