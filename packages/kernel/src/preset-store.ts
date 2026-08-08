/**
 * agency 预设智能体库：加载生成的 agency-presets.json，
 * 提供浏览元数据与「从预设创建智能体」能力。
 * JSON 缺失/损坏时降级为空列表，不影响 kernel 启动。
 */
import type { AgencyPreset, AgencyPresetMeta, AgentConfig, AgentName } from "@wa-pi/shared";
import { makeDefaultAgentConfig } from "./agent-md";
import type { ConfigStore } from "./config-store";

function loadPresets(): AgencyPreset[] {
  try {
    // bun 支持 JSON import；require 兼容两种运行方式
    const data = require("./data/agency-presets.json") as AgencyPreset[];
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error("[preset-store] agency-presets.json 加载失败，预设功能降级为空：", err);
    return [];
  }
}

const PRESETS = loadPresets();

/** 浏览用元数据（剔除 body） */
export function listPresets(): AgencyPresetMeta[] {
  return PRESETS.map(({ body: _body, ...meta }) => meta);
}

export function getPreset(id: string): AgencyPreset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/** 由预设 + 人名组装 AgentConfig（正文开头注入名字，让智能体知道自己叫什么） */
export function buildAgentConfigFromPreset(preset: AgencyPreset, displayName: string): AgentConfig {
  const config = makeDefaultAgentConfig(displayName);
  if (preset.emoji) config.avatar = preset.emoji;
  // 仅接受 hex 颜色：预设库里有非合法 CSS 颜色（如 "indigo"），原样拼进渐变会让整条
  // linear-gradient 声明失效、且带 "-" 的值会搅乱前端 split("-") 解构，此时保留默认渐变
  if (preset.color && /^#[0-9a-f]{3,8}$/i.test(preset.color)) config.avatarColor = `${preset.color}-${preset.color}`;
  config.description = preset.description;
  config.systemPromptBody = `你的名字是「${displayName}」。\n\n${preset.body}`;
  return config;
}

export type CreateFromPresetResult =
  | { ok: true; agent: AgentConfig }
  | { ok: false; status: number; error: string };

/** 从预设创建智能体：404 未知 id / 400 非法名 / 409 重名 */
export async function createAgentFromPreset(
  configStore: ConfigStore,
  id: string,
  displayName: string,
): Promise<CreateFromPresetResult> {
  const preset = getPreset(id);
  if (!preset) return { ok: false, status: 404, error: `预设不存在: ${id}` };
  const name = (displayName ?? "").trim();
  if (!name || /[/\\:*?"<>|]/.test(name)) {
    return { ok: false, status: 400, error: `非法 displayName: ${displayName}` };
  }
  if (await configStore.getAgent(name as AgentName)) {
    return { ok: false, status: 409, error: `名称已被占用: ${name}` };
  }
  const config = buildAgentConfigFromPreset(preset, name);
  const errs = await configStore.saveAgent(config);
  if (errs.length > 0) return { ok: false, status: 400, error: errs.join("; ") };
  return { ok: true, agent: config };
}
