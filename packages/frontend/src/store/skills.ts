import { create } from "zustand";
import type { SkillInfo, SkillListResult, SkillChangedEvent } from "@wa-pi/shared";
import { api } from "../api-client";

// 技能管理 store — 通过 REST 与 kernel 通信
interface SkillsState {
  skills: SkillInfo[];           // 已启用的技能
  allSkills: SkillInfo[];        // 全部技能（含禁用）
  dirs: string[];                // 技能目录列表（含内置）
  disabledSkills: string[];      // 被禁用的技能名
  builtinDir: string;            // 内置目录路径
  loading: boolean;
  load: () => void;
  setAll: (data: SkillListResult | SkillChangedEvent) => void;
  toggleSkill: (skillName: string) => void;   // 自动判断当前状态切换
  addDir: (path: string) => void;
  removeDir: (path: string) => void;
}

export const useSkillsStore = create<SkillsState>((set, get) => ({
  skills: [],
  allSkills: [],
  dirs: [],
  disabledSkills: [],
  builtinDir: "",
  loading: false,
  load: () => {
    api.get("/api/skills").then((data: any) => {
      if (data) set({ skills: data.skills, allSkills: data.allSkills, dirs: data.dirs, disabledSkills: data.disabledSkills, builtinDir: data.builtinDir, loading: false });
    }).catch(() => set({ loading: false }));
  },
  setAll: (data) =>
    set({
      skills: data.skills,
      allSkills: data.allSkills,
      dirs: data.dirs,
      disabledSkills: data.disabledSkills,
      builtinDir: data.builtinDir,
      loading: false,
    }),
  toggleSkill: (skillName) => {
    // 乐观更新：立即切换本地 disabledSkills，SSE 事件回来后 setAll 会覆盖矫正
    const isDisabled = get().disabledSkills.includes(skillName);
    set(s => ({
      disabledSkills: isDisabled
        ? s.disabledSkills.filter(n => n !== skillName)
        : [...s.disabledSkills, skillName],
    }));
    api.post("/api/skills/toggle", { name: skillName, enabled: !isDisabled }).catch((err) => {
      // 请求失败时回退乐观更新
      console.error("[skills] toggle 请求失败，回退:", err);
      const curDisabled = get().disabledSkills.includes(skillName);
      set(s => ({
        disabledSkills: curDisabled
          ? s.disabledSkills.filter(n => n !== skillName)
          : [...s.disabledSkills, skillName],
      }));
    });
  },
  addDir: (path) => {
    void api.post("/api/skills/dirs", { path });
  },
  removeDir: (path) => {
    void api.del("/api/skills/dirs", { path });
  },
}));
