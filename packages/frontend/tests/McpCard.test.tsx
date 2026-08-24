import { test, expect, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { McpCard } from "../src/components/mcp/McpCard";

test("渲染 server 名称、描述行", () => {
    render(
        <McpCard
            config={{
                name: "test-server",
                command: "npx",
                args: ["-y", "test"],
            }}
            status="disconnected"
            onTest={mock()}
            onViewTools={mock()}
            onEdit={mock()}
            onDelete={mock()}
        />,
    );
    expect(screen.getByText(/test-server/)).toBeTruthy();
    expect(screen.getByText("npx -y test")).toBeTruthy();
});

test("disconnected 状态渲染连接测试按钮", () => {
    render(
        <McpCard
            config={{ name: "test", command: "echo" }}
            status="disconnected"
            onTest={mock()}
            onViewTools={mock()}
            onEdit={mock()}
            onDelete={mock()}
        />,
    );
    expect(screen.getByText("连接测试")).toBeTruthy();
});

test("connected 状态仍显示连接测试按钮（可重新测试）", () => {
    render(
        <McpCard
            config={{ name: "test", command: "echo" }}
            status="connected"
            onTest={mock()}
            onViewTools={mock()}
            onEdit={mock()}
            onDelete={mock()}
        />,
    );
    expect(screen.getByText("连接测试")).toBeTruthy();
});

test("错误信息渲染不带 ⚠ 前缀（红色 danger 样式已承担错误信号）", () => {
    render(
        <McpCard
            config={{ name: "test", command: "echo" }}
            status="disconnected"
            error="MCP error -32000: Connection closed"
            onTest={mock()}
            onViewTools={mock()}
            onEdit={mock()}
            onDelete={mock()}
        />,
    );
    const el = screen.getByTestId("mcp-error-test");
    expect(el.textContent).toBe("MCP error -32000: Connection closed");
    expect(el.textContent!.startsWith("⚠")).toBe(false);
});

test("按钮点击触发对应回调", () => {
    const onEdit = mock();
    const onDelete = mock();
    const onTest = mock();
    render(
        <McpCard
            config={{ name: "test", command: "echo" }}
            status="disconnected"
            onTest={onTest}
            onViewTools={mock()}
            onEdit={onEdit}
            onDelete={onDelete}
        />,
    );
    fireEvent.click(screen.getByText("编辑"));
    expect(onEdit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("删除"));
    expect(onDelete).toHaveBeenCalledTimes(1);
});
