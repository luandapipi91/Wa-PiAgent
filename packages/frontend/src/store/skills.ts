import { create } from "zustand";
import type { SkillInfo, SkillListResult, SkillChangedEvent } from "@hiagent/shared";
import { send } from "../ws-instance";

// 技能管理 store — 通过 WS 事件与 kernel 通信
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
  load: () => send({ type: "skill:list" }),
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
    // 当前已禁用 → 启用；当前启用 → 禁用
    const isDisabled = get().disabledSkills.includes(skillName);
    send({ type: "skill:toggle", skillName, disabled: !isDisabled });
  },
  addDir: (path) => send({ type: "skillDir:add", path }),
  removeDir: (path) => send({ type: "skillDir:remove", path }),
}));
