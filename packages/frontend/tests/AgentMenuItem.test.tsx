import { test, expect, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentMenuItem } from "../src/components/ui/AgentMenuItem";

test("渲染头像、名称、描述", () => {
  render(
    <AgentMenuItem
      name="技术实现"
      description="写代码"
      avatar="🤖"
      avatarColor="#06b6d4-#3b82f6"
    />
  );
  expect(screen.getByText("技术实现")).toBeTruthy();
  expect(screen.getByText("写代码")).toBeTruthy();
});

test("icon: 前缀头像与旧 emoji（命中映射）都渲染 svg 图标", () => {
  const { container: c1, unmount } = render(
    <AgentMenuItem name="a" avatar="icon:monitor" />
  );
  expect(c1.querySelector("svg")).toBeTruthy();
  unmount();
  const { container: c2, unmount: u2 } = render(
    <AgentMenuItem name="a" avatar="🤖" />
  );
  expect(c2.querySelector("svg")).toBeTruthy();
  u2();
  // 未命中映射的 emoji 仍渲染文本（旧数据兼容）
  const { container: c3 } = render(<AgentMenuItem name="a" avatar="🐉" />);
  expect(c3.querySelector("svg")).toBeNull();
  expect(screen.getByText("🐉")).toBeTruthy();
});

test("selected=true 显示 ✓ 勾选标记", () => {
  render(<AgentMenuItem name="dev" selected />);
  expect(screen.getByText("✓")).toBeTruthy();
});

test("selected=false 不显示勾选标记", () => {
  render(<AgentMenuItem name="dev" />);
  expect(screen.queryByText("✓")).toBeNull();
});

test("点击触发 onClick", () => {
  const onClick = mock();
  render(<AgentMenuItem name="dev" onClick={onClick} testId="item" />);
  fireEvent.click(screen.getByTestId("item"));
  expect(onClick).toHaveBeenCalled();
});

test("未提供 avatar 时回退 robot 图标占位", () => {
  render(<AgentMenuItem name="dev" testId="item" />);
  expect(screen.getByTestId("item").querySelector("svg")).toBeTruthy();
});
