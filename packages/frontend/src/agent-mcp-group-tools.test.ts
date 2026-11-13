import { expect, test } from "bun:test";
import {
	expandChecked,
	isMcpServerWildcard,
	toggleNames,
} from "./agent-mcp-group-tools";

// 智能体 MCP 分组勾选的纯函数契约（含「服务器粒度通配」语义——
// 存量智能体回填的 mcp__agent_browser__* 视作整组开启，见 kernel config-store 回填迁移）。

const ALL = [
	"read",
	"grep",
	"mcp__agent_browser__navigate",
	"mcp__agent_browser__close",
	"mcp__dbx__query",
];

test("isMcpServerWildcard：仅 mcp__ 前缀且 __* 结尾的条目算服务器通配", () => {
	expect(isMcpServerWildcard("mcp__agent_browser__*")).toBe(true);
	expect(isMcpServerWildcard("mcp__agent_browser__navigate")).toBe(false);
	expect(isMcpServerWildcard("read")).toBe(false);
	expect(isMcpServerWildcard("mcp__")).toBe(false);
});

test("expandChecked：空数组 = 全量默认（kernel 语义）", () => {
	expect(expandChecked([], ALL)).toEqual(ALL);
});

test("expandChecked：服务器通配展开为该组全部已知工具名（展示为整组开启）", () => {
	const checked = expandChecked(["read", "mcp__agent_browser__*"], ALL);
	expect(checked).toContain("read");
	expect(checked).toContain("mcp__agent_browser__navigate");
	expect(checked).toContain("mcp__agent_browser__close");
	expect(checked).not.toContain("mcp__agent_browser__*");
});

test("expandChecked：通配覆盖不到的组不受影响（未知/未连服务器展开为空）", () => {
	const checked = expandChecked(["read", "mcp__nope__*"], ALL);
	expect(checked).toEqual(["read"]);
});

test("toggleNames：通配整组开启时点组开关 → 全组关闭且通配摘除", () => {
	const next = toggleNames(
		["read", "mcp__agent_browser__*"],
		ALL,
		["mcp__agent_browser__navigate", "mcp__agent_browser__close"],
	);
	expect(next).toEqual(["read"]);
});

test("toggleNames：通配组内单关一个工具 → 通配让位精确名（否则 pi 侧照旧放行）", () => {
	const next = toggleNames(
		["read", "mcp__agent_browser__*"],
		ALL,
		["mcp__agent_browser__navigate"],
	);
	expect(next).toContain("mcp__agent_browser__close");
	expect(next).not.toContain("mcp__agent_browser__navigate");
	expect(next).not.toContain("mcp__agent_browser__*");
	expect(next).toContain("read");
});

test("toggleNames：无关组的切换保留通配（迁移回填态不因无关操作丢失）", () => {
	const next = toggleNames(
		["read", "mcp__agent_browser__*"],
		ALL,
		["mcp__dbx__query"],
	);
	expect(next).toContain("mcp__agent_browser__*");
	expect(next).toContain("mcp__dbx__query");
	expect(next).toContain("read");
});

test("toggleNames：组关闭→整组开启补精确名（规范化表示，不写入新通配）", () => {
	const next = toggleNames(
		["read"],
		ALL,
		["mcp__agent_browser__navigate", "mcp__agent_browser__close"],
	);
	expect(next).toContain("mcp__agent_browser__navigate");
	expect(next).toContain("mcp__agent_browser__close");
	expect(next).not.toContain("mcp__agent_browser__*");
	expect(next).toContain("read");
});
