// subagent-info.ts — 内置 subagent 信息读取
//
// 切换 pi-open-agents 后，内置 subagent 的 systemPrompt 在 ~/.hiagent/agents/*.md 定义文件里，
// 不再从 pi-subagents 包内部源码 import。元信息（emoji/gradient/displayName）仍在 SUBAGENT_TYPES 常量。

import { SUBAGENT_TYPES } from "@hiagent/shared";
import type { SubagentInfo, SubagentOverride } from "@hiagent/shared";

/**
 * 组装内置 subagent 完整信息列表：SUBAGENT_TYPES 元信息 + 用户 override。
 * systemPrompt 返回空串（前端 AgentConfig 展示只读详情时，可从 ~/.hiagent/agents/*.md 读）。
 * builtinToolNames 根据 readOnly 标志计算（readOnly → 只读工具集，否则空数组）。
 */
export async function getSubagentInfo(overrides: SubagentOverride[]): Promise<SubagentInfo[]> {
  return SUBAGENT_TYPES.map(t => ({
    name: t.name,
    displayName: t.displayName,
    description: t.description,
    emoji: t.emoji,
    gradient: t.gradient,
    readOnly: t.readOnly,
    systemPrompt: "",
    builtinToolNames: t.readOnly ? ["read", "bash", "grep", "find", "ls"] : [],
    override: overrides.find(o => o.type === t.name),
  }));
}

// 保留空函数以兼容旧测试引用（原 _resetPiDefaultsCache）
export function _resetPiDefaultsCache() { /* no-op: pi-open-agents 不再缓存 */ }
