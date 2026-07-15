import { test, expect, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { McpForm } from "../src/components/mcp/McpForm";
import type { McpServerConfig } from "@hiagent/shared";

test("编辑 HTTP 服务器时 Authorization 预填已有 headers（不丢失）", () => {
  render(
    <McpForm
      initial={{
        name: "zread",
        url: "https://open.bigmodel.cn/api/mcp/zread/mcp",
        headers: { Authorization: "Bearer abc123" },
      }}
      onSave={mock()}
      onCancel={mock()}
    />,
  );
  expect((screen.getByTestId("mcp-form-auth") as HTMLInputElement).value).toBe("Bearer abc123");
});

test("保存 HTTP 服务器时把 Authorization 写入 config.headers", () => {
  const onSave = mock();
  render(
    <McpForm
      initial={{ name: "zread", url: "https://x/mcp", headers: { Authorization: "Bearer abc123" } }}
      onSave={onSave}
      onCancel={mock()}
    />,
  );
  fireEvent.click(screen.getByTestId("mcp-form-save"));
  const saved = onSave.mock.calls[0][0] as McpServerConfig;
  expect(saved.headers?.Authorization).toBe("Bearer abc123");
});

test("Authorization 输入纯 token（无 scheme）时自动补 Bearer 前缀", () => {
  const onSave = mock();
  render(<McpForm onSave={onSave} onCancel={mock()} />);
  fireEvent.change(screen.getByTestId("mcp-form-name"), { target: { value: "srv" } });
  fireEvent.click(screen.getByTestId("mcp-form-transport-http"));
  fireEvent.change(screen.getByTestId("mcp-form-url"), { target: { value: "https://x/mcp" } });
  fireEvent.change(screen.getByTestId("mcp-form-auth"), { target: { value: "mytoken" } });
  fireEvent.click(screen.getByTestId("mcp-form-save"));
  const saved = onSave.mock.calls[0][0] as McpServerConfig;
  expect(saved.headers?.Authorization).toBe("Bearer mytoken");
});

test("Authorization 已带 scheme 时不重复加 Bearer", () => {
  const onSave = mock();
  render(<McpForm onSave={onSave} onCancel={mock()} />);
  fireEvent.change(screen.getByTestId("mcp-form-name"), { target: { value: "srv" } });
  fireEvent.click(screen.getByTestId("mcp-form-transport-http"));
  fireEvent.change(screen.getByTestId("mcp-form-url"), { target: { value: "https://x/mcp" } });
  fireEvent.change(screen.getByTestId("mcp-form-auth"), { target: { value: "Bearer mytoken" } });
  fireEvent.click(screen.getByTestId("mcp-form-save"));
  const saved = onSave.mock.calls[0][0] as McpServerConfig;
  expect(saved.headers?.Authorization).toBe("Bearer mytoken");
});

test("Authorization 为空时不写 headers", () => {
  const onSave = mock();
  render(<McpForm onSave={onSave} onCancel={mock()} />);
  fireEvent.change(screen.getByTestId("mcp-form-name"), { target: { value: "srv" } });
  fireEvent.click(screen.getByTestId("mcp-form-transport-http"));
  fireEvent.change(screen.getByTestId("mcp-form-url"), { target: { value: "https://x/mcp" } });
  fireEvent.click(screen.getByTestId("mcp-form-save"));
  const saved = onSave.mock.calls[0][0] as McpServerConfig;
  expect(saved.headers).toBeUndefined();
});

test("stdio 传输不显示 Authorization 字段", () => {
  render(<McpForm onSave={mock()} onCancel={mock()} />);
  // 默认 stdio
  expect(screen.queryByTestId("mcp-form-auth")).toBeNull();
});
