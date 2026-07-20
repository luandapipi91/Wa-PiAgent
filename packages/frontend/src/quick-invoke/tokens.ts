// chip token 序列化/反序列化纯函数
// token 格式：智能体 @[名称]，文件 #[相对路径]，技能 $[技能名]
// 发送时展开：#[path] -> #path，$[name] -> /skill:name（SDK _expandSkillCommand 识别）
// @[名称] 不在 expandTokens 处理——原样保留给主智能体识别（由 systemPrompt 规则触发 delegate）

/** 智能体 token 正则：匹配 @[非]字符的名称] */
export const AGENT_TOKEN_RE = /@\[([^\]]+)\]/g;
/** 文件 token 正则：匹配 #[非]字符的路径] */
export const FILE_TOKEN_RE = /#\[([^\]]+)\]/g;
/** 技能 token 正则：匹配 $[非]字符的名称] */
export const SKILL_TOKEN_RE = /\$\[([^\]]+)\]/g;

/** segment 类型 */
export type Segment =
  | { type: "text"; value: string }
  | { type: "agent"; value: string }
  | { type: "file"; value: string }
  | { type: "skill"; value: string };

/**
 * 发送时把 chip token 展开为纯文本引用标记。
 * #[packages/App.tsx] -> #packages/App.tsx
 * $[brainstorming] -> /skill:brainstorming（后面必须跟空格，SDK 用空格分隔技能名和参数）
 *
 * @[名称] 不在此展开——原样保留给主智能体识别。
 *
 * 技能展开为 /skill:name 格式，由 SDK 的 _expandSkillCommand 识别后
 * 内联展开为 <skill name="..." location="...">完整 SKILL.md 内容</skill> XML 块。
 */
export function expandTokens(text: string): string {
  return text
    .replace(FILE_TOKEN_RE, "#$1")
    .replace(SKILL_TOKEN_RE, "/skill:$1 "); // 末尾空格：SDK _expandSkillCommand 用空格分隔技能名和参数
}

// 智能体名称 -> 头像/颜色 全局注册表，供 textToHtml 渲染 chip 时使用
const agentMetaLookup = new Map<string, { avatar?: string; avatarColor?: string }>();

/** 注册智能体头像信息，供 chip 渲染时查找 */
export function registerAgentMeta(name: string, meta: { avatar?: string; avatarColor?: string }) {
  agentMetaLookup.set(name, meta);
}

// chip 内联样式注入
let chipStyleInjected = false;

/** 确保 chip 样式已注入到 document.head（多次调用安全，只注入一次） */
export function ensureChipStyles() {
  if (chipStyleInjected || typeof document === "undefined") return;
  chipStyleInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 2px 7px;
      border-radius: 6px;
      font-size: 0.85em;
      font-weight: 500;
      margin: 0 1px;
      vertical-align: baseline;
      user-select: all;
    }
    .chip-agent {
      background-color: var(--accent-soft, #EEEEFF);
      color: var(--accent, #5B5BD6);
      border: 1px solid var(--accent-soft, #EEEEFF);
    }
    .chip-agent-avatar {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      border-radius: 3px;
      font-size: 10px;
      flex-shrink: 0;
    }
    .chip-file {
      background-color: #22C55E20;
      color: #16A34A;
      border: 1px solid #22C55E40;
    }
    .chip-skill {
      background-color: #5B5BD620;
      color: #5B5BD6;
      border: 1px solid #5B5BD640;
    }
    [contenteditable][data-placeholder]:empty::before {
      content: attr(data-placeholder);
      color: var(--text-tertiary, #A1A1A6);
      pointer-events: none;
    }
  `;
  document.head.appendChild(style);
}

/** 转义 HTML 特殊字符，防止 XSS */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 把纯文本（含 token）拆分为 segment 数组，供渲染和序列化使用。
 *
 * 注意：必须只用一个外层捕获组构造 split 正则。如果直接把
 * AGENT_TOKEN_RE / FILE_TOKEN_RE / SKILL_TOKEN_RE 的源（含内层捕获组）拼进 split 正则，
 * String.split 会把内层捕获组（名称/路径本身）和未匹配分支的 undefined
 * 也插入结果数组，破坏 segment 划分。
 */
export function textToSegments(text: string): Segment[] {
  const combined = /(@\[[^\]]+\]|#\[[^\]]+\]|\$\[[^\]]+\])/g;
  const parts = text.split(combined).filter(p => p !== "");
  const segs: Segment[] = [];
  for (const part of parts) {
    const agentMatch = part.match(/^@\[([^\]]+)\]$/);
    if (agentMatch) {
      segs.push({ type: "agent", value: agentMatch[1] });
      continue;
    }
    const fileMatch = part.match(/^#\[([^\]]+)\]$/);
    if (fileMatch) {
      segs.push({ type: "file", value: fileMatch[1] });
      continue;
    }
    const skillMatch = part.match(/^\$\[([^\]]+)\]$/);
    if (skillMatch) {
      segs.push({ type: "skill", value: skillMatch[1] });
      continue;
    }
    segs.push({ type: "text", value: part });
  }
  return segs;
}

/** segment 数组还原为纯文本 token 字符串 */
export function segmentsToText(segs: Segment[]): string {
  return segs.map(s => {
    if (s.type === "agent") return `@[${s.value}]`;
    if (s.type === "file") return `#[${s.value}]`;
    if (s.type === "skill") return `$[${s.value}]`;
    return s.value;
  }).join("");
}

/**
 * 把纯文本（含 token）转为 HTML 字符串，chip 渲染为不可编辑的 span。
 * chip 内部含 data-token 属性（原始 token）和显示文本（触发符 + 名称）。
 */
function avatarStyle(color?: string): string {
  if (!color) return "";
  const parts = color.split("-").map(s => s.trim());
  return parts.length >= 2
    ? `linear-gradient(135deg, ${parts.join(", ")})`
    : color;
}

/**
 * 把纯文本（含 token）转为 HTML 字符串，chip 渲染为不可编辑的 span。
 * chip 内部含 data-token 属性（原始 token）和显示文本（触发符 + 名称）。
 *
 * opts.hideTrigger=true 时 agent chip 显示文本不含 @ 前缀（仅展示名）。
 *   用于历史消息渲染（MessageList）：展示场景不需要看到触发符，更干净。
 *   输入框 ComposerTextarea 默认 false：保留 @ 让用户看到触发符。
 */
export function textToHtml(text: string, opts?: { hideTrigger?: boolean }): string {
  const hideTrigger = opts?.hideTrigger ?? false;
  const segs = textToSegments(text);
  return segs.map(s => {
    if (s.type === "agent") {
      const token = `@[${s.value}]`;
      const meta = agentMetaLookup.get(s.value);
      const avatarHtml = meta?.avatar
        ? `<span class="chip-agent-avatar" style="background:${escapeHtml(avatarStyle(meta.avatarColor))}">${escapeHtml(meta.avatar)}</span>`
        : "";
      const trigger = hideTrigger ? "" : "@";
      return `<span class="chip chip-agent" contenteditable="false" data-token="${escapeHtml(token)}">${avatarHtml}${trigger}${escapeHtml(s.value)}</span>`;
    }
    if (s.type === "file") {
      const token = `#[${s.value}]`;
      return `<span class="chip chip-file" contenteditable="false" data-token="${escapeHtml(token)}">#${escapeHtml(s.value)}</span>`;
    }
    if (s.type === "skill") {
      const token = `$[${s.value}]`;
      return `<span class="chip chip-skill" contenteditable="false" data-token="${escapeHtml(token)}">$${escapeHtml(s.value)}</span>`;
    }
    return escapeHtml(s.value);
  }).join("");
}
