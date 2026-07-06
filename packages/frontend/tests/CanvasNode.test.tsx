import { test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { CanvasNode } from "../src/components/canvas/CanvasNode";

vi.mock("reactflow", () => ({
  Handle: () => null,
  Position: { Top: "top", Bottom: "bottom" },
}));

test("渲染 emoji + 状态", () => {
  render(<CanvasNode data={{ agentName: "dev", status: "thinking", tokenCount: 2400 }} />);
  expect(screen.getByText("技术实现")).toBeTruthy();
  expect(screen.getByText(/thinking/)).toBeTruthy();
  expect(screen.getByText(/2\.4k tok/)).toBeTruthy();
});
