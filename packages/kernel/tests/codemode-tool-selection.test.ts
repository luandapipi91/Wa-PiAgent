import { test, expect } from "bun:test";
import { applyCodemodeToolSelection, type PiToolArgs } from "../src/codemode";

// 档位 → spawn 工具参数的纯函数。pi 1.1.0 语义：--tools 的 +name/-name 增量
// 条目不构成白名单（仅改默认选择），但与普通名禁止混用——所以排除式路径用
// ["+codemode"]，受限白名单路径只能追加普通名 "codemode"。

test("排除式 + compat：tools = ['+codemode']，excludeTools 不动", () => {
	const args: PiToolArgs = { excludeTools: ["subagent"] };
	applyCodemodeToolSelection(args, "compat", {
		restricted: false,
		hasDeferredMcp: false,
	});
	expect(args.tools).toEqual(["+codemode"]);
	expect(args.excludeTools).toEqual(["subagent"]);
});

test("白名单 + compat：追加普通名 codemode，既有清单不动", () => {
	const args: PiToolArgs = { tools: ["im_push_to", "read"] };
	applyCodemodeToolSelection(args, "compat", {
		restricted: true,
		hasDeferredMcp: false,
	});
	expect(args.tools).toEqual(["im_push_to", "read", "codemode"]);
});

test("白名单 + compat：已有 codemode 不重复追加", () => {
	const args: PiToolArgs = { tools: ["read", "codemode"] };
	applyCodemodeToolSelection(args, "compat", {
		restricted: true,
		hasDeferredMcp: false,
	});
	expect(args.tools).toEqual(["read", "codemode"]);
});

test("排除式 + off + 有 codemode 曝光 MCP：tools = ['+tool_search'] 兜底", () => {
	const args: PiToolArgs = { excludeTools: ["subagent"] };
	applyCodemodeToolSelection(args, "off", {
		restricted: false,
		hasDeferredMcp: true,
	});
	expect(args.tools).toEqual(["+tool_search"]);
	expect(args.excludeTools).toEqual(["subagent"]);
});

test("排除式 + off + 有 deferred 曝光 MCP：同样兜底", () => {
	const args: PiToolArgs = {};
	applyCodemodeToolSelection(args, "off", {
		restricted: false,
		hasDeferredMcp: true,
	});
	expect(args.tools).toEqual(["+tool_search"]);
});

test("排除式 + off + 无 MCP：不注入 tools（现状）", () => {
	const args: PiToolArgs = { excludeTools: ["subagent"] };
	applyCodemodeToolSelection(args, "off", {
		restricted: false,
		hasDeferredMcp: false,
	});
	expect(args.tools).toBeUndefined();
});

test("白名单 + off：不动（MCP 入口工具已由 mcpServerPatternsOf 放行）", () => {
	const args: PiToolArgs = { tools: ["im_push_to", "read"] };
	applyCodemodeToolSelection(args, "off", {
		restricted: true,
		hasDeferredMcp: true,
	});
	expect(args.tools).toEqual(["im_push_to", "read"]);
});
