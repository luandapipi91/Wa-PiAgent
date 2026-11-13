// 内置 agent-browser 卡片：无编辑/删除、停用 switch、浏览器缺失时的安装入口。
// 本仓库组件测试统一用 bun:test + @testing-library/react（见 ExtensionSection.test.tsx）。
import { beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { McpCard } from "../McpCard";

const base = {
  name: "agent-browser",
  command: "/bin/agent-browser",
  args: ["mcp"],
  enabled: true,
  builtin: true,
} as never;

const noop = () => {};
const baseProps = {
  config: base,
  builtin: true,
  onTest: noop,
  onViewTools: noop,
  onEdit: noop,
  onDelete: noop,
  onToggleEnabled: noop,
  onLogin: noop,
  onLogout: noop,
};

describe("McpCard 内置条目", () => {
  beforeEach(() => cleanup());

  test("没有编辑与删除按钮，但有启停 switch", () => {
    render(<McpCard {...baseProps} />);
    expect(screen.queryByTestId("mcp-edit-agent-browser")).toBeNull();
    expect(screen.queryByTestId("mcp-delete-agent-browser")).toBeNull();
    expect(screen.getByTestId("mcp-switch-agent-browser")).toBeTruthy();
  });

  test("点击 switch 调 onToggleEnabled(false)", () => {
    const calls: boolean[] = [];
    render(
      <McpCard
        {...baseProps}
        onToggleEnabled={(enabled: boolean) => {
          calls.push(enabled);
        }}
      />,
    );
    fireEvent.click(screen.getByTestId("mcp-switch-agent-browser"));
    expect(calls).toEqual([false]);
  });

  test("missing 时出现安装按钮，ready 时不出现", () => {
    const { rerender } = render(
      <McpCard {...baseProps} browserStatus={{ state: "missing" }} onInstall={noop} />,
    );
    expect(screen.getByTestId("mcp-install-browser-agent-browser")).toBeTruthy();
    rerender(
      <McpCard {...baseProps} browserStatus={{ state: "ready" }} onInstall={noop} />,
    );
    expect(screen.queryByTestId("mcp-install-browser-agent-browser")).toBeNull();
  });

  test("安装中按钮禁用并展示最新进度", () => {
    render(
      <McpCard
        {...baseProps}
        browserStatus={{ state: "missing" }}
        installing
        installLog={["Downloading Chrome…"]}
        onInstall={noop}
      />,
    );
    const btn = screen.getByTestId("mcp-install-browser-agent-browser") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText("Downloading Chrome…")).toBeTruthy();
  });
});

describe("McpCard 内置条目启停形态", () => {
  beforeEach(() => cleanup());

  test("启停是视觉 switch（data-on 暴露开关态），不再是「停用/启用」文字按钮", () => {
    render(<McpCard {...baseProps} />);
    const sw = screen.getByTestId("mcp-switch-agent-browser");
    expect(sw.getAttribute("data-on")).toBe("true");
    expect(screen.queryByText("停用")).toBeNull();
    expect(screen.queryByText("启用")).toBeNull();
  });

  test("停用态 switch data-on=false", () => {
    render(
      <McpCard
        {...baseProps}
        config={{ ...(base as object), enabled: false } as never}
      />,
    );
    expect(
      screen.getByTestId("mcp-switch-agent-browser").getAttribute("data-on"),
    ).toBe("false");
  });
});
