import { test, expect, mock } from "bun:test";
import { SYSTEM_PROJECT_ID } from "@wa-pi/shared";
import type { SkillInfo } from "@wa-pi/shared";
import {
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

// ---- 选中项目（技能页筛选维度）----

test("默认选中为默认工作区（没有当前会话时的回退）", async () => {
  // 用独立模块实例断言 store 初值：同进程其它用例的 setState 会污染共享的 store 单例。
  // specifier 运行时拼接（bun 支持 query 破模块缓存），同时避开 TS 对字面量模块的解析。
  const spec = "../src/store/skills";
  const fresh = (await import(`${spec}?fresh-default`)) as typeof import("../src/store/skills");
  expect(fresh.useSkillsStore.getState().selectedProjectId).toBe(
    SYSTEM_PROJECT_ID,
  );
});

test("setSelectedProject 只改本地状态，不发请求", async () => {
  const { getMock, postMock } = mockApi();
  const { useSkillsStore } = await import("../src/store/skills");
  useSkillsStore.setState({ selectedProjectId: SYSTEM_PROJECT_ID });

  useSkillsStore.getState().setSelectedProject("p1");

  expect(useSkillsStore.getState().selectedProjectId).toBe("p1");
  expect(getMock).not.toHaveBeenCalled();
  expect(postMock).not.toHaveBeenCalled();
});

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

test("selectAvailableSkillsForProject：该项目没有自己的技能时仍返回内置与扩展", () => {
  const out = selectAvailableSkillsForProject(
    [
      skill("g", { type: "builtin" }),
      skill("e", { type: "extension", name: "pack" }),
      skill("other", { type: "project", projectId: "p2", projectName: "项目B" }),
    ],
    "p1",
  ).map((s) => s.name);
  expect(out).toEqual(["g", "e"]);
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


