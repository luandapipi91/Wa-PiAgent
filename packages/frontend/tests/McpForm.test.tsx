import { test, expect, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { McpForm } from "../src/components/mcp/McpForm";
import type { McpServerConfig } from "@wa-pi/shared";

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

// ===== 环境变量测试 =====

test("stdio 模式显示环境变量区域", () => {
  render(<McpForm onSave={mock()} onCancel={mock()} />);
  expect(screen.getByTestId("mcp-form-env-add")).toBeTruthy();
});

test("HTTP 模式不显示环境变量区域", () => {
  render(<McpForm onSave={mock()} onCancel={mock()} />);
  fireEvent.click(screen.getByTestId("mcp-form-transport-http"));
  expect(screen.queryByTestId("mcp-form-env-add")).toBeNull();
});

test("点击添加按钮新增一行空环境变量", () => {
  render(<McpForm onSave={mock()} onCancel={mock()} />);
  fireEvent.click(screen.getByTestId("mcp-form-env-add"));
  expect(screen.getByTestId("mcp-form-env-key-0")).toBeTruthy();
  expect(screen.getByTestId("mcp-form-env-val-0")).toBeTruthy();
  expect(screen.getByTestId("mcp-form-env-remove-0")).toBeTruthy();
});

test("移除环境变量行", () => {
  render(<McpForm onSave={mock()} onCancel={mock()} />);
  fireEvent.click(screen.getByTestId("mcp-form-env-add"));
  fireEvent.click(screen.getByTestId("mcp-form-env-add"));
  expect(screen.getByTestId("mcp-form-env-key-1")).toBeTruthy();
  // 移除第一行，第二行变为索引 0
  fireEvent.click(screen.getByTestId("mcp-form-env-remove-0"));
  expect(screen.queryByTestId("mcp-form-env-key-1")).toBeNull();
  expect(screen.getByTestId("mcp-form-env-key-0")).toBeTruthy();
});

test("保存时 env 写入 config", () => {
  const onSave = mock();
  render(<McpForm onSave={onSave} onCancel={mock()} />);
  fireEvent.change(screen.getByTestId("mcp-form-name"), { target: { value: "srv" } });
  fireEvent.change(screen.getByTestId("mcp-form-command"), { target: { value: "npx" } });
  fireEvent.click(screen.getByTestId("mcp-form-env-add"));
  fireEvent.change(screen.getByTestId("mcp-form-env-key-0"), { target: { value: " API_KEY " } });
  fireEvent.change(screen.getByTestId("mcp-form-env-val-0"), { target: { value: "secret" } });
  fireEvent.click(screen.getByTestId("mcp-form-save"));
  const saved = onSave.mock.calls[0][0] as McpServerConfig;
  expect(saved.env).toEqual({ API_KEY: "secret" });
});

test("env 为空时不写入 config", () => {
  const onSave = mock();
  render(<McpForm onSave={onSave} onCancel={mock()} />);
  fireEvent.change(screen.getByTestId("mcp-form-name"), { target: { value: "srv" } });
  fireEvent.change(screen.getByTestId("mcp-form-command"), { target: { value: "npx" } });
  fireEvent.click(screen.getByTestId("mcp-form-save"));
  const saved = onSave.mock.calls[0][0] as McpServerConfig;
  expect(saved.env).toBeUndefined();
});

test("编辑已有 env 时预填环境变量", () => {
  render(
    <McpForm
      initial={{
        name: "zai",
        command: "npx",
        args: ["-y", "@z_ai/mcp-server"],
        env: { Z_AI_API_KEY: "sk-xxx", Z_AI_MODE: "ZHIPU" },
      }}
      onSave={mock()}
      onCancel={mock()}
    />,
  );
  expect((screen.getByTestId("mcp-form-env-key-0") as HTMLInputElement).value).toBe("Z_AI_API_KEY");
  expect((screen.getByTestId("mcp-form-env-val-0") as HTMLInputElement).value).toBe("sk-xxx");
  expect((screen.getByTestId("mcp-form-env-key-1") as HTMLInputElement).value).toBe("Z_AI_MODE");
  expect((screen.getByTestId("mcp-form-env-val-1") as HTMLInputElement).value).toBe("ZHIPU");
});

test("env key 为空时被跳过不写入", () => {
  const onSave = mock();
  render(<McpForm onSave={onSave} onCancel={mock()} />);
  fireEvent.change(screen.getByTestId("mcp-form-name"), { target: { value: "srv" } });
  fireEvent.change(screen.getByTestId("mcp-form-command"), { target: { value: "npx" } });
  fireEvent.click(screen.getByTestId("mcp-form-env-add"));
  fireEvent.change(screen.getByTestId("mcp-form-env-val-0"), { target: { value: "orphan" } });
  fireEvent.click(screen.getByTestId("mcp-form-save"));
  const saved = onSave.mock.calls[0][0] as McpServerConfig;
  expect(saved.env).toBeUndefined();
});
