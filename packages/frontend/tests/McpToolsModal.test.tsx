import { test, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
import { McpToolsModal } from "../src/components/mcp/McpToolsModal";

test("loading 且无工具时显示加载中过渡（而非空态提示）", () => {
  render(<McpToolsModal serverName="dbx" tools={[]} loading={true} onClose={() => {}} />);
  expect(screen.getByTestId("mcp-tools-loading")).toBeTruthy();
  expect(screen.queryByText(/暂无可用的工具缓存/)).toBeNull();
});

test("非 loading 且无工具时显示空态提示", () => {
  render(<McpToolsModal serverName="dbx" tools={[]} loading={false} onClose={() => {}} />);
  expect(screen.getByText(/暂无可用的工具缓存/)).toBeTruthy();
  expect(screen.queryByTestId("mcp-tools-loading")).toBeNull();
});

test("有工具时显示工具列表（即使 loading）", () => {
  render(
    <McpToolsModal
      serverName="dbx"
      tools={[{ name: "query", description: "run a query" }]}
      loading={true}
      onClose={() => {}}
    />,
  );
  expect(screen.getByText("query")).toBeTruthy();
});
