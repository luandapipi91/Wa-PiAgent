import { test, expect, mock } from "bun:test";

// 每个测试独立 mock ws-instance，避免状态泄漏
test("load 发 skill:list", async () => {
  const sendMock = mock();
  mock.module("../src/ws-instance", () => ({
    send: sendMock,
    onMessage: () => () => {},
  }));
  const { useSkillsStore } = await import("../src/store/skills");
  useSkillsStore.setState({
    skills: [], allSkills: [], dirs: [], disabledSkills: [],
    builtinDir: "", loading: false,
  });
  useSkillsStore.getState().load();
  expect(sendMock).toHaveBeenCalledWith({ type: "skill:list" });
});

test("toggleSkill 禁用技能", async () => {
  const sendMock = mock();
  mock.module("../src/ws-instance", () => ({
    send: sendMock,
    onMessage: () => () => {},
  }));
  const { useSkillsStore } = await import("../src/store/skills");
  useSkillsStore.setState({
    skills: [], allSkills: [], dirs: [], disabledSkills: [],
    builtinDir: "", loading: false,
  });
  useSkillsStore.getState().toggleSkill("brave-search");
  expect(sendMock).toHaveBeenCalledWith({
    type: "skill:toggle",
    skillName: "brave-search",
    disabled: true,
  });
});

test("toggleSkill 启用已禁用的技能", async () => {
  const sendMock = mock();
  mock.module("../src/ws-instance", () => ({
    send: sendMock,
    onMessage: () => () => {},
  }));
  const { useSkillsStore } = await import("../src/store/skills");
  useSkillsStore.setState({
    skills: [], allSkills: [], dirs: [],
    disabledSkills: ["pdf-tools"],
    builtinDir: "", loading: false,
  });
  useSkillsStore.getState().toggleSkill("pdf-tools");
  expect(sendMock).toHaveBeenCalledWith({
    type: "skill:toggle",
    skillName: "pdf-tools",
    disabled: false,
  });
});

test("addDir 发 skillDir:add", async () => {
  const sendMock = mock();
  mock.module("../src/ws-instance", () => ({
    send: sendMock,
    onMessage: () => () => {},
  }));
  const { useSkillsStore } = await import("../src/store/skills");
  useSkillsStore.setState({
    skills: [], allSkills: [], dirs: [], disabledSkills: [],
    builtinDir: "", loading: false,
  });
  useSkillsStore.getState().addDir("/path/to/skills");
  expect(sendMock).toHaveBeenCalledWith({
    type: "skillDir:add",
    path: "/path/to/skills",
  });
});

test("removeDir 发 skillDir:remove", async () => {
  const sendMock = mock();
  mock.module("../src/ws-instance", () => ({
    send: sendMock,
    onMessage: () => () => {},
  }));
  const { useSkillsStore } = await import("../src/store/skills");
  useSkillsStore.setState({
    skills: [], allSkills: [], dirs: [], disabledSkills: [],
    builtinDir: "", loading: false,
  });
  useSkillsStore.getState().removeDir("/path/to/skills");
  expect(sendMock).toHaveBeenCalledWith({
    type: "skillDir:remove",
    path: "/path/to/skills",
  });
});

test("setAll 更新本地状态", async () => {
  const sendMock = mock();
  mock.module("../src/ws-instance", () => ({
    send: sendMock,
    onMessage: () => () => {},
  }));
  const { useSkillsStore } = await import("../src/store/skills");
  useSkillsStore.setState({
    skills: [], allSkills: [], dirs: [], disabledSkills: [],
    builtinDir: "", loading: false,
  });
  useSkillsStore.getState().setAll({
    type: "skill:list",
    skills: [{ name: "a", description: "desc" }],
    allSkills: [{ name: "a", description: "desc" }],
    dirs: ["/builtin", "/user"],
    disabledSkills: [],
    builtinDir: "/builtin",
  });
  expect(useSkillsStore.getState().skills).toHaveLength(1);
  expect(useSkillsStore.getState().builtinDir).toBe("/builtin");
});
