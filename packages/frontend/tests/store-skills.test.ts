import { test, expect, mock } from "bun:test";
import { filterSkillsByScope } from "../src/store/skills";

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

test("filterSkillsByScope：项目范围 = 该项目技能 + 全局技能，同名时项目那条生效", () => {
  const all = [
    { name: "dup", description: "全局版", path: "/b/dup", source: { type: "builtin" as const } },
    { name: "dup", description: "项目版", path: "/p/dup", source: { type: "project" as const, projectId: "p1" } },
    { name: "other", description: "", path: "/o", source: { type: "project" as const, projectId: "p2" } },
  ];
  const out = filterSkillsByScope(all, "project", "p1");
  expect(out.map((s) => `${s.name}:${s.description}`)).toEqual(["dup:项目版"]);
  expect(out.some((s) => s.source?.projectId === "p2")).toBe(false);
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
