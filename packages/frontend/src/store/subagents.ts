import { create } from "zustand";
import type { SubagentInfo, SubagentOverride } from "@wa-pi/shared";
import { api } from "../api-client";
import { onMessage } from "../events";

interface State {
	subagents: SubagentInfo[];
	load: () => void;
	saveOverride: (override: SubagentOverride) => Promise<void>;
	getByName: (name: string) => SubagentInfo | undefined;
}

/**
 * 内置 subagent 信息 store。
 * - load：GET /api/subagents，kernel 回包后填充 subagents
 * - saveOverride：PUT /api/subagents/override，kernel 持久化后广播 subagent:list 自动刷新
 *   （失败会向调用方抛错，由调用方提示用户）
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
	// 保存失败必须向调用方抛错（不再 .catch 吞掉）：调用方据此保持弹窗 + toast 报错，
	// 否则用户的绑定改动会静默丢失（S12）
	saveOverride: async (override) => {
		const data: any = await api.put("/api/subagents/override", { override });
		// kernel 返回的 subagent:list 响应体在此处理（响应先于 SSE 广播到达时兜底刷新 store）
		if (data?.type === "subagent:list") handleSubagentEvent(data);
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
