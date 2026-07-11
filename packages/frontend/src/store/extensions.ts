import { create } from "zustand";
import type {
  ExtensionPluginInfo,
  ExtensionListResult,
  ExtensionChangedEvent,
} from "@hiagent/shared";
import { send } from "../ws-instance";

// 插件管理 store — 通过 WS 事件与 kernel 通信
interface ExtensionsState {
  plugins: ExtensionPluginInfo[];
  load: () => void;
  setAll: (data: ExtensionListResult | ExtensionChangedEvent) => void;
  togglePlugin: (id: string, enabled: boolean) => void;   // true=启用，false=禁用
}

export const useExtensionsStore = create<ExtensionsState>((set) => ({
  plugins: [],
  load: () => send({ type: "extension:list" }),
  setAll: (data) => set({ plugins: data.plugins }),
  togglePlugin: (id, enabled) => send({ type: "extension:toggle", id, enabled }),
}));
