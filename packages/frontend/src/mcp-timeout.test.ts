// mcp-timeout.test.ts — MCP 面板请求超时与 kernel 上限的层级契约
//
// 背景：MCP 面板的状态读取走真实 spawn `pi mcp list`（kernel McpAdmin 缺省上限 70s，
// 见 kernel/src/mcp-admin.ts DEFAULT_LIST_TIMEOUT_MS；pi 引擎单台慢 server 可耗 60s+）。
// 前端这些请求必须等得比 kernel 更久，否则 kernel 还在读状态、前端先把请求掐了
// ——表现为「加载中…」后列表空白（一台坏 server 拖垮整个面板）。
import { test, expect } from "bun:test";
import { MCP_RPC_TIMEOUT_MS } from "./api-client";

test("MCP 面板请求超时必须大于 kernel 缺省 list 上限（70s）", () => {
	expect(MCP_RPC_TIMEOUT_MS).toBeGreaterThan(70_000);
});
