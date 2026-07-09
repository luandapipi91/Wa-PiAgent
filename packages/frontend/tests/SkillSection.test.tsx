import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { SkillSection } from "../src/components/settings/SkillSection";
import { useSkillsStore } from "../src/store/skills";

beforeEach(() => {
  useSkillsStore.setState({
    skills: [], allSkills: [], dirs: [], disabledSkills: [],
    builtinDir: "/home/.hiagent/skills", loading: false,
  });
});

test("渲染技能目录折叠态 + 已加载技能标题", () => {
  render(<SkillSection />);
  // 用 testid 定位按钮，验证其包含内置目录路径
  const toggleBtn = screen.getByTestId("skill-dir-toggle");
  expect(toggleBtn.textContent).toContain("技能目录");
  expect(toggleBtn.textContent).toContain("/home/.hiagent/skills");
  expect(screen.getByText("已加载技能")).toBeTruthy();
});

test("点击技能目录展开显示目录列表", () => {
  useSkillsStore.setState({
    dirs: ["/home/.hiagent/skills", "/home/.claude/skills"],
    builtinDir: "/home/.hiagent/skills",
    allSkills: [],
  });
  render(<SkillSection />);
  fireEvent.click(screen.getByTestId("skill-dir-toggle"));
  expect(screen.getByText("/home/.claude/skills")).toBeTruthy();
  expect(screen.getByText("+ 添加技能目录")).toBeTruthy();
});

test("内置目录无删除按钮", () => {
  useSkillsStore.setState({
    dirs: ["/home/.hiagent/skills"],
    builtinDir: "/home/.hiagent/skills",
    allSkills: [],
  });
  render(<SkillSection />);
  fireEvent.click(screen.getByTestId("skill-dir-toggle"));
  expect(screen.queryByTestId("skill-dir-remove-/home/.hiagent/skills")).toBeNull();
});

test("用户目录有删除按钮", () => {
  useSkillsStore.setState({
    dirs: ["/home/.hiagent/skills", "/home/.claude/skills"],
    builtinDir: "/home/.hiagent/skills",
    allSkills: [],
  });
  render(<SkillSection />);
  fireEvent.click(screen.getByTestId("skill-dir-toggle"));
  expect(screen.getByTestId("skill-dir-remove-/home/.claude/skills")).toBeTruthy();
});

test("技能列表渲染 + checkbox toggle", () => {
  const toggleMock = mock();
  useSkillsStore.setState({
    allSkills: [
      { name: "brave-search", description: "web 搜索" },
      { name: "pdf-tools", description: "PDF 处理" },
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
  fireEvent.click(screen.getByTestId("skill-dir-toggle"));
  fireEvent.click(screen.getByTestId("skill-add-dir-btn"));
  expect(screen.getByTestId("dir-picker")).toBeTruthy();
});
