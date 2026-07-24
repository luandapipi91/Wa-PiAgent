// subagent-info.ts — 内置 subagent 信息读取
//
// 切换 pi-open-agents 后，内置 subagent 的 systemPrompt 定义在 builtin-agents.ts 的
// BUILTIN_AGENT_CONTENT 中（同时写入 ~/.hiagent/agents/*.md）。不再从 pi-subagents 包内部源码 import。
// 元信息（emoji/gradient/displayName）仍在 SUBAGENT_TYPES 常量。

import { SUBAGENT_TYPES } from "@hiagent/shared";
import type { SubagentInfo, SubagentOverride, DelegationHints } from "@hiagent/shared";
import { BUILTIN_AGENT_CONTENT } from "./builtin-agents";

/** 从 .md 内容中提取 frontmatter 之后的 body 部分（即 systemPrompt 正文） */
function extractMdBody(md: string): string {
  const fm = md.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  return fm ? fm[1].trim() : "";
}

/**
 * 从 .md frontmatter 提取 delegationHints（委派引导）。
 * 内置 .md 用 pi-open-agents frontmatter 格式（无 displayName 等 HiAgent 字段），
 * 不能直接用 parseAgentMd，故单独正则提取三个字段。
 */
function extractDelegationHints(md: string): DelegationHints | undefined {
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return undefined;
  const yaml = fm[1];
  // delegationHints 嵌套块：匹配 "  whenToDelegate: 值" 等缩进行
  const block = yaml.match(/^delegationHints:\s*\n((?:  \w+:.*\n?)+)/m);
  if (!block) return undefined;
  const get = (key: string) => {
    const m = block[1].match(new RegExp(`^  ${key}:\\s*(.+)$`, "m"));
    return m?.[1].trim() || undefined;
  };
  const whenToDelegate = get("whenToDelegate");
  const whenNotTo = get("whenNotTo");
  const benefit = get("benefit");
  return (whenToDelegate || whenNotTo || benefit) ? { whenToDelegate, whenNotTo, benefit } : undefined;
}

/** BUILTIN_AGENT_CONTENT 中提取的 systemPrompt / delegationHints 缓存（启动后不变） */
let _systemPromptCache: Record<string, string> | null = null;
let _delegationHintsCache: Record<string, DelegationHints | undefined> | null = null;
function ensureCache() {
  if (_systemPromptCache && _delegationHintsCache) return;
  _systemPromptCache = {};
  _delegationHintsCache = {};
  for (const [n, content] of Object.entries(BUILTIN_AGENT_CONTENT)) {
    _systemPromptCache[n] = extractMdBody(content);
    _delegationHintsCache[n] = extractDelegationHints(content);
  }
}
function getSystemPrompt(name: string): string {
  ensureCache();
  return _systemPromptCache![name] ?? "";
}
function getDelegationHints(name: string): DelegationHints | undefined {
  ensureCache();
  return _delegationHintsCache![name];
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
    delegationHints: getDelegationHints(t.name),
    override: overrides.find(o => o.type === t.name),
  }));
}

// 保留以兼容旧测试引用（原 _resetPiDefaultsCache），测试中以 mock 覆盖
export function _resetPiDefaultsCache() { _systemPromptCache = null; }

/**
 * 读取内置 subagent 的 systemPrompt：优先用户覆盖文件（~/.hiagent/agents/<name>.md，
 * seedBuiltinAgents 写入后不覆盖用户编辑），文件不存在/为空时回退 BUILTIN_AGENT_CONTENT。
 * 供 agent-manager 构造子代理 spawn 配置（替代旧 pi-open-agents loadAgents 文件读取）。
 */
export async function readBuiltinAgentPrompt(agentsDir: string, name: string): Promise<string> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const md = await readFile(join(agentsDir, `${name}.md`), "utf8");
    const body = extractMdBody(md);
    if (body) return body;
  } catch { /* 文件不存在则用内置内容 */ }
  return getSystemPrompt(name);
}
