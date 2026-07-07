import { test, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThinkingPanel } from "../../src/components/blocks/ThinkingPanel";
import { TextBlock } from "../../src/components/blocks/TextBlock";
import { ToolCallPanel } from "../../src/components/blocks/ToolCallPanel";
import { DelegateCard } from "../../src/components/blocks/DelegateCard";

test("ThinkingPanel 默认折叠，点击展开", () => {
  render(<ThinkingPanel thinking="我在想" />);
  expect(screen.queryByText("我在想")).toBeNull();
  fireEvent.click(screen.getByText(/思考过程/));
  expect(screen.getByText("我在想")).toBeTruthy();
});

test("TextBlock 渲染 markdown 代码块", () => {
  render(<TextBlock text={"```js\nconst x = 1;\n```"} />);
  expect(screen.getByText(/const x/)).toBeTruthy();
});

test("ToolCallPanel 显示工具名和参数", () => {
  render(<ToolCallPanel toolCall={{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/a" } }} />);
  expect(screen.getByText(/read/)).toBeTruthy();
});

test("DelegateCard 渲染橙色委派卡片", () => {
  render(<DelegateCard toolCall={{ type: "toolCall", id: "c1", name: "intercom", arguments: { action: "ask", to: "pm", message: "需求?" } }} />);
  expect(screen.getByText(/委派给/)).toBeTruthy();
  expect(screen.getByText(/需求\?/)).toBeTruthy();
});
