// codemode 三档（系统设置 > 通用）→ 会话 spawn 工具参数的纯函数。
// pi 1.1.0 语义（docs/cli#tools）：
//   - --tools 纯 "+name/-name" 列表 = 增量修改默认选择，不构成白名单；
//   - +name 与普通名不可混用 → 受限白名单路径只能追加普通名 "codemode"。
// off 档的 tool_search 兜底仅排除式路径需要：白名单路径的非 direct MCP 入口工具
// 已由 mcpServerPatternsOf（mcp-tool-names.ts）放行。
import type { CodemodeLevel } from "@wa-pi/shared";

/** agent-manager 组装、buildPiArgs 消费的工具参数（PiLaunchSpec 子集） */
export interface PiToolArgs {
	tools?: string[];
	excludeTools?: string[];
}

export function applyCodemodeToolSelection(
	toolArgs: PiToolArgs,
	level: CodemodeLevel,
	opts: { restricted: boolean; hasDeferredMcp: boolean },
): void {
	if (level !== "off") {
		if (opts.restricted) {
			if (!toolArgs.tools?.includes("codemode")) {
				toolArgs.tools = [...(toolArgs.tools ?? []), "codemode"];
			}
		} else {
			toolArgs.tools = ["+codemode"];
		}
		return;
	}
	if (!opts.restricted && opts.hasDeferredMcp) {
		toolArgs.tools = ["+tool_search"];
	}
}
