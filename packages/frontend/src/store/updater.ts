import { create } from "zustand";

// vite 构建时从 package.json 注入；浏览器 dev（未走 vite define）为 undefined，兜底 "—"。
const BUILD_VERSION = (import.meta.env.WA_PI_VERSION as string | undefined) ?? "—";

export type UpdaterStatus =
	| "idle" | "checking" | "up-to-date"
	| "available" | "downloading" | "downloaded"
	| "error";

interface WaPiUpdaterApi {
	getInfo(): Promise<{ appVersion: string; isDesktop: boolean }>;
	check(): Promise<unknown>;
	download(): Promise<unknown>;
	quitAndInstall(): Promise<unknown>;
	onEvent(cb: (payload: Record<string, unknown>) => void): () => void;
}

declare global {
	interface Window {
		waPiUpdater?: WaPiUpdaterApi;
	}
}

interface UpdaterState {
	status: UpdaterStatus;
	// 是否由用户主动触发（点「检查更新」按钮）。自动检查（打开设置）为 false，
	// 其「已是最新」结果静默不展示，避免无谓的 ✓ 提示打扰。
	userTriggered: boolean;
	appVersion: string;
	latestVersion: string | null;
	releaseNotes: string | null;
	progress: number;
	transferred: number;
	total: number;
	error: string | null;
	isDesktop: boolean;
	checkForUpdates: (userTriggered?: boolean) => Promise<void>;
	downloadUpdate: () => Promise<void>;
	quitAndInstall: () => Promise<void>;
}

const initialState = {
	status: "idle" as UpdaterStatus,
	userTriggered: false,
	// 桌面版会被 initUpdater 的 getInfo 覆盖为 app.getVersion()；
	// 浏览器版无 waPiUpdater，靠构建时注入的版本号兜底显示。
	appVersion: BUILD_VERSION,
	latestVersion: null,
	releaseNotes: null,
	progress: 0,
	transferred: 0,
	total: 0,
	error: null,
	isDesktop: false,
};

function applyEvent(state: UpdaterState, payload: Record<string, unknown>): Partial<UpdaterState> {
	const phase = payload.phase as UpdaterStatus;
	switch (phase) {
		case "checking":
			return { status: "checking", error: null };
		case "available":
			return {
				status: "available",
				latestVersion: (payload.version as string) ?? null,
				releaseNotes: (payload.releaseNotes as string) ?? null,
				error: null,
			};
		case "up-to-date":
			// 自动检查（非用户触发）的「已是最新」静默回退 idle，不展示 ✓ 提示
			return state.userTriggered ? { status: "up-to-date", error: null } : { status: "idle", error: null };
		case "downloading":
			return {
				status: "downloading",
				progress: (payload.progress as number) ?? 0,
				transferred: (payload.transferred as number) ?? 0,
				total: (payload.total as number) ?? 0,
				error: null,
			};
		case "downloaded":
			return { status: "downloaded", error: null };
		case "error":
			return { status: "error", error: (payload.message as string) ?? "更新失败" };
		default:
			return {};
	}
}

/**
 * 应用更新 store：桥接 desktop 侧 window.waPiUpdater IPC。
 * - status 为有限状态机：idle → checking → available|up-to-date → downloading → downloaded|error
 * - checkForUpdates/downloadUpdate/quitAndInstall 调 IPC；事件流经 onEvent → applyEvent 更新状态
 * - initUpdater 在 App 挂载时调用：拉取版本信息 + 订阅事件；浏览器 dev 下无 waPiUpdater 直接返回
 */
export const useUpdaterStore = create<UpdaterState>((set) => ({
	...initialState,

	checkForUpdates: async (userTriggered = false) => {
		const api = window.waPiUpdater;
		if (!api) return;
		set({ status: "checking", error: null, userTriggered });
		try {
			await api.check();
		} catch (e) {
			set({ status: "error", error: (e as Error).message ?? "检查失败" });
		}
	},

	downloadUpdate: async () => {
		const api = window.waPiUpdater;
		if (!api) return;
		try {
			await api.download();
		} catch (e) {
			set({ status: "error", error: (e as Error).message ?? "下载失败" });
		}
	},

	quitAndInstall: async () => {
		const api = window.waPiUpdater;
		if (!api) return;
		await api.quitAndInstall();
	},
}));

/** 初始化：拉取版本信息 + 订阅 updater:event */
export function initUpdater() {
	const api = window.waPiUpdater;
	if (!api) {
		// 浏览器版：明确标记非桌面（隐藏自动更新控件），版本号已由 initialState 提供。
		useUpdaterStore.setState({ isDesktop: false });
		return;
	}
	void api.getInfo().then((info) => {
		useUpdaterStore.setState({ appVersion: info.appVersion, isDesktop: info.isDesktop });
	});
	api.onEvent((payload) => {
		useUpdaterStore.setState((s) => applyEvent(s, payload));
	});
}
