import { test, expect, mock } from "bun:test";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { McpCard, stateBadge } from "../src/components/mcp/McpCard";

const noop = () => {};

test("渲染 server 名称、描述行", () => {
  render(
    <McpCard
      config={{
        name: "test-server",
        command: "npx",
        args: ["-y", "test"],
      }}
      state="connected"
      onTest={mock()}
      onViewTools={mock()}
      onEdit={mock()}
      onDelete={mock()}
    />,
  );
  expect(screen.getByText(/test-server/)).toBeTruthy();
  expect(screen.getByText("npx -y test")).toBeTruthy();
});

test("connected 状态渲染连接测试按钮与工具数", () => {
  render(
    <McpCard
      config={{ name: "test", command: "echo" }}
      state="connected"
      toolCount={7}
      onTest={mock()}
      onViewTools={mock()}
      onEdit={mock()}
      onDelete={mock()}
    />,
  );
  expect(screen.getByText("连接测试")).toBeTruthy();
  const badge = screen.getByTestId("mcp-state-test");
  expect(badge.textContent).toContain("已连接 · 7 工具");
  expect(badge.getAttribute("data-tone")).toBe("success");
});

test("failed 状态是错误色调，错误信息折叠展示（默认收起）", () => {
  render(
    <McpCard
      config={{ name: "test", command: "echo" }}
      state="failed"
      error="MCP error -32000: Connection closed"
      onTest={noop}
      onViewTools={noop}
      onEdit={noop}
      onDelete={noop}
    />,
  );
  const badge = screen.getByTestId("mcp-state-test");
  expect(badge.textContent).toContain("连接失败");
  expect(badge.getAttribute("data-tone")).toBe("error");
  const detail = screen.getByTestId("mcp-error-test") as HTMLDetailsElement;
  expect(detail.open).toBe(false); // 折叠态
  // 错误文本原样渲染，且不带 ⚠ 前缀（红色样式已承担错误信号）
  const body = screen.getByTestId("mcp-error-body-test");
  expect(body.textContent).toBe("MCP error -32000: Connection closed");
  expect(body.textContent!.startsWith("⚠")).toBe(false);
});

test("disabled（用户主动停用）不是错误样式，文案是「已停用」", () => {
  render(
    <McpCard
      config={{ name: "test", command: "echo" }}
      state="disabled"
      onTest={noop}
      onViewTools={noop}
      onEdit={noop}
      onDelete={noop}
    />,
  );
  const badge = screen.getByTestId("mcp-state-test");
  expect(badge.textContent).toContain("已停用");
  expect(badge.getAttribute("data-tone")).toBe("neutral");
  expect(badge.getAttribute("data-tone")).not.toBe("error");
  // 未停用时不渲染错误块
  expect(screen.queryByTestId("mcp-error-test")).toBeNull();
});

test("needs-auth 显示需登录提示与提示文案", () => {
  render(
    <McpCard
      config={{ name: "test", url: "https://x/mcp" }}
      state="needs-auth"
      onTest={noop}
      onViewTools={noop}
      onEdit={noop}
      onDelete={noop}
    />,
  );
  const badge = screen.getByTestId("mcp-state-test");
  expect(badge.textContent).toContain("需登录");
  expect(badge.getAttribute("data-tone")).toBe("warning");
  expect(screen.getByTestId("mcp-needs-auth-test").textContent).toContain(
    "需要登录",
  );
});

test("state 缺省或未知串 → 状态未知（不硬套连接态）", () => {
  render(
    <McpCard
      config={{ name: "unknown-state", command: "echo" }}
      onTest={noop}
      onViewTools={noop}
      onEdit={noop}
      onDelete={noop}
    />,
  );
  expect(screen.getByTestId("mcp-state-unknown-state").textContent).toContain(
    "状态未知",
  );

  render(
    <McpCard
      config={{ name: "weird-state", command: "echo" }}
      state="whatever-pi-invents"
      onTest={noop}
      onViewTools={noop}
      onEdit={noop}
      onDelete={noop}
    />,
  );
  const badge = screen.getByTestId("mcp-state-weird-state");
  expect(badge.textContent).toContain("状态未知");
  expect(badge.getAttribute("data-tone")).toBe("neutral");
});

test("展示暴露方式标签（title 为一句说明）", () => {
  render(
    <McpCard
      config={{ name: "test", command: "echo", exposure: "codemode" }}
      state="connected"
      onTest={noop}
      onViewTools={noop}
      onEdit={noop}
      onDelete={noop}
    />,
  );
  const tag = screen.getByTestId("mcp-exposure-test");
  expect(tag.textContent).toContain("脚本调用");
  expect(tag.getAttribute("title")).toContain("脚本");
});

test("stateBadge：只有 failed 是错误色调（disabled/unknown 都不是）", () => {
  expect(stateBadge("failed").tone).toBe("error");
  expect(stateBadge("disabled").tone).toBe("neutral");
  expect(stateBadge(undefined).tone).toBe("neutral");
  expect(stateBadge("weird").tone).toBe("neutral");
  expect(stateBadge("connected").tone).toBe("success");
});

test("按钮点击触发对应回调", () => {
  const onEdit = mock();
  const onDelete = mock();
  const onTest = mock();
  render(
    <McpCard
      config={{ name: "test", command: "echo" }}
      state="connected"
      onTest={onTest}
      onViewTools={mock()}
      onEdit={onEdit}
      onDelete={onDelete}
    />,
  );
  const card = screen.getByTestId("mcp-card-test");
  fireEvent.click(within(card).getByText("编辑"));
  expect(onEdit).toHaveBeenCalledTimes(1);
  fireEvent.click(within(card).getByText("删除"));
  expect(onDelete).toHaveBeenCalledTimes(1);
});
