import { create } from "zustand";
import type {
  SkillInfo,
  SkillSource,
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
 * - project：只保留该项目自己的技能（内置 / 插件 / 他项目技能都不列出）
 */
export function filterSkillsByScope(
  skills: SkillInfo[],
  scope: SkillScope,
  projectId?: string | null,
): SkillInfo[] {
  if (scope === "all") return skills.filter((s) => !s.shadowed);
  if (scope === "global") return skills.filter((s) => s.source?.type !== "project");
  return skills.filter(
    (s) => s.source?.type === "project" && s.source.projectId === projectId,
  );
}

/**
 * 具名派生选择器：某个项目下实际可用的技能集合。
 * 供 ComposerInput（$ 快捷菜单）/ CommandPalette / AgentConfig（技能白名单）共用，
 * 保证候选与「该会话 spawn 时真正传给 pi 的技能」一致：
 * - 排除被遮蔽（shadowed）的同名条目——同名以生效的那条呈现（项目版本优先）
 * - 排除其它项目的 project 来源技能（会话 spawn 只传本项目目录 + 内置 + 扩展）
 * - 保留 builtin / extension 来源
 * 本项目技能即便因它项目同名被标记 shadowed 也保留（本项目目录在 pi 侧排最前，本项目版本仍生效）。
 */
export function selectAvailableSkillsForProject(
  allSkills: SkillInfo[],
  projectId?: string | null,
): SkillInfo[] {
  const mine = allSkills.filter(
    (s) => s.source?.type === "project" && s.source.projectId === projectId,
  );
  const mineNames = new Set(mine.map((s) => s.name));
  return [
    ...mine,
    ...allSkills.filter(
      (s) =>
        s.source?.type !== "project" && !s.shadowed && !mineNames.has(s.name),
    ),
  ];
}

/**
 * 列表 key / 面板项 id 的去重后缀：同名技能可能来自不同来源（项目同名遮蔽内置），
 * 只按技能名做 React key 会重复，须带来源维度。
 */
export function skillKeyOf(source: SkillSource | undefined, name: string): string {
  return `${source?.type ?? "builtin"}-${name}`;
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
    // REST 的 enabled 是「期望的新状态」，路由会取反成 WS 的 disabled
    // （当前已禁用 → 期望启用 true；当前已启用 → 期望禁用 false）
    const nextEnabled = isDisabled;
    set((s) => ({
      disabledSkills: isDisabled
        ? s.disabledSkills.filter((n) => n !== skillName)
        : [...s.disabledSkills, skillName],
    }));
    api
      .post("/api/skills/toggle", { name: skillName, enabled: nextEnabled })
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
