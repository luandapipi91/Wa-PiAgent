import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { QuickInvokeMenu } from "../src/components/ui/QuickInvokeMenu";
import type { MenuItem } from "../src/components/ui/QuickInvokeMenu";

beforeEach(() => {
  document.body.innerHTML = "";
});

const fileItems: MenuItem[] = [
  { id: "/src/App.tsx", name: "App.tsx", path: "src/App.tsx" },
  { id: "/src/index.ts", name: "index.ts", path: "src/index.ts" },
];

const skillItems: MenuItem[] = [
  { id: "brainstorming", name: "brainstorming", description: "头脑风暴", source: { type: "builtin" } },
  { id: "pdf-tools", name: "pdf-tools", description: "PDF 工具", source: { type: "extension", name: "ext-pkg" } },
];

test("渲染文件列表", () => {
  render(<QuickInvokeMenu type="file" items={fileItems} highlightedIndex={0} onSelect={mock()} onHover={mock()} />);
  expect(screen.getByText("App.tsx")).toBeDefined();
  expect(screen.getByText("src/App.tsx")).toBeDefined();
});

test("渲染技能列表含来源标签", () => {
  render(<QuickInvokeMenu type="skill" items={skillItems} highlightedIndex={0} onSelect={mock()} onHover={mock()} />);
  expect(screen.getByText("brainstorming")).toBeDefined();
  expect(screen.getByText("内置")).toBeDefined(); // builtin 来源标签
  expect(screen.getByText("ext-pkg")).toBeDefined(); // extension 来源标签
});

test("高亮第一项", () => {
  render(<QuickInvokeMenu type="file" items={fileItems} highlightedIndex={0} onSelect={mock()} onHover={mock()} />);
  const firstItem = screen.getByTestId("quick-invoke-item-0");
  expect(firstItem.className).toContain("bg-accent-soft");
});

test("点击项触发 onSelect", () => {
  const onSelect = mock();
  render(<QuickInvokeMenu type="file" items={fileItems} highlightedIndex={0} onSelect={onSelect} onHover={mock()} />);
  fireEvent.click(screen.getByTestId("quick-invoke-item-0"));
  expect(onSelect).toHaveBeenCalledWith(fileItems[0]);
});

test("鼠标 hover 触发 onHover", () => {
  const onHover = mock();
  render(<QuickInvokeMenu type="file" items={fileItems} highlightedIndex={0} onSelect={mock()} onHover={onHover} />);
  fireEvent.mouseEnter(screen.getByTestId("quick-invoke-item-1"));
  expect(onHover).toHaveBeenCalledWith(1);
});

test("空列表显示提示文本", () => {
  render(<QuickInvokeMenu type="file" items={[]} highlightedIndex={-1} onSelect={mock()} onHover={mock()} emptyText="无匹配文件" />);
  expect(screen.getByText("无匹配文件")).toBeDefined();
});

test("菜单容器宽度加宽（不再是最初的 400px）", () => {
  render(<QuickInvokeMenu type="file" items={fileItems} highlightedIndex={0} onSelect={mock()} onHover={mock()} />);
  const menu = screen.getByTestId("quick-invoke-menu");
  expect(menu.className).not.toContain("w-[400px]");
  expect(menu.className).toContain("w-[560px]");
});

test("高亮项变化时自动滚动到可视区域", () => {
  const scrolledTestIds: (string | null)[] = [];
  const original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = mock(function (this: Element) {
    scrolledTestIds.push(this.getAttribute("data-testid"));
  });
  try {
    const manyItems: MenuItem[] = Array.from({ length: 30 }, (_, i) => ({
      id: `/src/f${i}.ts`, name: `f${i}.ts`, path: `src/f${i}.ts`,
    }));
    render(<QuickInvokeMenu type="file" items={manyItems} highlightedIndex={20} onSelect={mock()} onHover={mock()} />);
    // 高亮项（第 20 项）应触发 scrollIntoView
    expect(scrolledTestIds).toContain("quick-invoke-item-20");
  } finally {
    Element.prototype.scrollIntoView = original;
  }
});
