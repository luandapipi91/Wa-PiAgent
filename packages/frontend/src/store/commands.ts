import { create } from "zustand";
import type { CommandInfo } from "@wa-pi/shared";
import { api } from "../api-client";

// slash 命令 store — 从 pi 运行时拉取当前会话可用的命令（插件贡献 / prompt 模板）
// 注意：skill 类命令在 commands 中过滤掉（技能走 $ 菜单，避免与 / 菜单重复展示）
interface CommandsState {
  commands: CommandInfo[];        // 已过滤：skill 移除、extension 仅保留已开启（/ 菜单展示用）
  allCommands: CommandInfo[];     // 未过滤全量（含已关闭开关的扩展命令；发送时判定「是否会被 pi 拦截执行」用）
  loading: boolean;
  load: (sessionId: string, projectId?: string, agentName?: string) => void;
}

export const useCommandsStore = create<CommandsState>((set) => ({
  commands: [],
  allCommands: [],
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
        // __! 前缀：wa-pi 内部专用命令（如 __!wa_pi_reload 热重载），不进命令面板、
        // 不进 allCommands（用户不会手打，仅 kernel 程序化触发）。
        const all: CommandInfo[] = (data?.commands ?? []).filter(
          (c) => !c.name.startsWith("__!"),
        );
        set({
          // / 菜单过滤：skill 走 $ 菜单不展示；extension 插件命令只显示已开启（enabled === true）
          commands: all.filter((c) => {
            if (c.source === "skill") return false;                    // 技能走 $ 菜单
            if (c.source === "extension") return c.enabled === true;   // 插件命令只显示已开启
            return true;                                                // prompt/builtin 不受影响
          }),
          allCommands: all,
          loading: false,
        });
      })
      .catch(() => set({ loading: false }));
  },
}));
