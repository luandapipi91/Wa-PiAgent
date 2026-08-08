import { create } from "zustand";

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
	appVersion: string;
	latestVersion: string | null;
	releaseNotes: string | null;
	progress: number;
	transferred: number;
	total: number;
	error: string | null;
	isDesktop: boolean;
	checkForUpdates: () => Promise<void>;
	downloadUpdate: () => Promise<void>;
	quitAndInstall: () => Promise<void>;
}

const initialState = {
	status: "idle" as UpdaterStatus,
	appVersion: "",
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
			return { status: "up-to-date", error: null };
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
export const useUpdaterStore = create<UpdaterState>((set, get) => ({
	...initialState,

	checkForUpdates: async () => {
		const api = window.waPiUpdater;
		if (!api) return;
		set({ status: "checking", error: null });
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
	if (!api) return;
	void api.getInfo().then((info) => {
		useUpdaterStore.setState({ appVersion: info.appVersion, isDesktop: info.isDesktop });
	});
	api.onEvent((payload) => {
		useUpdaterStore.setState((s) => applyEvent(s, payload));
	});
}
