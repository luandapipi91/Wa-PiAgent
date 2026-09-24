import { create } from "zustand";
import type {
  SkillInfo,
  SkillDir,
  SkillListResult,
  SkillChangedEvent,
} from "@wa-pi/shared";
import { api } from "../api-client";

/** 技能页范围筛选：全部 / 仅全局技能 / 指定项目 */
export type SkillScope = "all" | "global" | "project";

/**
 * 按范围过滤技能。
 * - all：隐藏被遮蔽的同名条目（同名以项目版本呈现）
 * - global：内置与扩展来源，被遮蔽者也保留（可在该范围单独开关）
 * - project：该项目技能 + 全局技能，同名时项目那条生效
 */
export function filterSkillsByScope(
  skills: SkillInfo[],
  scope: SkillScope,
  projectId?: string | null,
): SkillInfo[] {
  if (scope === "all") return skills.filter((s) => !s.shadowed);
  if (scope === "global") return skills.filter((s) => s.source?.type !== "project");
  const mine = skills.filter(
    (s) => s.source?.type === "project" && s.source.projectId === projectId,
  );
  const mineNames = new Set(mine.map((s) => s.name));
  return [
    ...mine,
    ...skills.filter(
      (s) => s.source?.type !== "project" && !mineNames.has(s.name),
    ),
  ];
}

// 技能管理 store — 通过 REST 与 kernel 通信
interface SkillsState {
  skills: SkillInfo[]; // 已启用的技能
  allSkills: SkillInfo[]; // 全部技能（含 shadowed 与被禁用）
  dirs: SkillDir[]; // 技能目录清单（项目 → 内置 → 扩展）
  disabledSkills: string[]; // 被禁用的技能名
  builtinDir: string; // 内置目录路径
  loading: boolean;
  skillScope: SkillScope; // 范围筛选（默认全部）
  selectedProjectId: string | null; // scope === "project" 时的目标项目
  load: () => void;
  setAll: (data: SkillListResult | SkillChangedEvent) => void;
  toggleSkill: (skillName: string) => void;
  setSkillScope: (scope: SkillScope, projectId?: string) => void;
}

export const useSkillsStore = create<SkillsState>((set, get) => ({
  skills: [],
  allSkills: [],
  dirs: [],
  disabledSkills: [],
  builtinDir: "",
  loading: false,
  skillScope: "all",
  selectedProjectId: null,
  load: () => {
    api
      .get("/api/skills")
      .then((data: any) => {
        if (data)
          set({
            skills: data.skills,
            allSkills: data.allSkills,
            dirs: data.dirs,
            disabledSkills: data.disabledSkills,
            builtinDir: data.builtinDir,
            loading: false,
          });
      })
      .catch(() => set({ loading: false }));
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
  setSkillScope: (scope, projectId) =>
    set({ skillScope: scope, selectedProjectId: projectId ?? null }),
  toggleSkill: (skillName) => {
    // 乐观更新：立即切换本地 disabledSkills，SSE 事件回来后 setAll 覆盖矫正
    const isDisabled = get().disabledSkills.includes(skillName);
    set((s) => ({
      disabledSkills: isDisabled
        ? s.disabledSkills.filter((n) => n !== skillName)
        : [...s.disabledSkills, skillName],
    }));
    api
      .post("/api/skills/toggle", { name: skillName, enabled: !isDisabled })
      .catch((err) => {
        // 请求失败时回退乐观更新
        console.error("[skills] toggle 请求失败，回退:", err);
        const curDisabled = get().disabledSkills.includes(skillName);
        set((s) => ({
          disabledSkills: curDisabled
            ? s.disabledSkills.filter((n) => n !== skillName)
            : [...s.disabledSkills, skillName],
        }));
      });
  },
}));
