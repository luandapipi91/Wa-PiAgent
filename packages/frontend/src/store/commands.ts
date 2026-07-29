import { create } from "zustand";
import type { CommandInfo } from "@wa-pi/shared";
import { api } from "../api-client";

// slash 命令 store — 从 pi 运行时拉取当前会话可用的命令（插件贡献 / prompt 模板）
// 注意：skill 类命令在此过滤掉（技能走 $ 菜单，避免与 / 菜单重复展示）
interface CommandsState {
  commands: CommandInfo[];        // 已过滤掉 source==="skill" 的命令
  loading: boolean;
  load: (sessionId: string, projectId?: string, agentName?: string) => void;
}

export const useCommandsStore = create<CommandsState>((set) => ({
  commands: [],
  loading: false,
  load: (sessionId, projectId?, agentName?) => {
    set({ loading: true });
    const params = new URLSearchParams();
    if (projectId) params.set("projectId", projectId);
    if (agentName) params.set("agentName", agentName);
    const qs = params.toString();
    const url = `/api/sessions/${encodeURIComponent(sessionId)}/commands${qs ? `?${qs}` : ""}`;
    api.get(url)
      .then((data: any) => {
        const all: CommandInfo[] = data?.commands ?? [];
        // 过滤 skill 类：技能已在 $ 菜单覆盖，/ 菜单不重复展示
        set({ commands: all.filter(c => c.source !== "skill"), loading: false });
      })
      .catch(() => set({ loading: false }));
  },
}));
