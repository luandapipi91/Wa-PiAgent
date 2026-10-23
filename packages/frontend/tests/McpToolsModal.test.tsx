import { test, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
import { McpToolsModal } from "../src/components/mcp/McpToolsModal";

test("loading 且无工具时显示加载中过渡（而非空态提示）", () => {
  render(<McpToolsModal serverName="dbx" tools={[]} loading={true} onClose={() => {}} />);
  expect(screen.getByTestId("mcp-tools-loading")).toBeTruthy();
  expect(screen.queryByText(/读不到工具列表/)).toBeNull();
});

test("非 loading 且无工具时显示空态提示", () => {
  render(<McpToolsModal serverName="dbx" tools={[]} loading={false} onClose={() => {}} />);
  expect(screen.getByText(/读不到工具列表/)).toBeTruthy();
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

test("参数未知时什么都不渲染：不写「无参数」「参数」（pi mcp list --json 只给名字）", () => {
  render(
    <McpToolsModal
      serverName="dbx"
      tools={[{ name: "query" }, { name: "list" }]}
      loading={false}
      onClose={() => {}}
    />,
  );
  // 正向控制：工具名照常渲染（否则下面两条「不存在」可能只是因为什么都没渲染）
  expect(screen.getByText("query")).toBeTruthy();
  expect(screen.getByText("list")).toBeTruthy();
  // pi mcp list --json 只给名字：参数未知时必须什么都不渲染，不能写「无参数」
  expect(screen.queryByText("无参数")).toBeNull();
  expect(screen.queryByText("参数")).toBeNull();
});
