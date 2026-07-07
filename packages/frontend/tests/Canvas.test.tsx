import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen } from "@testing-library/react";
import { Canvas } from "../src/components/canvas/Canvas";
import { useAgentsStore } from "../src/store/agents";

// mock reactflow：把 nodes/edges 透传到测试可断言的 DOM
mock.module("reactflow", () => ({
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
