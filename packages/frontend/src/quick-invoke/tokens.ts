// chip token 序列化/反序列化纯函数
// token 格式：文件 @[相对路径]，技能 $[技能名]
// 发送时展开：@[path] -> @path，$[name] -> $name

/** 文件 token 正则：匹配 @[非]字 符的路径] */
export const FILE_TOKEN_RE = /@\[([^\]]+)\]/g;
/** 技能 token 正则：匹配 $[非]字 符的名称] */
export const SKILL_TOKEN_RE = /\$\[([^\]]+)\]/g;

/** segment 类型 */
export type Segment =
  | { type: "text"; value: string }
  | { type: "file"; value: string }
  | { type: "skill"; value: string };

/**
 * 发送时把 chip token 展开为纯文本引用标记。
 * @[packages/App.tsx] -> @packages/App.tsx
 * $[brainstorming] -> $brainstorming
 */
export function expandTokens(text: string): string {
  return text
    .replace(FILE_TOKEN_RE, "@$1")
    .replace(SKILL_TOKEN_RE, "$$$1"); // $$$1 = 字面 $ + 捕获组1
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
 * FILE_TOKEN_RE / SKILL_TOKEN_RE 的源（含内层捕获组）拼进 split 正则，
 * String.split 会把内层捕获组（路径/技能名本身）和未匹配分支的 undefined
 * 也插入结果数组，破坏 segment 划分。
 */
export function textToSegments(text: string): Segment[] {
  const combined = /(@\[[^\]]+\]|\$\[[^\]]+\])/g;
  const parts = text.split(combined).filter(p => p !== "");
  const segs: Segment[] = [];
  for (const part of parts) {
    const fileMatch = part.match(/^@\[([^\]]+)\]$/);
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
    if (s.type === "file") return `@[${s.value}]`;
    if (s.type === "skill") return `$[${s.value}]`;
    return s.value;
  }).join("");
}

/**
 * 把纯文本（含 token）转为 HTML 字符串，chip 渲染为不可编辑的 span。
 * chip 内部含 data-token 属性（原始 token）和显示文本（展开后的引用标记）。
 */
export function textToHtml(text: string): string {
  const segs = textToSegments(text);
  return segs.map(s => {
    if (s.type === "file") {
      const token = `@[${s.value}]`;
      return `<span class="chip chip-file" contenteditable="false" data-token="${escapeHtml(token)}">@${escapeHtml(s.value)}</span>`;
    }
    if (s.type === "skill") {
      const token = `$[${s.value}]`;
      return `<span class="chip chip-skill" contenteditable="false" data-token="${escapeHtml(token)}">$${escapeHtml(s.value)}</span>`;
    }
    return escapeHtml(s.value);
  }).join("");
}
