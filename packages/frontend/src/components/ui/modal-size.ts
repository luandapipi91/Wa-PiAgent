/** 预览弹窗尺寸（px） */
export interface ModalSize {
	width: number;
	height: number;
}

/** 尺寸下限：保证内容可读（与 Modal 拖拽手柄一致） */
export const MIN_MODAL_W = 320;
export const MIN_MODAL_H = 240;

/** 各预览窗尺寸持久化键；文件预览窗沿用既有键名，兼容老记录 */
export const MODAL_SIZE_KEYS = {
	filePreview: "hiagent.filePreview.size",
	mediaPreview: "hiagent.mediaPreview.size",
} as const;

/** 尺寸 clamp：不小于最小值、不大于视口（窗口变小后重开不会溢出） */
export function clampModalSize(width: number, height: number): ModalSize {
	const fix = (v: number, min: number, max: number) =>
		Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : min;
	return {
		width: fix(width, MIN_MODAL_W, window.innerWidth),
		height: fix(height, MIN_MODAL_H, window.innerHeight),
	};
}

/** 读上次记录尺寸（已按当前视口夹过）；无记录/坏数据/形状非法返回 null（调用方回落到默认尺寸） */
export function readSavedSize(key: string): ModalSize | null {
	try {
		const v = JSON.parse(localStorage.getItem(key) ?? "");
		if (
			v &&
			[v.width, v.height].every(
				(n) => typeof n === "number" && Number.isFinite(n),
			)
		) {
			return clampModalSize(v.width, v.height);
		}
	} catch {
		// 坏数据回落默认
	}
	return null;
}

export function saveModalSize(key: string, size: ModalSize): void {
	try {
		localStorage.setItem(
			key,
			JSON.stringify(clampModalSize(size.width, size.height)),
		);
	} catch {
		// localStorage 不可用（隐私模式等）时静默降级：本次会话内仍可拖动
	}
}
