import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { SUBAGENT_TYPES } from "@hiagent/shared";
import type { SubagentInfo, SubagentOverride } from "@hiagent/shared";

/**
 * 从 pi-subagents DEFAULT_AGENTS 读取内置 agent 的真实 systemPrompt + builtinToolNames。
 *
 * pi-subagents 在 src/config/default-agents.ts 里定义了 3 个默认 agent：
 *   general-purpose / Explore / Plan
 * 每个 agent 有 systemPrompt（除 general-purpose 为空串外都非空）+ builtinToolNames（除 general-purpose
 * 未设置外都为 READ_ONLY_TOOLS = ["read","bash","grep","find","ls"]）。
 *
 * pi-subagents 的 package.json exports 不暴露内部路径，这里用 createRequire
 * 解析包根目录后直接 import 源代码文件。
 */
async function loadPiDefaultAgents(): Promise<Map<string, {
  systemPrompt: string;
  builtinToolNames?: string[];
}>> {
  try {
    const req = createRequire(import.meta.url);
    const pkgEntry = req.resolve("@gotgenes/pi-subagents");
    // pkgEntry = .../pi-subagents/src/service/service.ts
    // package root 是其上 3 级目录
    const pkgRoot = dirname(dirname(dirname(pkgEntry)));
    const mod = await import(join(pkgRoot, "src/config/default-agents.ts"));
    // DEFAULT_AGENTS 是 Map<string, AgentConfig>，含 systemPrompt / builtinToolNames
    const map = (mod as any).DEFAULT_AGENTS as Map<string, any> | undefined;
    if (!map) return new Map();
    const result = new Map<string, { systemPrompt: string; builtinToolNames?: string[] }>();
    for (const [name, cfg] of map.entries()) {
      result.set(name, {
        systemPrompt: cfg.systemPrompt ?? "",
        builtinToolNames: Array.isArray(cfg.builtinToolNames) ? cfg.builtinToolNames : undefined,
      });
    }
    return result;
  } catch {
    return new Map();
  }
}

// 缓存 pi-subagents DEFAULT_AGENTS（启动后不变，避免每次 list 都 dynamic import）
let piDefaultsCache: Map<string, { systemPrompt: string; builtinToolNames?: string[] }> | null = null;
async function getPiDefaults() {
  if (piDefaultsCache) return piDefaultsCache;
  piDefaultsCache = await loadPiDefaultAgents();
  return piDefaultsCache;
}

// 仅供测试重置缓存用
export function _resetPiDefaultsCache() { piDefaultsCache = null; }

/**
 * 组装内置 subagent 完整信息列表：SUBAGENT_TYPES 元信息 + pi-subagents 真实 systemPrompt/builtinToolNames + 用户 override。
 * 顺序与 SUBAGENT_TYPES 一致。
 */
export async function getSubagentInfo(overrides: SubagentOverride[]): Promise<SubagentInfo[]> {
  const piDefaults = await getPiDefaults();
  return SUBAGENT_TYPES.map(t => {
    const pi = piDefaults.get(t.name);
    return {
      name: t.name,
      displayName: t.displayName,
      description: t.description,
      emoji: t.emoji,
      gradient: t.gradient,
      readOnly: t.readOnly,
      systemPrompt: pi?.systemPrompt ?? "",
      builtinToolNames: pi?.builtinToolNames ?? [],
      override: overrides.find(o => o.type === t.name),
    };
  });
}
