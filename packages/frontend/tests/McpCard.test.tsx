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
      onLogin={noop}
      onLogout={noop}
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
      onLogin={noop}
      onLogout={noop}
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
      onLogin={noop}
      onLogout={noop}
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
      onLogin={noop}
      onLogout={noop}
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
      onLogin={noop}
      onLogout={noop}
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
      onLogin={noop}
      onLogout={noop}
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
      onLogin={noop}
      onLogout={noop}
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
      onLogin={noop}
      onLogout={noop}
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
      onLogin={noop}
      onLogout={noop}
    />,
  );
  const card = screen.getByTestId("mcp-card-test");
  fireEvent.click(within(card).getByText("编辑"));
  expect(onEdit).toHaveBeenCalledTimes(1);
  fireEvent.click(within(card).getByText("删除"));
  expect(onDelete).toHaveBeenCalledTimes(1);
});

// ===== OAuth 登录 / 登出（规格 F19/F20）=====
//
// 关键语义：登录按钮只对「HTTP 且**确认未登录**」的 server 出现。pi 自己会打开一次
// 系统浏览器（无法抑制）→ 卡片只展示 + 可复制授权 URL，不自动再打开一次。

const AUTH_URL = "http://127.0.0.1:59998/authorize?client_id=x";

/** 造一个 HTTP server 的卡片（登录相关用例的基底） */
function renderHttpCard(props: Record<string, unknown> = {}) {
  return render(
    <McpCard
      config={{ name: "test", url: "https://host/mcp" }}
      state="needs-auth"
      onTest={noop}
      onViewTools={noop}
      onEdit={noop}
      onDelete={noop}
      onLogin={noop}
      onLogout={noop}
      {...(props as any)}
    />,
  );
}

test("HTTP 且未登录（signedIn=false）→ 显示登录按钮与超时输入，不显示登出", () => {
  renderHttpCard({ signedIn: false });
  expect(screen.getByTestId("mcp-login-test")).toBeTruthy();
  expect((screen.getByTestId("mcp-login-timeout-test") as HTMLInputElement).value).toBe(
    "300",
  );
  expect(screen.queryByTestId("mcp-logout-test")).toBeNull();
});

test("HTTP 且已登录（signedIn=true）→ 显示登出按钮，不显示登录", () => {
  renderHttpCard({ signedIn: true });
  expect(screen.getByTestId("mcp-logout-test")).toBeTruthy();
  expect(screen.queryByTestId("mcp-login-test")).toBeNull();
  expect(screen.queryByTestId("mcp-login-timeout-test")).toBeNull();
});

test("stdio（无 url）→ 不显示登录也不显示登出（pi 会报 does not use OAuth）", () => {
  render(
    <McpCard
      config={{ name: "test", command: "echo" }}
      state="needs-auth"
      signedIn={false}
      onTest={noop}
      onViewTools={noop}
      onEdit={noop}
      onDelete={noop}
      onLogin={noop}
      onLogout={noop}
    />,
  );
  expect(screen.queryByTestId("mcp-login-test")).toBeNull();
  expect(screen.queryByTestId("mcp-logout-test")).toBeNull();
});

test("登录态未知（signedIn 缺省）→ 两边都不显示，不靠猜", () => {
  renderHttpCard();
  expect(screen.queryByTestId("mcp-login-test")).toBeNull();
  expect(screen.queryByTestId("mcp-logout-test")).toBeNull();
});

test("点登录 → onLogin 收到输入框里的秒数；超时输入可改", () => {
  const onLogin = mock();
  renderHttpCard({ signedIn: false, onLogin });
  fireEvent.change(screen.getByTestId("mcp-login-timeout-test"), {
    target: { value: "60" },
  });
  fireEvent.click(screen.getByTestId("mcp-login-test"));
  expect(onLogin).toHaveBeenCalledWith(60);
});

test("超时输入被清空 / 写成非正数 → onLogin 不带秒数（交给 kernel 的缺省值）", () => {
  const onLogin = mock();
  renderHttpCard({ signedIn: false, onLogin });
  const input = screen.getByTestId("mcp-login-timeout-test");
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.click(screen.getByTestId("mcp-login-test"));
  fireEvent.change(input, { target: { value: "0" } });
  fireEvent.click(screen.getByTestId("mcp-login-test"));
  expect(onLogin.mock.calls).toEqual([[undefined], [undefined]]);
});

test("超时输入写成超大值 → 按上限提交（溢出会 1ms 秒杀 pi，REST 也会 400）", () => {
  const onLogin = mock();
  renderHttpCard({ signedIn: false, onLogin });
  const input = screen.getByTestId("mcp-login-timeout-test") as HTMLInputElement;
  // 输入框必须声明上界（原生提示），否则用户能直接输入 1e9
  expect(input.type).toBe("number");
  expect(input.max).toBe("3600");
  // 手打字 / 粘贴能绕过 max → 提交前再 clamp 一次
  fireEvent.change(input, { target: { value: "1000000000" } });
  fireEvent.click(screen.getByTestId("mcp-login-test"));
  expect(onLogin.mock.calls).toEqual([[3600]]);
});

test("点登出 → onLogout 被调用", () => {
  const onLogout = mock();
  renderHttpCard({ signedIn: true, onLogout });
  fireEvent.click(screen.getByTestId("mcp-logout-test"));
  expect(onLogout).toHaveBeenCalledTimes(1);
});

test("登录中：显示等待授权、进度行与授权 URL，可复制；登录按钮置灰", () => {
  const writeText = mock();
  (window as any).waPiClipboard = { writeText, writeImage: mock() };
  renderHttpCard({
    signedIn: false,
    loginState: {
      pending: true,
      progress: 'Sign in to MCP server "test" in your browser:',
      url: AUTH_URL,
    },
  });

  expect(screen.getByTestId("mcp-login-waiting-test").textContent).toContain(
    "等待浏览器授权",
  );
  expect(screen.getByTestId("mcp-login-progress-test").textContent).toContain(
    "Sign in to MCP server",
  );
  expect(screen.getByTestId("mcp-login-url-test").textContent).toBe(AUTH_URL);
  expect((screen.getByTestId("mcp-login-test") as HTMLButtonElement).disabled).toBe(
    true,
  );

  fireEvent.click(screen.getByTestId("mcp-login-copy-test"));
  expect(writeText).toHaveBeenCalledWith(AUTH_URL);
  delete (window as any).waPiClipboard;
});

test("登录失败：显示错误文案（不再显示「等待授权」）", () => {
  renderHttpCard({
    signedIn: false,
    loginState: { pending: false, error: "cancelled or not completed within 3 seconds" },
  });
  expect(screen.getByTestId("mcp-login-error-test").textContent).toBe(
    "cancelled or not completed within 3 seconds",
  );
  expect(screen.queryByTestId("mcp-login-waiting-test")).toBeNull();
});
