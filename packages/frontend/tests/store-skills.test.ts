import { test, expect, mock } from "bun:test";
import type { SkillInfo } from "@wa-pi/shared";
import {
  filterSkillsByScope,
  selectAvailableSkillsForProject,
  skillKeyOf,
} from "../src/store/skills";

// 每个测试独立 mock api-client，避免真实发起 HTTP 请求
function mockApi() {
  const getMock = mock(() => Promise.resolve({}));
  const postMock = mock(() => Promise.resolve({}));
  mock.module("../src/api-client", () => ({
    api: { get: getMock, post: postMock },
  }));
  return { getMock, postMock };
}

test("load 请求 /api/skills", async () => {
  const { getMock } = mockApi();
  const { useSkillsStore } = await import("../src/store/skills");
  useSkillsStore.setState({
    skills: [], allSkills: [], dirs: [], disabledSkills: [],
    builtinDir: "", loading: false,
  });
  useSkillsStore.getState().load();
  expect(getMock).toHaveBeenCalledWith("/api/skills");
});

test("toggleSkill 禁用技能", async () => {
  const { postMock } = mockApi();
  const { useSkillsStore } = await import("../src/store/skills");
  useSkillsStore.setState({
    skills: [], allSkills: [], dirs: [], disabledSkills: [],
    builtinDir: "", loading: false,
  });
  useSkillsStore.getState().toggleSkill("brave-search");
  // REST 的 enabled 是期望新状态：当前启用 → 期望禁用
  expect(postMock).toHaveBeenCalledWith("/api/skills/toggle", {
    name: "brave-search",
    enabled: false,
  });
});

test("toggleSkill 启用已禁用的技能", async () => {
  const { postMock } = mockApi();
  const { useSkillsStore } = await import("../src/store/skills");
  useSkillsStore.setState({
    skills: [], allSkills: [], dirs: [],
    disabledSkills: ["pdf-tools"],
    builtinDir: "", loading: false,
  });
  useSkillsStore.getState().toggleSkill("pdf-tools");
  // REST 的 enabled 是期望新状态：当前禁用 → 期望启用
  expect(postMock).toHaveBeenCalledWith("/api/skills/toggle", {
    name: "pdf-tools",
    enabled: true,
  });
});

/** 构造技能条目（默认内置来源） */
function skill(
  name: string,
  source?: SkillInfo["source"],
  shadowed?: boolean,
): SkillInfo {
  return {
    name,
    description: `${name} 描述`,
    path: `/skills/${name}`,
    source,
    shadowed,
  };
}

// ---- 具名派生选择器：某项目下实际可用的技能集合 ----

test("selectAvailableSkillsForProject：同名被遮蔽的条目被排除（项目版本生效）", () => {
  const out = selectAvailableSkillsForProject(
    [
      skill("dup", { type: "project", projectId: "p1", projectName: "项目A" }),
      skill("dup", { type: "builtin" }, true),
    ],
    "p1",
  );
  expect(out).toHaveLength(1);
  expect(out[0].source?.type).toBe("project");
});

test("selectAvailableSkillsForProject：他项目的技能被排除", () => {
  const out = selectAvailableSkillsForProject(
    [
      skill("mine", { type: "project", projectId: "p1", projectName: "项目A" }),
      skill("theirs", { type: "project", projectId: "p2", projectName: "项目B" }),
    ],
    "p1",
  ).map((s) => s.name);
  expect(out).toEqual(["mine"]);
});

test("selectAvailableSkillsForProject：内置与扩展技能保留", () => {
  const out = selectAvailableSkillsForProject(
    [skill("builtin-a", { type: "builtin" }), skill("ext-a", { type: "extension", name: "pack" })],
    "p1",
  ).map((s) => s.name);
  expect(out).toEqual(["builtin-a", "ext-a"]);
});

test("selectAvailableSkillsForProject：本项目技能即便被他项目同名遮蔽也保留（该项目内项目版本仍生效）", () => {
  const out = selectAvailableSkillsForProject(
    [
      skill("dup", { type: "project", projectId: "p2", projectName: "项目B" }),
      skill("dup", { type: "project", projectId: "p1", projectName: "项目A" }, true),
      skill("dup", { type: "builtin" }, true),
    ],
    "p1",
  );
  expect(out).toHaveLength(1);
  expect(out[0].source?.projectId).toBe("p1");
});

test("skillKeyOf：同名不同来源得到不同 key（消除重复 key）", () => {
  expect(skillKeyOf({ type: "builtin" }, "dup")).toBe("builtin-dup");
  expect(skillKeyOf({ type: "project", projectId: "p1" }, "dup")).toBe(
    "project-dup",
  );
  expect(skillKeyOf({ type: "extension", name: "pack" }, "dup")).toBe(
    "extension-dup",
  );
  expect(skillKeyOf(undefined, "dup")).toBe("builtin-dup");
});

test("setAll 更新本地状态", async () => {
  mockApi();
  const { useSkillsStore } = await import("../src/store/skills");
  useSkillsStore.setState({
    skills: [], allSkills: [], dirs: [], disabledSkills: [],
    builtinDir: "", loading: false,
  });
  useSkillsStore.getState().setAll({
    type: "skill:list",
    skills: [{ name: "a", description: "desc", path: "/skills/a" }],
    allSkills: [{ name: "a", description: "desc", path: "/skills/a" }],
    dirs: [
      { path: "/builtin", type: "builtin" },
      { path: "/ext/pack", type: "extension", name: "pack" },
    ],
    disabledSkills: [],
    builtinDir: "/builtin",
  });
  expect(useSkillsStore.getState().skills).toHaveLength(1);
  expect(useSkillsStore.getState().builtinDir).toBe("/builtin");
  expect(useSkillsStore.getState().dirs.map((d) => d.type)).toEqual([
    "builtin",
    "extension",
  ]);
});

test("setSkillScope 切换范围与目标项目", async () => {
  mockApi();
  const { useSkillsStore } = await import("../src/store/skills");
  useSkillsStore.setState({ skillScope: "all", selectedProjectId: null });

  useSkillsStore.getState().setSkillScope("project", "p1");
  expect(useSkillsStore.getState().skillScope).toBe("project");
  expect(useSkillsStore.getState().selectedProjectId).toBe("p1");

  // 不传 projectId 时清空目标项目（切回全局/全部范围）
  useSkillsStore.getState().setSkillScope("global");
  expect(useSkillsStore.getState().skillScope).toBe("global");
  expect(useSkillsStore.getState().selectedProjectId).toBeNull();
});

test("filterSkillsByScope：全局范围剔除项目技能", () => {
  const all = [
    { name: "g", description: "", path: "/b/g", source: { type: "builtin" as const } },
    { name: "p", description: "", path: "/p/p", source: { type: "project" as const, projectId: "p1" } },
  ];
  expect(filterSkillsByScope(all, "global").map((s) => s.name)).toEqual(["g"]);
});

test("filterSkillsByScope：项目范围只返回该项目技能（内置 / 插件 / 他项目技能都不出现）", () => {
  const all = [
    { name: "g", description: "内置版", path: "/b/g", source: { type: "builtin" as const } },
    { name: "e", description: "插件版", path: "/x/e", source: { type: "extension" as const, name: "pack" } },
    { name: "mine", description: "本项目版", path: "/p/mine", source: { type: "project" as const, projectId: "p1" } },
    { name: "other", description: "他项目版", path: "/o", source: { type: "project" as const, projectId: "p2" } },
  ];
  const out = filterSkillsByScope(all, "project", "p1");
  expect(out.map((s) => `${s.name}:${s.description}`)).toEqual(["mine:本项目版"]);
});

test("filterSkillsByScope：该项目没有技能时项目范围返回空列表", () => {
  const all = [
    { name: "g", description: "内置版", path: "/b/g", source: { type: "builtin" as const } },
    { name: "other", description: "他项目版", path: "/o", source: { type: "project" as const, projectId: "p2" } },
  ];
  expect(filterSkillsByScope(all, "project", "p1")).toEqual([]);
});

test("filterSkillsByScope：全部范围隐藏被遮蔽的同名条目，保留未遮蔽项", () => {
  const all = [
    { name: "dup", description: "项目版", path: "/p/dup", source: { type: "project" as const, projectId: "p1" } },
    { name: "dup", description: "内置版", path: "/b/dup", source: { type: "builtin" as const }, shadowed: true },
    { name: "keep", description: "", path: "/b/keep", source: { type: "builtin" as const } },
  ];
  expect(filterSkillsByScope(all, "all").map((s) => s.description)).toEqual(["项目版", ""]);
});

test("filterSkillsByScope：全局范围保留被遮蔽的内置条目（可按范围管理）", () => {
  const all = [
    { name: "dup", description: "内置版", path: "/b/dup", source: { type: "builtin" as const }, shadowed: true },
  ];
  expect(filterSkillsByScope(all, "global").map((s) => s.description)).toEqual(["内置版"]);
});
