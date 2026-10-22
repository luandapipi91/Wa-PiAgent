// 桌面宠物窗口桥（主窗口渲染进程侧）。
// 浏览器 dev / 未打包 Electron 下 window.waPiPet 不存在 → 全部入口静默降级（可选链）。
// 宠物窗口自己的宿主接口在 packages/desktop/src/pet-preload.cjs（window.guaguaHost）。

export interface WaPiPetPayload {
	type?: string;
}

export interface WaPiPetApi {
	/** 同步开关到主进程：true 建窗、false 销窗（幂等） */
	setEnabled(enabled: boolean): void;
	/** 任务完成：让宠物做一次庆祝动作（宠物窗口不在时主进程忽略） */
	celebrate(): void;
	/** 宠物窗口事件；返回解绑函数 */
	onEvent(cb: (payload: WaPiPetPayload) => void): () => void;
}

declare global {
	interface Window {
		waPiPet?: WaPiPetApi;
	}
}

/** 开关同步：设置项变化与 localStorage 恢复后各调一次 */
export function setDesktopPetEnabled(enabled: boolean): void {
	window.waPiPet?.setEnabled(enabled);
}

/** 任务完成庆祝：由 session store 的 agent_end 终态触发 */
export function celebrateDesktopPet(): void {
	window.waPiPet?.celebrate();
}

/** 订阅宠物窗口事件（closed = 用户在宠物右键菜单里点了关闭） */
export function onDesktopPetEvent(
	cb: (payload: WaPiPetPayload) => void,
): () => void {
	if (!window.waPiPet) return () => {};
	return window.waPiPet.onEvent(cb);
}
