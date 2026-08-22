// chip token 序列化/反序列化纯函数
// token 格式：智能体 @[名称]，文件 #[相对路径]，技能 $[技能名]，命令 /[命令名]
// 发送时展开：#[path] -> #path，$[name] -> /skill:name（SDK _expandSkillCommand 识别）
// @[名称] 不在 expandTokens 处理——原样保留给主智能体识别（由 systemPrompt 规则触发 delegate）
// /[名称] 不在 expandTokens 处理——原样保留为 /名称 发送给 pi 解析执行

import { iconSvg } from "../components/ui/Icon";
import i18n from "../i18n";

/** 智能体 token 正则：匹配 @[非]字符的名称] */
export const AGENT_TOKEN_RE = /@\[([^\]]+)\]/g;
/** 文件 token 正则：匹配 #[非]字符的路径] */
export const FILE_TOKEN_RE = /#\[([^\]]+)\]/g;
/** 技能 token 正则：匹配 $[名称] 或 ¥[名称] */
export const SKILL_TOKEN_RE = /[$¥]\[([^\]]+)\]/g;
/** 命令 token 正则：匹配 /[命令名] */
export const COMMAND_TOKEN_RE = /\/\[([^\]]+)\]/g;
/** 元素 token 正则：匹配 ![路径|起-止行|标签]（预览 inspect 选中的页面元素；行号可缺省为 ![路径||标签]） */
export const ELEMENT_TOKEN_RE = /!\[([^\]]+)\]/g;
/** 元素定位文本正则：expandTokens 展开后的形态（path [line: 起-止] [el: 标签] / path [el: 标签]），
 *  历史消息回显时重新 chip 化用。path 按非空格串匹配（含空格的路径不 chip 化，纯文本兜底）。 */
const ELEMENT_LOCATOR_RE =
	/^(\S+)(?: \[line: (\d+-\d+)\])? \[el: ([^\]]+)\]$/;

/** IM 推送 token 正则：匹配完整 @im-push-to(ch_xxx,ct_xxx) 标记。
 *  与 automation/prompt-tokens.ts 的 IM_PUSH_TOKEN_RE 保持一致——
 *  那边 import 本文件的 textToHtml，不能反向 import（循环依赖），故此处复制定义。
 *  不带 g 标志：供 textToSegments 的 .test() 用；split 正则另行内联。 */
const IM_PUSH_TOKEN_RE = /@im-push-to\(ch_[a-zA-Z0-9_-]+,ct_[a-zA-Z0-9_-]+\)/;

/**
 * 全角触发符符号 → 半角映射表。
 *
 * 背景：Windows 中文输入法在全角模式下插入的是全角符号（如 ￥ U+FFE5），
 * 而代码里匹配的是半角 U+00A5。该映射把输入法可能产生的全角触发符
 * 统一归一化为代码认识的半角等价物，使 $/¥/￥、@/＠、#/＃、//／ 都能触发对应面板。
 *
 * 刻意只映射这 5 个「触发符符号」：全角字母数字（ＡＢＣ０１２３）和中文标点
 * （（）、「」、［］等）在中文文本里是正常内容，不在此转换，避免改变用户语义。
 */
const FULLWIDTH_TRIGGER_MAP: Record<string, string> = {
  "\uFFE5": "\u00A5", // ￥ (FULLWIDTH YEN SIGN) → ¥ (YEN SIGN)
  "\uFF04": "$", // ＄ (FULLWIDTH DOLLAR SIGN) → $
  "\uFF20": "@", // ＠ (FULLWIDTH COMMERCIAL AT) → @
  "\uFF03": "#", // ＃ (FULLWIDTH NUMBER SIGN) → #
  "\uFF0F": "/", // ／ (FULLWIDTH SOLIDUS) → /
};

/**
 * 把全角触发符符号归一化为半角。
 *
 * 只在「检测/发送路径」入口调用，显示路径（textToSegments/textToHtml）不调用：
 * 输入框所见即所得（用户原文在发送前不被改写），发送时才做归一化/展开变换。
 */
export function normalizeTriggerChars(text: string): string {
  return text.replace(
    /[\uFFE5\uFF04\uFF20\uFF03\uFF0F]/g,
    (ch) => FULLWIDTH_TRIGGER_MAP[ch],
  );
}

/** segment 类型 */
export type Segment =
  | { type: "text"; value: string }
  | { type: "agent"; value: string }
  | { type: "file"; value: string }
  | { type: "skill"; value: string }
  | { type: "command"; value: string }
  | { type: "element"; value: string }
  | { type: "im"; value: string };

// ── 元素 token（预览 inspect 选中元素）──
// payload 格式：路径|起-止行|标签（行号缺省时空串：路径||标签）。
// 已知限制：路径含 | 或 ] 会破坏解析（罕见，与既有 token 的 ] 限制一致）。

export interface ElementRef {
  path: string;
  startLine: number | null;
  endLine: number | null;
  elLabel: string;
}

/** 组装元素 token 文本（![路径|起-止行|标签]），行号缺失时 lines 段为空 */
export function formatElementToken(ref: ElementRef): string {
  const lines =
    ref.startLine != null ? `${ref.startLine}-${ref.endLine ?? ref.startLine}` : "";
  return `![${ref.path}|${lines}|${ref.elLabel}]`;
}

/** 解析元素 token payload；格式不符返回 null */
export function parseElementPayload(
  value: string,
): { path: string; lines: string; elLabel: string } | null {
  const parts = value.split("|");
  if (parts.length !== 3 || !parts[0] || !parts[2]) return null;
  return { path: parts[0], lines: parts[1], elLabel: parts[2] };
}

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
  return normalizeTriggerChars(text)
    .replace(FILE_TOKEN_RE, "#$1")
    .replace(SKILL_TOKEN_RE, "/skill:$1 ") // 末尾空格：SDK _expandSkillCommand 用空格分隔技能名和参数
    .replace(COMMAND_TOKEN_RE, "/$1 ") // 命令 chip 展开为 /命令名 ，pi 识别为斜杠命令
    .replace(ELEMENT_TOKEN_RE, (_m, p1) => {
      // 元素 chip 展开为定位文本：path [line: 起-止] [el: 标签]（无行号省略 line 段）
      const p = parseElementPayload(p1);
      if (!p) return _m;
      return `${p.path}${p.lines ? ` [line: ${p.lines}]` : ""} [el: ${p.elLabel}]`;
    });
}

// 智能体名称 -> 头像/颜色/显示名 全局注册表，供 textToHtml 渲染 chip 时使用。
// 对内置 subagent：name 是英文 type name（如 "Plan"，用于 token @[Plan]），
// displayName 是中文（如"规划子智能体"，用于 chip 显示文本）。
const agentMetaLookup = new Map<
  string,
  { avatar?: string; avatarColor?: string; displayName?: string }
>();

/** 注册智能体头像信息，供 chip 渲染时查找。displayName 用于 token 名与显示名不一致的场景（内置 subagent）。 */
export function registerAgentMeta(
  name: string,
  meta: { avatar?: string; avatarColor?: string; displayName?: string },
) {
  agentMetaLookup.set(name, meta);
}

/** 清除所有已注册的智能体头像信息（测试用） */
export function clearAgentMeta() {
  agentMetaLookup.clear();
}

// IM 联系人 id -> 显示信息 全局注册表，供 textToHtml 渲染 chip-im 时查找。
// 数据源：contacts store 的 loadContacts/renameContact 批量注册
// + ComposerInput 选中联系人时单个注册。未注册（已删除/未加载）→ chip-im-invalid 灰化。
const contactMetaLookup = new Map<
  string,
  { label: string; kind?: "person" | "group" }
>();

/** 注册 IM 联系人显示信息（label 为备注名或 id 截断，由调用方构造），供 chip-im 渲染查找 */
export function registerContactMeta(
  contactId: string,
  meta: { label: string; kind?: "person" | "group" },
) {
  contactMetaLookup.set(contactId, meta);
}

/** 清除所有已注册的联系人显示信息（测试用） */
export function clearContactMeta() {
  contactMetaLookup.clear();
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
      background-color: var(--success-soft);
      color: var(--success);
      border: 1px solid var(--success-soft);
    }
    .chip-skill {
      background-color: var(--accent-soft);
      color: var(--accent);
      border: 1px solid var(--accent-soft);
    }
    .chip-command {
      background-color: var(--warning-soft);
      color: var(--warning);
      border: 1px solid var(--warning-soft);
    }
    .chip-element {
      background-color: var(--info-soft, var(--accent-soft));
      color: var(--info, var(--accent));
      border: 1px solid var(--info-soft, var(--accent-soft));
    }
    .chip-im {
      background-color: var(--success-soft);
      color: var(--success);
      border: 1px solid var(--success-soft);
    }
    .chip-im-invalid {
      opacity: 0.6;
      text-decoration: line-through;
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
  const combined =
    /(@im-push-to\(ch_[a-zA-Z0-9_-]+,ct_[a-zA-Z0-9_-]+\)|@\[[^\]]+\]|#\[[^\]]+\]|[$¥]\[[^\]]+\]|\/\[[^\]]+\]|!\[[^\]]+\]|\S+ (?:\[line: \d+-\d+\] )?\[el: [^\]]+\])/g;
  const parts = text.split(combined).filter((p) => p !== "");
  const segs: Segment[] = [];
  for (const part of parts) {
    if (IM_PUSH_TOKEN_RE.test(part)) {
      segs.push({ type: "im", value: part });
      continue;
    }
    const elementMatch = part.match(/^!\[([^\]]+)\]$/);
    if (elementMatch) {
      segs.push({ type: "element", value: elementMatch[1] });
      continue;
    }
    // 展开后的定位文本（历史消息）：还原为 element payload（路径|起-止行|标签）
    const locatorMatch = part.match(ELEMENT_LOCATOR_RE);
    if (locatorMatch) {
      segs.push({
        type: "element",
        value: `${locatorMatch[1]}|${locatorMatch[2] ?? ""}|${locatorMatch[3]}`,
      });
      continue;
    }
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
    const skillMatch = part.match(/^[$¥]\[([^\]]+)\]$/);
    if (skillMatch) {
      segs.push({ type: "skill", value: skillMatch[1] });
      continue;
    }
    const commandMatch = part.match(/^\/\[([^\]]+)\]$/);
    if (commandMatch) {
      segs.push({ type: "command", value: commandMatch[1] });
      continue;
    }
    segs.push({ type: "text", value: part });
  }
  return segs;
}

/** segment 数组还原为纯文本 token 字符串 */
export function segmentsToText(segs: Segment[]): string {
  return segs
    .map((s) => {
      if (s.type === "im") return s.value;
      if (s.type === "agent") return `@[${s.value}]`;
      if (s.type === "file") return `#[${s.value}]`;
      if (s.type === "skill") return `$[${s.value}]`;
      if (s.type === "command") return `/[${s.value}]`;
      if (s.type === "element") return `![${s.value}]`;
      return s.value;
    })
    .join("");
}

/**
 * 把纯文本（含 token）转为 HTML 字符串，chip 渲染为不可编辑的 span。
 * chip 内部含 data-token 属性（原始 token）和显示文本（触发符 + 名称）。
 */
function avatarStyle(color?: string): string {
  if (!color) return "";
  const parts = color.split("-").map((s) => s.trim());
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
export function textToHtml(
  text: string,
  opts?: { hideTrigger?: boolean },
): string {
  const hideTrigger = opts?.hideTrigger ?? false;
  const segs = textToSegments(text);
  return segs
    .map((s) => {
      if (s.type === "im") {
        const token = s.value;
        const contactId = token.match(/ct_[a-zA-Z0-9_-]+/)?.[0] ?? "";
        const meta = contactMetaLookup.get(contactId);
        const cls = meta ? "chip chip-im" : "chip chip-im chip-im-invalid";
        const icon = iconSvg(meta?.kind === "group" ? "users" : "user");
        // 未注册（联系人已删除/未加载）时灰化显示 contactId 原文
        const label = meta?.label ?? contactId;
        return `<span class="${cls}" contenteditable="false" data-token="${escapeHtml(token)}">${icon} ${escapeHtml(i18n.t("sendIm.sendTo"))}${escapeHtml(label)}</span>`;
      }
      if (s.type === "agent") {
        const token = `@[${s.value}]`;
        const meta = agentMetaLookup.get(s.value);
        const avatarHtml = meta?.avatar
          ? `<span class="chip-agent-avatar" style="background:${escapeHtml(avatarStyle(meta.avatarColor))}">${escapeHtml(meta.avatar)}</span>`
          : "";
        const trigger = hideTrigger ? "" : "@";
        // 内置 subagent 的 token 用英文 name（与提示词一致），但 chip 显示其中文 displayName（若有注册）
        const display = meta?.displayName ?? s.value;
        // @ 在 avatar 之前（最前面），更符合"@某人"的视觉习惯
        return `<span class="chip chip-agent" contenteditable="false" data-token="${escapeHtml(token)}">${trigger}${avatarHtml}${escapeHtml(display)}</span>`;
      }
      if (s.type === "file") {
        const token = `#[${s.value}]`;
        return `<span class="chip chip-file" contenteditable="false" data-token="${escapeHtml(token)}">#${escapeHtml(s.value)}</span>`;
      }
      if (s.type === "skill") {
        const token = `$[${s.value}]`;
        // 用闪电 SVG 图标替代触发符 $（输入框和历史回显都显示图标，更直观）
        return `<span class="chip chip-skill" contenteditable="false" data-token="${escapeHtml(token)}">${iconSvg("bolt")} ${escapeHtml(s.value)}</span>`;
      }
      if (s.type === "command") {
        const token = `/[${s.value}]`;
        return `<span class="chip chip-command" contenteditable="false" data-token="${escapeHtml(token)}">/${escapeHtml(s.value)}</span>`;
      }
      if (s.type === "element") {
        const token = `![${s.value}]`;
        const p = parseElementPayload(s.value);
        // 展示标签：文件名[:起始行] <标签>；payload 损坏时原样显示
        const label = p
          ? `${p.path.split(/[\\/]/).pop() ?? p.path}${p.lines ? `:${p.lines.split("-")[0]}` : ""} <${p.elLabel}>`
          : s.value;
        return `<span class="chip chip-element" contenteditable="false" data-token="${escapeHtml(token)}">${iconSvg("element")} ${escapeHtml(label)}</span>`;
      }
      // 先 escapeHtml 防注入，再把换行转为 <br>（在转义之后做，
      // 这样 <br> 的尖括号是我们生成的、不会被二次转义）。
      // 用户在 contenteditable 里换行产生 \n，渲染为历史消息时必须保留可见换行。
      return escapeHtml(s.value).replace(/\n/g, "<br>");
    })
    .join("");
}

// ── 复制语义保留：选中 DOM → token 文本 ──

/** contenteditable 中视为块级的标签（换行分隔） */
const COPY_BLOCK_TAGS = new Set([
  "DIV",
  "P",
  "BR",
  "LI",
  "TR",
  "BLOCKQUOTE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "PRE",
]);

/** 把元素子树序列化为 token 文本：chip（data-token）取 token 原文，
 *  文本节点取 textContent，块元素转 \n（与 ComposerTextarea.extractText 同规则）。 */
function nodeToTokenText(root: HTMLElement): string {
  let result = "";
  const childNodes = Array.from(root.childNodes);
  for (let idx = 0; idx < childNodes.length; idx++) {
    const node = childNodes[idx];
    if (node.nodeType === Node.TEXT_NODE) {
      result += node.textContent ?? "";
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const elem = node as HTMLElement;
      const token = elem.getAttribute("data-token");
      if (token) {
        result += token;
      } else if (elem.tagName === "BR") {
        result += "\n";
      } else {
        const isBlock = COPY_BLOCK_TAGS.has(elem.tagName);
        if (isBlock && result.length > 0 && !result.endsWith("\n")) {
          const prev = childNodes[idx - 1];
          const prevIsChip =
            prev?.nodeType === Node.ELEMENT_NODE &&
            !!(prev as HTMLElement).getAttribute("data-token");
          if (!prevIsChip) result += "\n";
        }
        result += nodeToTokenText(elem);
      }
    }
  }
  return result;
}

/** 把 contenteditable 的选中区域（Range）序列化为 token 文本——复制时写入剪贴板，
 *  保证粘贴到任意输入框后 token 语义不丢（粘贴端 textToHtml/toPromptHtml 自动重渲染成 chip）。
 *  兼容 user-select:all 的原子选区：range 落在单个 chip 内部时扩展到整个 chip。 */
export function selectionToTokenText(range: Range): string {
  const startEl =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as HTMLElement)
      : ((range.startContainer.parentElement as HTMLElement | null) ??
        undefined);
  const endEl =
    range.endContainer.nodeType === Node.ELEMENT_NODE
      ? (range.endContainer as HTMLElement)
      : ((range.endContainer.parentElement as HTMLElement | null) ?? undefined);
  const startChip = startEl?.closest?.("[data-token]") as HTMLElement | null;
  const endChip = endEl?.closest?.("[data-token]") as HTMLElement | null;
  // 原子选区：起点终点都在同一 chip 内 → 输出整个 token（点击 chip 全选后复制）
  if (startChip && startChip === endChip)
    return startChip.getAttribute("data-token") ?? "";
  // 通用：克隆 range 内容到临时容器，按节点规则序列化
  const frag = range.cloneContents();
  const tmp = document.createElement("div");
  tmp.appendChild(frag);
  return nodeToTokenText(tmp);
}
