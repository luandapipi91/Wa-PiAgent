// share-progress.ts — 分享上传/部署进度全局状态
// kernel 经 SSE 广播 share:progress（packing → uploading → deploying → done/error），
// 这里转成 zustand 状态供 ShareResultModal / 设置页「我的分享」的进度条订阅。
import { create } from "zustand";
import { onEventType } from "../events";

export type SharePhase =
	| "idle"
	| "packing"
	| "uploading"
	| "deploying"
	| "done"
	| "error";

interface ShareProgressState {
	phase: SharePhase;
	/** 0-100，仅 uploading 阶段有真实值 */
	percent: number;
	error?: string;
}

export const useShareProgressStore = create<ShareProgressState>(() => ({
	phase: "idle",
	percent: 0,
}));

// 模块加载即订阅（onEventType 内部幂等建立 SSE 连接）
onEventType("share:progress", (e) => {
	const ev = e as { phase?: SharePhase; percent?: number; error?: string };
	if (!ev.phase) return;
	useShareProgressStore.setState({
		phase: ev.phase,
		percent:
			ev.phase === "done"
				? 100
				: (ev.percent ?? useShareProgressStore.getState().percent),
		error: ev.error,
	});
});
