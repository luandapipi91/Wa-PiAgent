/**
 * 智能体工具勾选的纯函数（普通工具 tab 与 MCP tab 共用）。
 *
 * 从 AgentConfig.tsx 提出以便单测；核心语义：
 * - draft.tools 空数组 = 全量默认（kernel 语义：不传 --tools，pi 全放行）；
 * - 服务器粒度通配（pi 1.0.4+ `--tools` 语义，形如 `mcp__agent_browser__*`）视为
 *   「该服务器整组开启」——kernel 启动迁移给存量受限智能体回填的就是这个条目
 *   （见 kernel config-store.migrateAgentBrowserTools），UI 必须同样把它认作开启，
 *   且用户从该组摘掉任何工具时通配要同步让位精确名，否则 pi 侧通配继续放行、
 *   UI 却显示已关（开关失真）。
 */

/** 仅 `mcp__` 前缀且 `__*` 结尾的条目算服务器粒度通配 */
export function isMcpServerWildcard(name: string): boolean {
	return name.startsWith("mcp__") && name.endsWith("__*");
}

/** 通配的覆盖前缀：`mcp__agent_browser__*` → `mcp__agent_browser__` */
function mcpWildcardPrefix(wildcard: string): string {
	return wildcard.slice(0, -1);
}

/**
 * 展示态勾选集：tools 空数组 = 全量默认；显式白名单里的服务器通配展开为
 * 该组全部**已知**工具名（`all` 里前缀匹配者）。通配本身不进展示集。
 * 覆盖不到任何已知名字的通配（服务器未连上/未枚举）展开为空，无害。
 */
export function expandChecked(tools: string[], all: string[]): string[] {
	if (tools.length === 0) return all;
	const out: string[] = [];
	for (const t of tools) {
		if (isMcpServerWildcard(t)) {
			const prefix = mcpWildcardPrefix(t);
			for (const a of all) {
				if (a.startsWith(prefix) && !out.includes(a)) out.push(a);
			}
		} else if (!out.includes(t)) {
			out.push(t);
		}
	}
	return out;
}

/**
 * 批量切换勾选：names 全部已勾选（通配展开后判定）→ 整组取消；否则 → 整组勾上。
 * 落盘规则：
 * - `all` 之外的残留条目原样保留（磁盘/兼容性写入），**除了**——
 * - 服务器通配：本次切换若从它覆盖的组里**摘掉**了工具（allOn 方向且命中同组），
 *   通配让位于精确名；开启方向产出精确名（规范化表示），不写入新通配。
 */
export function toggleNames(
	tools: string[],
	all: string[],
	names: string[],
): string[] {
	const checked = new Set(expandChecked(tools, all));
	const allOn = names.every((n) => checked.has(n));
	for (const n of names) {
		if (allOn) checked.delete(n);
		else checked.add(n);
	}
	const extra = tools.filter((n) => {
		if (all.includes(n)) return false; // all 内条目按勾选集重建
		if (
			isMcpServerWildcard(n) &&
			allOn && // 本次在摘工具
			names.some((x) => x.startsWith(mcpWildcardPrefix(n))) // 且摘的是该通配覆盖的组
		) {
			return false;
		}
		return true;
	});
	return all.filter((n) => checked.has(n)).concat(extra);
}
