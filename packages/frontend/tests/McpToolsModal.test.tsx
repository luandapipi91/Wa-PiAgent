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

test("参数未知时什么都不渲染：不写「无参数」「参数」（拿不到 inputSchema 就不虚构）", () => {
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
  // 拿不到 inputSchema 时：参数未知，必须什么都不渲染，不能写「无参数」
  expect(screen.queryByText("无参数")).toBeNull();
  expect(screen.queryByText("参数")).toBeNull();
});

test("工具摘要：渲染简介与参数（名字 / 类型 / 必填 / 参数说明）", () => {
  render(
    <McpToolsModal
      serverName="hlk-mcp"
      tools={[
        {
          name: "list_shops",
          description: "获取当前商户的门店列表",
          parameters: [
            { name: "keyword", type: "string", description: "搜索关键词", required: true },
            { name: "limit", type: "integer", required: false },
          ],
        },
      ]}
      loading={false}
      onClose={() => {}}
    />,
  );
  expect(screen.getByText("list_shops")).toBeTruthy();
  expect(screen.getByText("获取当前商户的门店列表")).toBeTruthy();
  expect(screen.getByText("参数")).toBeTruthy();
  expect(screen.getByText("keyword")).toBeTruthy();
  expect(screen.getByText("string")).toBeTruthy();
  expect(screen.getByText(/搜索关键词/)).toBeTruthy();
  // 两个参数 → 两个类型标记（必填标记只在 keyword 上：一个 *）
  expect(screen.getAllByTestId("mcp-tool-param-type")).toHaveLength(2);
  expect(screen.getAllByText("*")).toHaveLength(1);
});

test("参数没有 type 时不渲染空类型标记（不留孤立占位）", () => {
  render(
    <McpToolsModal
      serverName="hlk-mcp"
      tools={[{ name: "t", parameters: [{ name: "any", type: "", required: false }] }]}
      loading={false}
      onClose={() => {}}
    />,
  );
  expect(screen.getByText("t")).toBeTruthy();
  // 正向控制：参数名与参数块照常渲染
  expect(screen.getByText("any")).toBeTruthy();
  expect(screen.getByText("参数")).toBeTruthy();
  expect(screen.queryAllByTestId("mcp-tool-param-type")).toHaveLength(0);
});
