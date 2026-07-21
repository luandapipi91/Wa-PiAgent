import { create } from "zustand";
import type { SubagentInfo, SubagentOverride } from "@hiagent/shared";
import { send, onMessage } from "../ws-instance";

interface State {
  subagents: SubagentInfo[];
  load: () => void;
  saveOverride: (override: SubagentOverride) => void;
  getByName: (name: string) => SubagentInfo | undefined;
}

/**
 * 内置 subagent 信息 store。
 * - load：发送 subagent:list，kernel 回包后填充 subagents
 * - saveOverride：发送 subagent:save-override，kernel 持久化后广播 subagent:list 自动刷新
 *
 * App.tsx 启动时调 load；WS 事件已在 store 顶部 onMessage 里自动监听。
 */
export const useSubagentsStore = create<State>((set, get) => ({
  subagents: [],
  load: () => {
    send({ type: "subagent:list" });
  },
  saveOverride: (override) => {
    send({ type: "subagent:save-override", override });
  },
  getByName: (name) => get().subagents.find(s => s.name === name),
}));

// 全局监听 subagent:list 广播，自动更新 store
onMessage((e: any) => {
  if (e.type === "subagent:list") {
    useSubagentsStore.setState({ subagents: e.subagents });
  }
});
