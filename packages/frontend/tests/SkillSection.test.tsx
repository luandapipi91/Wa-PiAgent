import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { SkillSection } from "../src/components/settings/SkillSection";
import { useSkillsStore } from "../src/store/skills";
import type { SkillInfo } from "@hiagent/shared";

// 捕获 store 原始 action 方法，避免测试间 mock 泄漏
const originalActions = {
  toggleSkill: useSkillsStore.getState().toggleSkill,
  addDir: useSkillsStore.getState().addDir,
  removeDir: useSkillsStore.getState().removeDir,
  load: useSkillsStore.getState().load,
};

beforeEach(() => {
  useSkillsStore.setState({
    skills: [], allSkills: [], dirs: [], disabledSkills: [],
    builtinDir: "/home/.hiagent/skills", loading: false,
    toggleSkill: originalActions.toggleSkill,
    addDir: originalActions.addDir,
    removeDir: originalActions.removeDir,
    load: originalActions.load,
  });
});

test("技能目录默认展开，展开时标题不显示内置目录路径", () => {
  useSkillsStore.setState({
    dirs: ["/home/.hiagent/skills", "/home/.claude/skills"],
    builtinDir: "/home/.hiagent/skills",
    allSkills: [],
  });
  render(<SkillSection />);
  const addBtn = screen.getByTestId("skill-add-dir-btn");
  expect(addBtn.getAttribute("aria-label")).toBe("添加技能目录");
  const toggleBtn = screen.getByTestId("skill-dir-toggle");
  expect(toggleBtn.textContent).toContain("技能目录");
  expect(toggleBtn.textContent).not.toContain("/home/.hiagent/skills");
});

test("折叠技能目录后，标题才显示内置目录路径", () => {
  useSkillsStore.setState({
    dirs: ["/home/.hiagent/skills"],
    builtinDir: "/home/.hiagent/skills",
    allSkills: [],
  });
  render(<SkillSection />);
  fireEvent.click(screen.getByTestId("skill-dir-toggle"));
  const toggleBtn = screen.getByTestId("skill-dir-toggle");
  expect(toggleBtn.textContent).toContain("/home/.hiagent/skills");
});

test("点击刷新技能按钮重新加载技能目录", () => {
  const loadMock = mock();
  useSkillsStore.setState({ load: loadMock, allSkills: [] });
  render(<SkillSection />);
  const refreshBtn = screen.getByTestId("skill-refresh-btn");
  expect(refreshBtn.getAttribute("aria-label")).toBe("刷新技能");
  fireEvent.click(refreshBtn);
  expect(loadMock).toHaveBeenCalledTimes(1);
});

test("添加/刷新按钮为 icon 按钮，与技能目录标题同行且右对齐", () => {
  useSkillsStore.setState({ allSkills: [] });
  render(<SkillSection />);
  const toggleBtn = screen.getByTestId("skill-dir-toggle");
  const addBtn = screen.getByTestId("skill-add-dir-btn");
  const refreshBtn = screen.getByTestId("skill-refresh-btn");
  // 按钮不含文字，使用 svg icon
  expect(addBtn.textContent).toBe("");
  expect(refreshBtn.textContent).toBe("");
  expect(addBtn.querySelector("svg")).toBeTruthy();
  expect(refreshBtn.querySelector("svg")).toBeTruthy();
  // 与标题同一行容器，且容器为 justify-between（右对齐）
  const headerRow = toggleBtn.parentElement!;
  expect(headerRow.className).toContain("justify-between");
  expect(headerRow.contains(addBtn)).toBe(true);
  expect(headerRow.contains(refreshBtn)).toBe(true);
});

// ===== 搜索过滤测试 =====

test("搜索框输入即实时过滤技能（按名称，大小写不敏感）", () => {
  useSkillsStore.setState({
    allSkills: [
      { name: "brave-search", description: "web 搜索", path: "/skills/brave-search" },
      { name: "pdf-tools", description: "PDF 处理", path: "/skills/pdf-tools" },
    ],
  });
  render(<SkillSection />);
  const input = screen.getByTestId("skill-search-input");
  fireEvent.change(input, { target: { value: "BRAVE" } });
  expect(screen.getByText("brave-search")).toBeTruthy();
  expect(screen.queryByText("pdf-tools")).toBeNull();
});

test("清空搜索后恢复完整技能列表", () => {
  useSkillsStore.setState({
    allSkills: [
      { name: "brave-search", description: "web 搜索", path: "/skills/brave-search" },
      { name: "pdf-tools", description: "PDF 处理", path: "/skills/pdf-tools" },
    ],
  });
  render(<SkillSection />);
  const input = screen.getByTestId("skill-search-input");
  fireEvent.change(input, { target: { value: "brave" } });
  expect(screen.queryByText("pdf-tools")).toBeNull();
  fireEvent.change(input, { target: { value: "" } });
  expect(screen.getByText("brave-search")).toBeTruthy();
  expect(screen.getByText("pdf-tools")).toBeTruthy();
});

test("搜索无匹配时显示提示", () => {
  useSkillsStore.setState({
    allSkills: [
      { name: "brave-search", description: "web 搜索", path: "/skills/brave-search" },
    ],
  });
  render(<SkillSection />);
  fireEvent.change(screen.getByTestId("skill-search-input"), { target: { value: "不存在" } });
  expect(screen.getByText("无匹配的技能")).toBeTruthy();
});

test("默认展开显示目录列表", () => {
  useSkillsStore.setState({
    dirs: ["/home/.hiagent/skills", "/home/.claude/skills"],
    builtinDir: "/home/.hiagent/skills",
    allSkills: [],
  });
  render(<SkillSection />);
  expect(screen.getByText("/home/.claude/skills")).toBeTruthy();
});

test("内置目录无删除按钮", () => {
  useSkillsStore.setState({
    dirs: ["/home/.hiagent/skills"],
    builtinDir: "/home/.hiagent/skills",
    allSkills: [],
  });
  render(<SkillSection />);
  expect(screen.queryByTestId("skill-dir-remove-/home/.hiagent/skills")).toBeNull();
});

test("用户目录有删除按钮", () => {
  useSkillsStore.setState({
    dirs: ["/home/.hiagent/skills", "/home/.claude/skills"],
    builtinDir: "/home/.hiagent/skills",
    allSkills: [],
  });
  render(<SkillSection />);
  expect(screen.getByTestId("skill-dir-remove-/home/.claude/skills")).toBeTruthy();
});

test("技能列表渲染 + switch 开关在右侧", () => {
  const toggleMock = mock();
  useSkillsStore.setState({
    allSkills: [
      { name: "brave-search", description: "web 搜索", path: "/skills/brave-search" },
      { name: "pdf-tools", description: "PDF 处理", path: "/skills/pdf-tools" },
    ],
    disabledSkills: ["pdf-tools"],
    toggleSkill: toggleMock,
  });
  render(<SkillSection />);
  expect(screen.getByText("brave-search")).toBeTruthy();
  expect(screen.getByText("pdf-tools")).toBeTruthy();

  // switch 开关替代了旧的 checkbox，放在每行最右侧
  const pdfSwitch = screen.getByTestId("skill-switch-pdf-tools");
  expect(pdfSwitch).toBeTruthy();
  // pdf-tools 被禁用，toggle 应显示为 off 状态
  expect(pdfSwitch.getAttribute("data-on")).toBe("false");

  // 点击开关切换
  fireEvent.click(pdfSwitch);
  expect(toggleMock).toHaveBeenCalledWith("pdf-tools");

  // brave-search 是启用状态
  const braveSwitch = screen.getByTestId("skill-switch-brave-search");
  expect(braveSwitch.getAttribute("data-on")).toBe("true");
});

test("点击添加技能目录弹出 DirTreePicker", () => {
  useSkillsStore.setState({
    dirs: ["/home/.hiagent/skills"],
    builtinDir: "/home/.hiagent/skills",
    allSkills: [],
  });
  render(<SkillSection />);
  fireEvent.click(screen.getByTestId("skill-add-dir-btn"));
  expect(screen.getByTestId("dir-picker")).toBeTruthy();
});

// ===== 分组测试 =====

test("无 source 的技能归入内置技能分组", () => {
  useSkillsStore.setState({
    allSkills: [
      { name: "brainstorming", description: "创意工作前使用", path: "/skills/brainstorming" },
    ],
  });
  render(<SkillSection />);
  expect(screen.getByText("内置技能 1 项")).toBeTruthy();
  expect(screen.getByText("brainstorming")).toBeTruthy();
});

test("builtin 类型技能显示「内置」标签", () => {
  useSkillsStore.setState({
    allSkills: [
      { name: "brainstorming", description: "desc", path: "/p", source: { type: "builtin" } },
    ],
  });
  render(<SkillSection />);
  expect(screen.getByText("内置技能 1 项")).toBeTruthy();
  expect(screen.getByText("内置")).toBeTruthy();
});

test("extension 类型技能单独分组并显示插件名标签", () => {
  useSkillsStore.setState({
    allSkills: [
      { name: "pdf", description: "PDF 处理", path: "/ext/pdf", source: { type: "extension", name: "zcode-guide" } },
    ],
  });
  render(<SkillSection />);
  expect(screen.getByText("Plugin 技能 1 项")).toBeTruthy();
  expect(screen.getByText("zcode-guide")).toBeTruthy();
});

test("多个 source 类型混合分组正确", () => {
  const skills: SkillInfo[] = [
    { name: "builtin-a", description: "", path: "/b/a", source: { type: "builtin" } },
    { name: "builtin-b", description: "", path: "/b/b", source: { type: "builtin" } },
    { name: "plugin-x", description: "", path: "/p/x", source: { type: "extension", name: "pkg-a" } },
    { name: "plugin-y", description: "", path: "/p/y", source: { type: "extension", name: "pkg-a" } },
    { name: "local-1", description: "", path: "/l/1", source: { type: "user" } },
  ];
  useSkillsStore.setState({ allSkills: skills });
  render(<SkillSection />);
  expect(screen.getByText("内置技能 2 项")).toBeTruthy();
  expect(screen.getByText("Plugin 技能 2 项")).toBeTruthy();
  expect(screen.getByText("个人技能 1 项")).toBeTruthy();
});

test("空分组不显示标题", () => {
  useSkillsStore.setState({
    allSkills: [
      { name: "only-plugin", description: "", path: "/p", source: { type: "extension", name: "pkg" } },
    ],
  });
  render(<SkillSection />);
  // 内置技能和个人技能分组为空，不应显示
  expect(screen.queryByText(/内置技能/)).toBeNull();
  expect(screen.queryByText(/个人技能/)).toBeNull();
  expect(screen.getByText("Plugin 技能 1 项")).toBeTruthy();
});
