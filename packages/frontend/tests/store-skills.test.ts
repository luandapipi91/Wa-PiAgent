import { test, expect, mock } from "bun:test";

// 每个测试独立 mock api-client，避免真实发起 HTTP 请求
function mockApi() {
  const getMock = mock(() => Promise.resolve({}));
  const postMock = mock(() => Promise.resolve({}));
  const delMock = mock(() => Promise.resolve({}));
  mock.module("../src/api-client", () => ({
    api: { get: getMock, post: postMock, del: delMock },
  }));
  return { getMock, postMock, delMock };
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
  expect(postMock).toHaveBeenCalledWith("/api/skills/toggle", {
    name: "brave-search",
    enabled: true,
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
  expect(postMock).toHaveBeenCalledWith("/api/skills/toggle", {
    name: "pdf-tools",
    enabled: false,
  });
});

test("addDir 请求 /api/skills/dirs", async () => {
  const { postMock } = mockApi();
  const { useSkillsStore } = await import("../src/store/skills");
  useSkillsStore.setState({
    skills: [], allSkills: [], dirs: [], disabledSkills: [],
    builtinDir: "", loading: false,
  });
  useSkillsStore.getState().addDir("/path/to/skills");
  expect(postMock).toHaveBeenCalledWith("/api/skills/dirs", {
    path: "/path/to/skills",
  });
});

test("removeDir 请求 DELETE /api/skills/dirs", async () => {
  const { delMock } = mockApi();
  const { useSkillsStore } = await import("../src/store/skills");
  useSkillsStore.setState({
    skills: [], allSkills: [], dirs: [], disabledSkills: [],
    builtinDir: "", loading: false,
  });
  useSkillsStore.getState().removeDir("/path/to/skills");
  expect(delMock).toHaveBeenCalledWith("/api/skills/dirs", {
    path: "/path/to/skills",
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
    dirs: ["/builtin", "/user"],
    disabledSkills: [],
    builtinDir: "/builtin",
  });
  expect(useSkillsStore.getState().skills).toHaveLength(1);
  expect(useSkillsStore.getState().builtinDir).toBe("/builtin");
});
