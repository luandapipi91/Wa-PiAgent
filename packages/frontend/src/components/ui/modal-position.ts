/** 预览弹窗位置（视口坐标，px） */
export interface ModalPos {
	left: number;
	top: number;
}

/** 各预览窗位置持久化键（沿用既有 hiagent.* 命名） */
export const MODAL_POS_KEYS = {
	filePreview: "hiagent.filePreview.pos",
	mediaPreview: "hiagent.mediaPreview.pos",
} as const;

/** 位置 clamp：窗口整体留在视口内（卡片比视口大时贴左上角） */
export function clampModalPos(
	left: number,
	top: number,
	w: number,
	h: number,
): ModalPos {
	const fix = (v: number, max: number) =>
		Number.isFinite(v) ? Math.max(0, Math.min(max, v)) : 0;
	return {
		left: fix(left, window.innerWidth - w),
		top: fix(top, window.innerHeight - h),
	};
}

/** 读上次记录的位置；无记录/坏数据/形状非法返回 null（调用方回落到居中） */
export function readSavedPos(key: string): ModalPos | null {
	try {
		const v = JSON.parse(localStorage.getItem(key) ?? "");
		if (
			v &&
			[v.left, v.top].every(
				(n) => typeof n === "number" && Number.isFinite(n),
			)
		) {
			return { left: v.left, top: v.top };
		}
	} catch {
		// 坏数据回落默认
	}
	return null;
}

export function saveModalPos(key: string, pos: ModalPos): void {
	try {
		localStorage.setItem(key, JSON.stringify(pos));
	} catch {
		// localStorage 不可用（隐私模式等）时静默降级：本次会话内仍可拖动
	}
}
