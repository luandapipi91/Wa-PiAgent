import { test, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProcessCard } from "../src/components/blocks/ProcessCard";

test("折叠时只渲染头部，body 不在 DOM", () => {
  render(<ProcessCard tone="accent" icon="💭" title="思考过程" meta="已完成" open={false} onToggle={() => {}} testId="pc">内容</ProcessCard>);
  expect(screen.getByTestId("pc-header").textContent).toContain("思考过程");
  expect(screen.getByTestId("pc-header").textContent).toContain("已完成");
  expect(screen.queryByTestId("pc-body")).toBeNull();
});

test("open=true 时渲染 body", () => {
  render(<ProcessCard tone="success" icon="✓" title="Read" open={true} onToggle={() => {}} testId="pc">参数详情</ProcessCard>);
  expect(screen.getByTestId("pc-body").textContent).toContain("参数详情");
});

test("点击头部触发 onToggle", () => {
  let called = 0;
  render(<ProcessCard tone="accent" icon="💭" title="t" open={false} onToggle={() => called++} testId="pc">b</ProcessCard>);
  fireEvent.click(screen.getByTestId("pc-header"));
  expect(called).toBe(1);
});

test("muted 时根节点带 data-muted 且透明度弱化", () => {
  render(<ProcessCard tone="accent" icon="💭" title="t" open={false} onToggle={() => {}} muted testId="pc">b</ProcessCard>);
  const root = screen.getByTestId("pc");
  expect(root.getAttribute("data-muted")).toBe("true");
  expect(root.className).toContain("opacity-55");
});

test("body 带 overflow-wrap:anywhere 兜底（长无空格串任意断行，不撑破卡片）", () => {
  render(<ProcessCard tone="accent" icon="💭" title="t" open={true} onToggle={() => {}} testId="pc">b</ProcessCard>);
  expect(screen.getByTestId("pc-body").className).toContain("overflow-wrap:anywhere");
});
