// subagent-info.ts — 内置 subagent 信息读取
//
// 切换 pi-open-agents 后，内置 subagent 的 systemPrompt 定义在 builtin-agents.ts 的
// BUILTIN_AGENT_CONTENT 中（同时写入 ~/.hiagent/agents/*.md）。不再从 pi-subagents 包内部源码 import。
// 元信息（emoji/gradient/displayName）仍在 SUBAGENT_TYPES 常量。

import { SUBAGENT_TYPES } from "@hiagent/shared";
import type { SubagentInfo, SubagentOverride } from "@hiagent/shared";
import { BUILTIN_AGENT_CONTENT } from "./builtin-agents";

/** 从 .md 内容中提取 frontmatter 之后的 body 部分（即 systemPrompt 正文） */
function extractMdBody(md: string): string {
  const fm = md.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  return fm ? fm[1].trim() : "";
}

/** BUILTIN_AGENT_CONTENT 中提取的 systemPrompt 缓存（启动后不变） */
let _systemPromptCache: Record<string, string> | null = null;
function getSystemPrompt(name: string): string {
  if (!_systemPromptCache) {
    _systemPromptCache = {};
    for (const [n, content] of Object.entries(BUILTIN_AGENT_CONTENT)) {
      _systemPromptCache[n] = extractMdBody(content);
    }
  }
  return _systemPromptCache[name] ?? "";
}

/**
 * 组装内置 subagent 完整信息列表：SUBAGENT_TYPES 元信息 + systemPrompt（从 BUILTIN_AGENT_CONTENT 提取）+ 用户 override。
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
    systemPrompt: getSystemPrompt(t.name),
    builtinToolNames: t.readOnly ? ["read", "bash", "grep", "find", "ls"] : [],
    override: overrides.find(o => o.type === t.name),
  }));
}

// 保留以兼容旧测试引用（原 _resetPiDefaultsCache），测试中以 mock 覆盖
export function _resetPiDefaultsCache() { _systemPromptCache = null; }
