// share/spaces.ts — 分享空间（CF 渠道多空间）纯逻辑：一个空间 = 一个独立 Cloudflare Pages 项目。
// 仅 cloudflare 渠道语义；edgeone 渠道不涉及空间。默认空间代码内置（不入 settings 列表）。
import { KernelError } from "../kernel-error";
import type { ShareSpace } from "../settings-store";
import type { ShareItem } from "./workspace";

/** 内置默认空间：id 固定 default、项目名固定 wapi-shares，不存 settings 列表。
 *  ShareItem.cfSpaceId 缺失或 "default" 均归属此空间（存量数据兼容，不做迁移）。 */
export const DEFAULT_SHARE_SPACE: ShareSpace = {
	id: "default",
	name: "默认空间",
	projectName: "wapi-shares",
	createdAt: 0,
};

/** CF Pages 项目名规则：小写字母/数字开头，仅小写字母/数字/连字符，≤58 字符（CF 官方上限） */
export const SHARE_SPACE_PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
export const SHARE_SPACE_PROJECT_NAME_MAX = 58;

/** 空间条目的 CF 渠道键：cfSpaceId 缺失（存量记录）或 "default" 都归默认空间 */
export function spaceKeyOf(cfSpaceId?: string): string {
	return cfSpaceId && cfSpaceId !== "default" ? cfSpaceId : "default";
}

/** 按 cfSpaceId 解析空间：默认/缺失/未知 id（空间已删）→ 默认空间兜底 */
export function resolveShareSpace(
	spaces: ShareSpace[],
	cfSpaceId?: string,
): ShareSpace {
	const key = spaceKeyOf(cfSpaceId);
	if (key === "default") return DEFAULT_SHARE_SPACE;
	return spaces.find((s) => s.id === key) ?? DEFAULT_SHARE_SPACE;
}

/** 生成空间 id：8 位短随机 hex（空间数量极小 ≤100，碰撞概率可忽略） */
function newSpaceId(): string {
	return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

/** 校验并构造新空间：显示名必填、项目名符合 CF 规则、与已有空间及内置默认空间
 *  不重名、不重项目名。通过返回待入库空间，不通过抛 KernelError（code 供前端字典渲染）。 */
export function buildNewSpace(
	name: string,
	projectName: string,
	existing: ShareSpace[],
): ShareSpace {
	const trimmedName = name.trim();
	const trimmedProject = projectName.trim();
	if (!trimmedName) throw new KernelError("share.spaceNameRequired");
	if (
		!trimmedProject ||
		trimmedProject.length > SHARE_SPACE_PROJECT_NAME_MAX ||
		!SHARE_SPACE_PROJECT_NAME_RE.test(trimmedProject)
	)
		throw new KernelError("share.spaceInvalidProjectName");
	if (
		trimmedName === DEFAULT_SHARE_SPACE.name ||
		existing.some((s) => s.name === trimmedName)
	)
		throw new KernelError("share.spaceNameConflict");
	if (
		trimmedProject === DEFAULT_SHARE_SPACE.projectName ||
		existing.some((s) => s.projectName === trimmedProject)
	)
		throw new KernelError("share.spaceProjectConflict");
	return {
		id: newSpaceId(),
		name: trimmedName,
		projectName: trimmedProject,
		createdAt: Date.now(),
	};
}

/** 删除空间校验：默认空间不可删；空间不存在报错；空间下还有分享（含缺失 cfSpaceId
 *  归默认空间的存量）拒绝删除——提示先清空，只删本地映射、不动云端项目。 */
export function assertSpaceDeletable(
	id: string,
	spaces: ShareSpace[],
	items: ShareItem[],
): void {
	if (id === "default") throw new KernelError("share.spaceDefaultImmutable");
	const space = spaces.find((s) => s.id === id);
	if (!space) throw new KernelError("share.spaceNotFound", { id });
	const count = items.filter((it) => spaceKeyOf(it.cfSpaceId) === id).length;
	if (count > 0) throw new KernelError("share.spaceHasShares", { count });
}
