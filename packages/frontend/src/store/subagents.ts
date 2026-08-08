import { create } from "zustand";
import type { SubagentInfo, SubagentOverride } from "@wa-pi/shared";
import { api } from "../api-client";
import { onMessage } from "../events";

interface State {
	subagents: SubagentInfo[];
	load: () => void;
	saveOverride: (override: SubagentOverride) => void;
	getByName: (name: string) => SubagentInfo | undefined;
}

/**
 * 内置 subagent 信息 store。
 * - load：GET /api/subagents，kernel 回包后填充 subagents
 * - saveOverride：PUT /api/subagents/override，kernel 持久化后广播 subagent:list 自动刷新
 *
 * App.tsx 启动时调 load；SSE 事件已在 store 顶部 onMessage 里自动监听。
 */
export const useSubagentsStore = create<State>((set, get) => ({
	subagents: [],
	load: () => {
		api
			.get("/api/subagents")
			.then((data: any) => {
				if (data) set({ subagents: data.subagents ?? [] });
			})
			.catch(() => {});
	},
	saveOverride: (override) => {
		api
			.put("/api/subagents/override", { override })
			.then((data: any) => {
				// kernel 返回的 subagent:list 响应体在此处理（响应先于 SSE 广播到达时兜底刷新 store）
				if (data?.type === "subagent:list") handleSubagentEvent(data);
			})
			.catch(() => {});
	},
	getByName: (name) => get().subagents.find((s) => s.name === name),
}));

// 全局监听 subagent:list 广播，自动更新 store。
// 处理逻辑抽成导出的 handleSubagentEvent，便于单测直接断言（绕过 events mock，
// 避免 bun mock.module 在多文件场景下跨文件失效导致的测试隔离问题）。
export function handleSubagentEvent(e: unknown): void {
	if ((e as { type?: string })?.type === "subagent:list") {
		useSubagentsStore.setState({
			subagents: (e as { subagents: SubagentInfo[] }).subagents,
		});
	}
}

onMessage(handleSubagentEvent);
