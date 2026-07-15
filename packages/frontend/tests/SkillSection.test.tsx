import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { SkillSection } from "../src/components/settings/SkillSection";
import { useSkillsStore } from "../src/store/skills";

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
  // 默认展开：目录列表与"添加技能目录"按钮可见
  expect(screen.getByText("+ 添加技能目录")).toBeTruthy();
  // 展开态下标题不重复显示内置目录路径（路径已在列表中以 [内置] 呈现）
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
  // 默认展开 → 点击折叠
  fireEvent.click(screen.getByTestId("skill-dir-toggle"));
  const toggleBtn = screen.getByTestId("skill-dir-toggle");
  expect(toggleBtn.textContent).toContain("/home/.hiagent/skills");
});

test("点击刷新技能按钮重新加载技能目录", () => {
  const loadMock = mock();
  useSkillsStore.setState({ load: loadMock, allSkills: [] });
  render(<SkillSection />);
  fireEvent.click(screen.getByTestId("skill-refresh-btn"));
  expect(loadMock).toHaveBeenCalledTimes(1);
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

test("技能列表渲染 + checkbox toggle", () => {
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
  // pdf-tools 被禁用 → checkbox 未勾选
  const pdfCheckbox = screen.getByTestId("skill-checkbox-pdf-tools") as HTMLInputElement;
  expect(pdfCheckbox.checked).toBe(false);
  // 点击启用
  fireEvent.click(pdfCheckbox);
  expect(toggleMock).toHaveBeenCalledWith("pdf-tools");
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
