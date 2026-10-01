import { test, expect, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { McpForm } from "../src/components/mcp/McpForm";
import {
  MCP_EXPOSURES,
  exposureDescKey,
  exposureLabelKey,
} from "../src/components/mcp/exposure";
import i18n from "../src/i18n";
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

test("HTTP 传输可编辑 Authorization 之外的请求头（headers 任意键）", () => {
  const onSave = mock();
  render(
    <McpForm
      initial={{
        name: "zread",
        url: "https://x/mcp",
        headers: { "X-API-Key": "k1", Authorization: "Bearer abc" },
      }}
      onSave={onSave}
      onCancel={mock()}
    />,
  );
  // Authorization 走专属输入框，其余请求头在可编辑行里往返
  expect((screen.getByTestId("mcp-form-header-key-0") as HTMLInputElement).value).toBe("X-API-Key");
  expect((screen.getByTestId("mcp-form-header-val-0") as HTMLInputElement).value).toBe("k1");
  fireEvent.change(screen.getByTestId("mcp-form-header-val-0"), { target: { value: "k2" } });
  fireEvent.click(screen.getByTestId("mcp-form-save"));
  const saved = onSave.mock.calls[0][0] as McpServerConfig;
  expect(saved.headers).toEqual({ "X-API-Key": "k2", Authorization: "Bearer abc" });
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

// ===== 暴露方式（exposure，规格 §4.2）：五档 + 默认 direct =====

test("exposure 下拉包含官方五个取值（顺序固定）", () => {
  render(<McpForm onSave={mock()} onCancel={mock()} />);
  const select = screen.getByTestId("mcp-form-exposure");
  expect(
    [...select.querySelectorAll("option")].map((o) => o.getAttribute("value")),
  ).toEqual([
    "direct",
    "codemode",
    "codemode-deferred",
    "deferred",
    "hidden",
  ]);
});

test("新建服务器默认 exposure 为 direct（规格 §4.2 产品决策）", () => {
  render(<McpForm onSave={mock()} onCancel={mock()} />);
  expect((screen.getByTestId("mcp-form-exposure") as HTMLSelectElement).value).toBe(
    "direct",
  );
});

test("新建服务器保存时写入 exposure=direct", () => {
  const onSave = mock();
  render(<McpForm onSave={onSave} onCancel={mock()} />);
  fireEvent.change(screen.getByTestId("mcp-form-name"), { target: { value: "srv" } });
  fireEvent.change(screen.getByTestId("mcp-form-command"), { target: { value: "npx" } });
  fireEvent.click(screen.getByTestId("mcp-form-save"));
  expect((onSave.mock.calls[0][0] as McpServerConfig).exposure).toBe("direct");
});

test("编辑已有 exposure 时预填，且切换档位后说明文案跟随", () => {
  render(
    <McpForm
      initial={{ name: "srv", command: "npx", exposure: "deferred" }}
      onSave={mock()}
      onCancel={mock()}
    />,
  );
  const select = screen.getByTestId("mcp-form-exposure") as HTMLSelectElement;
  expect(select.value).toBe("deferred");
  expect(screen.getByTestId("mcp-form-exposure-desc").textContent).toContain("检索");
  fireEvent.change(select, { target: { value: "hidden" } });
  expect(select.value).toBe("hidden");
  expect(screen.getByTestId("mcp-form-exposure-desc").textContent).toContain(
    "看不到",
  );
});

test("五档都有可读的短标签与说明（不留裸值）", () => {
  render(<McpForm onSave={mock()} onCancel={mock()} />);
  const select = screen.getByTestId("mcp-form-exposure") as HTMLSelectElement;
  const labels = [...select.querySelectorAll("option")].map((o) => o.textContent ?? "");
  for (const label of labels) {
    expect(label.length).toBeGreaterThan(0);
    // i18n 未命中时会渲染成裸的 key（含 "exposure"）
    expect(label).not.toContain("exposure");
    expect(label).not.toContain("mcpForm");
  }
});

test("五档 exposure 的中英文案齐全且各不相同", () => {
  for (const lng of ["zh", "en"]) {
    const seen = new Set<string>();
    for (const e of MCP_EXPOSURES) {
      const label = i18n.t(exposureLabelKey(e), { lng });
      const desc = i18n.t(exposureDescKey(e), { lng });
      expect(label).not.toBe(exposureLabelKey(e));
      expect(desc).not.toBe(exposureDescKey(e));
      expect(desc).not.toContain("mcpForm");
      expect(desc.length).toBeGreaterThan(6);
      seen.add(desc);
    }
    // 每档一句不同的话，而不是五档同一句
    expect(seen.size).toBe(MCP_EXPOSURES.length);
  }
});

test("逐工具暴露方式用「工具名 + 取值」行编辑器写入 toolExposure", () => {
  const onSave = mock();
  render(
    <McpForm
      initial={{ name: "srv", command: "npx", exposure: "codemode" }}
      onSave={onSave}
      onCancel={mock()}
    />,
  );
  fireEvent.click(screen.getByTestId("mcp-form-tool-exposure-add"));
  fireEvent.change(screen.getByTestId("mcp-form-tool-exposure-name-0"), {
    target: { value: "query" },
  });
  fireEvent.change(screen.getByTestId("mcp-form-tool-exposure-value-0"), {
    target: { value: "direct" },
  });
  fireEvent.click(screen.getByTestId("mcp-form-save"));
  const saved = onSave.mock.calls[0][0] as McpServerConfig;
  expect(saved.toolExposure).toEqual({ query: "direct" });
  expect(saved.exposure).toBe("codemode");
});

test("编辑已有 toolExposure 时预填，可移除整行", () => {
  const onSave = mock();
  render(
    <McpForm
      initial={{
        name: "srv",
        command: "npx",
        toolExposure: { query: "hidden" },
      }}
      onSave={onSave}
      onCancel={mock()}
    />,
  );
  expect(
    (screen.getByTestId("mcp-form-tool-exposure-name-0") as HTMLInputElement).value,
  ).toBe("query");
  fireEvent.click(screen.getByTestId("mcp-form-tool-exposure-remove-0"));
  fireEvent.click(screen.getByTestId("mcp-form-save"));
  const saved = onSave.mock.calls[0][0] as McpServerConfig;
  expect(saved.toolExposure).toBeUndefined();
});

// ===== 字段：cwd / enabled / timeout（秒） =====

test("cwd 与 enabled 写入 config（enabled=false 表示用户主动停用）", () => {
  const onSave = mock();
  render(
    <McpForm
      initial={{ name: "srv", command: "npx", cwd: "/tmp/w" }}
      onSave={onSave}
      onCancel={mock()}
    />,
  );
  expect((screen.getByTestId("mcp-form-cwd") as HTMLInputElement).value).toBe("/tmp/w");
  fireEvent.click(screen.getByTestId("mcp-form-enabled"));
  fireEvent.click(screen.getByTestId("mcp-form-save"));
  const saved = onSave.mock.calls[0][0] as McpServerConfig;
  expect(saved.cwd).toBe("/tmp/w");
  expect(saved.enabled).toBe(false);
});

test("timeout 以秒为单位写入 config", () => {
  const onSave = mock();
  render(<McpForm onSave={onSave} onCancel={mock()} />);
  fireEvent.change(screen.getByTestId("mcp-form-name"), { target: { value: "srv" } });
  fireEvent.change(screen.getByTestId("mcp-form-command"), { target: { value: "npx" } });
  fireEvent.change(screen.getByTestId("mcp-form-timeout"), { target: { value: "45" } });
  fireEvent.click(screen.getByTestId("mcp-form-save"));
  expect((onSave.mock.calls[0][0] as McpServerConfig).timeout).toBe(45);
});

test("timeout 清空后不写该字段（不是写 0）", () => {
  const onSave = mock();
  render(
    <McpForm
      initial={{ name: "srv", command: "npx", timeout: 30 }}
      onSave={onSave}
      onCancel={mock()}
    />,
  );
  expect((screen.getByTestId("mcp-form-timeout") as HTMLInputElement).value).toBe("30");
  fireEvent.change(screen.getByTestId("mcp-form-timeout"), { target: { value: "" } });
  fireEvent.click(screen.getByTestId("mcp-form-save"));
  const saved = onSave.mock.calls[0][0] as McpServerConfig;
  expect(saved.timeout).toBeUndefined();
});

// ===== 字段级校验错误绑定 =====

// 注：传输类型是二选一开关（stdio→command，HTTP→url），表单不可能同时带上 command 与 url，
// 所以「互斥」在这里的可达表现是「两者都没填」——同样报 validateMcpServer 的互斥文案。
test("command 与 url 都没有时给出字段级提示（不提交）", () => {
  const onSave = mock();
  render(<McpForm initial={{ name: "c" }} onSave={onSave} onCancel={mock()} />);
  fireEvent.click(screen.getByTestId("mcp-form-save"));
  expect(screen.getByTestId("mcp-form-error-command").textContent).toContain(
    "必须且只能提供",
  );
  expect(onSave).not.toHaveBeenCalled();
});

test("服务器名非法时提示绑在名称字段（本地校验先拦）", () => {
  const onSave = mock();
  render(<McpForm onSave={onSave} onCancel={mock()} />);
  fireEvent.change(screen.getByTestId("mcp-form-name"), {
    target: { value: "bad name!" },
  });
  fireEvent.change(screen.getByTestId("mcp-form-command"), {
    target: { value: "npx" },
  });
  fireEvent.click(screen.getByTestId("mcp-form-save"));
  expect(screen.getByTestId("mcp-form-error-name").textContent).toContain(
    "只允许字母",
  );
  expect(onSave).not.toHaveBeenCalled();
});

test("服务器返回的 400 字段级 errors 绑到对应输入框（不是只弹一个总错误）", async () => {
  const onSave = mock(() =>
    Promise.resolve({
      ok: false as const,
      errors: [{ field: "name", message: "只允许字母、数字、下划线与连字符" }],
    }),
  );
  render(
    <McpForm
      initial={{ name: "srv", command: "npx" }}
      onSave={onSave}
      onCancel={mock()}
    />,
  );
  fireEvent.click(screen.getByTestId("mcp-form-save"));
  expect(await screen.findByTestId("mcp-form-error-name")).toBeTruthy();
  expect(screen.getByTestId("mcp-form-error-name").textContent).toBe(
    "只允许字母、数字、下划线与连字符",
  );
  // 有字段级错误时不再重复整体提示
  expect(screen.queryByTestId("mcp-form-error")).toBeNull();
});

test("非字段级错误（如原服务器不存在）显示整体提示", async () => {
  const onSave = mock(() =>
    Promise.resolve({
      ok: false as const,
      message: "原服务器 old 不存在，无法重命名",
    }),
  );
  render(
    <McpForm
      initial={{ name: "srv", command: "npx" }}
      onSave={onSave}
      onCancel={mock()}
    />,
  );
  fireEvent.click(screen.getByTestId("mcp-form-save"));
  expect(await screen.findByTestId("mcp-form-error")).toBeTruthy();
  expect(screen.getByTestId("mcp-form-error").textContent).toContain("不存在");
});

test("改名时把原名作为 originalName 交给调用方", () => {
  const onSave = mock();
  render(
    <McpForm
      initial={{ name: "old", command: "npx" }}
      onSave={onSave}
      onCancel={mock()}
    />,
  );
  fireEvent.change(screen.getByTestId("mcp-form-name"), { target: { value: "new" } });
  fireEvent.click(screen.getByTestId("mcp-form-save"));
  expect(onSave.mock.calls[0][0]).toMatchObject({ name: "new" });
  expect(onSave.mock.calls[0][1]).toBe("old");
});

test("未改名时不传 originalName", () => {
  const onSave = mock();
  render(
    <McpForm initial={{ name: "old", command: "npx" }} onSave={onSave} onCancel={mock()} />,
  );
  fireEvent.click(screen.getByTestId("mcp-form-save"));
  expect(onSave.mock.calls[0][1]).toBeUndefined();
});
