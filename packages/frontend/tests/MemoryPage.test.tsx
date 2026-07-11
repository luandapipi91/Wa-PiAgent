import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryPage } from "../src/components/memory/MemoryPage";
import { useMemoryStore } from "../src/store/memory";
import { useProjectsStore } from "../src/store/projects";

const originalMemory = useMemoryStore.getState();
const originalProjects = useProjectsStore.getState();

beforeEach(() => {
  useProjectsStore.setState({
    currentProjectId: "p1",
    projects: [{ id: "p1", name: "测试项目", cwd: "/tmp/p1", createdAt: 0 }],
  });
  useMemoryStore.setState({
    memories: [{
      id: "projects-memory/p1/MEMORY.md:0",
      text: "项目使用 pnpm",
      category: "memory",
      scope: "project",
      sourceFile: "/fake/MEMORY.md",
      rawIndex: 0,
    }],
    archived: [],
    instructions: [{
      path: "/fake/AGENTS.md",
      name: "AGENTS.md",
      scope: "project",
      content: "行为准则",
    }],
    config: { reviewEnabled: true, memoryPolicyStyle: "full" },
    activeTab: "saved",
    categoryFilter: "all",
    scopeFilter: "all",
    memoryScope: "project",
    searchQuery: "",
  });
});

afterEach(() => {
  useMemoryStore.setState(originalMemory);
  useProjectsStore.setState(originalProjects);
});

test("渲染标题 + 内联开关 + 默认已保存 Tab", () => {
  render(<MemoryPage />);
  expect(screen.getByText("🧠 记忆")).toBeTruthy();
  expect(screen.getByTestId("tab-已保存")).toBeTruthy();
  expect(screen.getByText("项目使用 pnpm")).toBeTruthy();
});

test("点击归档 Tab 切换到归档列表", () => {
  render(<MemoryPage />);
  fireEvent.click(screen.getByTestId("tab-归档"));
  // 归档列表为空时显示空状态
  expect(screen.getByTestId("memory-empty")).toBeTruthy();
});

test("点击指令文件 Tab 展示指令列表", () => {
  render(<MemoryPage />);
  fireEvent.click(screen.getByTestId("tab-指令文件"));
  expect(screen.getByTestId("instruction-item-project")).toBeTruthy();
});

test("分类筛选 — 点击失败只筛选 failure 类别", () => {
  useMemoryStore.setState({
    memories: [
      { id: "a:0", text: "记忆A", category: "memory", scope: "project", sourceFile: "/a", rawIndex: 0 },
      { id: "b:0", text: "失败B", category: "failure", scope: "project", sourceFile: "/b", rawIndex: 0 },
    ],
  });
  render(<MemoryPage />);
  // 初始展示全部（项目作用域）
  expect(screen.getByText("记忆A")).toBeTruthy();
  expect(screen.getByText("失败B")).toBeTruthy();

  // 点击失败筛选（FilterChip 是 button；MemoryCard 分类徽章是 span，二者文字均为"失败"，
  // 用 selector 限定到 button 以避免 TestingLibrary 多元素报错）
  fireEvent.click(screen.getAllByText("失败", { selector: "button" })[0]);
  expect(screen.queryByText("记忆A")).toBeNull();
  expect(screen.getByText("失败B")).toBeTruthy();
});

test("搜索框过滤记忆", () => {
  render(<MemoryPage />);
  const input = screen.getByTestId("memory-search") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "pnpm" } });
  expect(screen.getByText("项目使用 pnpm")).toBeTruthy();

  fireEvent.change(input, { target: { value: "不存在的关键词" } });
  expect(screen.getByTestId("memory-empty")).toBeTruthy();
});

test("记忆卡片编辑 — 点击编辑展开文本框，保存后回调（带当前 projectId）", () => {
  const editMock = mock();
  useMemoryStore.setState({
    memories: [{
      id: "test:0", text: "原始内容", category: "memory",
      scope: "project", sourceFile: "/fake", rawIndex: 0,
    }],
  });
  useMemoryStore.setState({ update: editMock });

  render(<MemoryPage />);
  // 点击编辑
  fireEvent.click(screen.getByTestId("memory-edit"));
  const textarea = screen.getByTestId("memory-edit-textarea") as HTMLTextAreaElement;
  expect(textarea.value).toBe("原始内容");

  // 修改内容
  fireEvent.change(textarea, { target: { value: "修改后内容" } });
  fireEvent.click(screen.getByTestId("memory-edit-save"));

  expect(editMock).toHaveBeenCalledWith("p1", "test:0", "修改后内容");
});

test("切换全局/项目选择器过滤记忆", () => {
  useMemoryStore.setState({
    memories: [
      { id: "g:0", text: "全局A", category: "memory", scope: "global", sourceFile: "/g", rawIndex: 0 },
      { id: "p:0", text: "项目A", category: "memory", scope: "project", sourceFile: "/p", rawIndex: 0 },
    ],
  });
  render(<MemoryPage />);

  // 默认项目作用域：只看到项目A
  expect(screen.getByText("项目A")).toBeTruthy();
  expect(screen.queryByText("全局A")).toBeNull();

  // 切到全局：只看到全局A
  fireEvent.change(screen.getByTestId("memory-scope-select"), { target: { value: "global" } });
  expect(screen.getByText("全局A")).toBeTruthy();
  expect(screen.queryByText("项目A")).toBeNull();
});

test("项目作用域下显示项目选择器，全局作用域下隐藏", () => {
  render(<MemoryPage />);
  expect(screen.queryByTestId("memory-project-select")).toBeTruthy();

  fireEvent.change(screen.getByTestId("memory-scope-select"), { target: { value: "global" } });
  expect(screen.queryByTestId("memory-project-select")).toBeNull();
});

test("点击添加按钮展开输入区，保存后发送 memory:add（项目作用域带 projectId）", () => {
  const addMock = mock();
  useMemoryStore.setState({ add: addMock });

  render(<MemoryPage />);
  fireEvent.click(screen.getByTestId("memory-add-button"));
  const textarea = screen.getByTestId("memory-add-textarea") as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: "新记忆" } });
  fireEvent.click(screen.getByTestId("memory-add-save"));

  expect(addMock).toHaveBeenCalledWith("project", "新记忆", "p1");
});

test("全局作用域下添加记忆不带 projectId", () => {
  const addMock = mock();
  useMemoryStore.setState({ add: addMock, memoryScope: "global" });

  render(<MemoryPage />);
  fireEvent.click(screen.getByTestId("memory-add-button"));
  const textarea = screen.getByTestId("memory-add-textarea") as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: "全局新记忆" } });
  fireEvent.click(screen.getByTestId("memory-add-save"));

  expect(addMock).toHaveBeenCalledWith("global", "全局新记忆", undefined);
});

test("添加空内容不会触发 memory:add", () => {
  const addMock = mock();
  useMemoryStore.setState({ add: addMock });

  render(<MemoryPage />);
  fireEvent.click(screen.getByTestId("memory-add-button"));
  fireEvent.click(screen.getByTestId("memory-add-save"));

  expect(addMock).not.toHaveBeenCalled();
});
