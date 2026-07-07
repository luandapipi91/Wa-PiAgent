import { test, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Canvas } from "../src/components/canvas/Canvas";
import { useAgentsStore } from "../src/store/agents";
import { useIntercomStore } from "../src/store/intercom";
import type { AskItem } from "@hiagent/shared";

// mock reactflow：把 nodes/edges 透传到测试可断言的 DOM
vi.mock("reactflow", () => ({
  default: ({ nodes, edges }: any) => (
    <div data-testid="canvas-mock">
      <div data-testid="nodes">{nodes.map((n: any) => <span key={n.id}>{n.id}</span>)}</div>
      <div data-testid="edges">{edges.map((e: any) => <span key={e.id}>{e.id}</span>)}</div>
    </div>
  ),
  Background: () => null,
}));

beforeEach(() => {
  useAgentsStore.setState({ states: {}, configs: {} });
  useIntercomStore.setState({ asksBySession: {} });
});

test("渲染 4 个 agent 节点", () => {
  render(<Canvas />);
  const nodes = screen.getByTestId("nodes");
  expect(nodes.textContent).toContain("product");
  expect(nodes.textContent).toContain("pm");
  expect(nodes.textContent).toContain("dev");
  expect(nodes.textContent).toContain("test");
});

test("默认 partners 连线存在", () => {
  render(<Canvas />);
  const edges = screen.getByTestId("edges");
  expect(edges.textContent).toContain("product-dev");
  expect(edges.textContent).toContain("pm-test");
});

test("活跃 ask 生成橙色动画连线", () => {
  const ask: AskItem = {
    messageId: "a1", sessionId: "s1", from: "product", to: "dev",
    text: "问", startedAt: 0, resolved: false,
  };
  useIntercomStore.setState({ asksBySession: { s1: [ask] } });
  render(<Canvas />);
  const edges = screen.getByTestId("edges");
  expect(edges.textContent).toContain("ask-a1");
});

test("已 resolved 的 ask 不生成连线", () => {
  const ask: AskItem = {
    messageId: "a2", sessionId: "s1", from: "pm", to: "test",
    text: "问", startedAt: 0, resolved: true,
  };
  useIntercomStore.setState({ asksBySession: { s1: [ask] } });
  render(<Canvas />);
  const edges = screen.getByTestId("edges");
  expect(edges.textContent).not.toContain("ask-a2");
});
