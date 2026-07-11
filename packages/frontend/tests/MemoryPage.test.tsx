import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryPage } from "../src/components/memory/MemoryPage";
import { useMemoryStore } from "../src/store/memory";

const originalState = useMemoryStore.getState();

beforeEach(() => {
  useMemoryStore.setState({
    memories: [{
      id: "pi-hermes-memory/MEMORY.md:0",
      text: "项目使用 pnpm",
      category: "memory",
      scope: "global",
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
    searchQuery: "",
  });
});

afterEach(() => {
  useMemoryStore.setState(originalState);
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
      { id: "a:0", text: "记忆A", category: "memory", scope: "global", sourceFile: "/a", rawIndex: 0 },
      { id: "b:0", text: "失败B", category: "failure", scope: "global", sourceFile: "/b", rawIndex: 0 },
    ],
  });
  render(<MemoryPage />);
  // 初始展示全部
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

test("记忆卡片编辑 — 点击编辑展开文本框，保存后回调", () => {
  const editMock = mock();
  useMemoryStore.setState({
    memories: [{
      id: "test:0", text: "原始内容", category: "memory",
      scope: "global", sourceFile: "/fake", rawIndex: 0,
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

  expect(editMock).toHaveBeenCalledWith("test:0", "修改后内容");
});
