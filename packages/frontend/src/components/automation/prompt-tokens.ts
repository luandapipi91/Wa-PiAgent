import { textToHtml } from "../../quick-invoke/tokens";

/**
 * 自动化任务指令的 @im-push-to(bot_xxx,ct_xxx) 标记体系（自动化模块私有，
 * 不并入聊天 tokens：避免联系人 chip 语义泄漏进主聊天的消息渲染）。
 */

/** 完整标记正则（/g 用于 split/match；.test 判定请用下方无 g 版） */
export const IM_PUSH_TOKEN_RE = /@im-push-to\(bot_[a-zA-Z0-9_-]+,ct_[a-zA-Z0-9_-]+\)/g;
/** 侧边栏徽标等 .test() 判定用（无 g，避免 lastIndex 状态污染） */
export const HAS_IM_PUSH_RE = /@im-push-to\(bot_[a-zA-Z0-9_-]+,ct_[a-zA-Z0-9_-]+\)/;

export interface ImPushToken {
	botId: string;
	contactId: string;
}

/** 解析指令中的全部 @im-push-to 标记（按出现顺序，不去重） */
export function parseImPushTokens(text: string): ImPushToken[] {
	const out: ImPushToken[] = [];
	for (const m of text.match(IM_PUSH_TOKEN_RE) ?? []) {
		out.push({
			botId: m.match(/bot_[a-zA-Z0-9_-]+/)?.[0] ?? "",
			contactId: m.match(/ct_[a-zA-Z0-9_-]+/)?.[0] ?? "",
		});
	}
	return out;
}

/** 构造存储形态标记 */
export function imPushToken(botId: string, contactId: string): string {
	return `@im-push-to(${botId},${contactId})`;
}

export interface ContactChipMeta {
	label: string;
	valid: boolean;
}

function escapeHtmlLocal(s: string): string {
	return s.replace(/[&<>"']/g, (c) =>
		({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
	);
}

/**
 * 任务指令 → contenteditable 内联 HTML：
 * - @im-push-to(...) → 联系人 chip（联系人已删除时灰化显示 id，不报错）
 * - 其余片段复用聊天 textToHtml（$[技能名] chip + 转义文本）
 * chip 带 data-token，ComposerTextarea 的 extractText 据此还原存储形态。
 */
export function toPromptHtml(
	text: string,
	contactMeta: (contactId: string) => ContactChipMeta,
): string {
	const pieces = text.split(IM_PUSH_TOKEN_RE);
	const tokens = text.match(IM_PUSH_TOKEN_RE) ?? [];
	let html = "";
	for (let i = 0; i < pieces.length; i++) {
		html += textToHtml(pieces[i]);
		const token = tokens[i];
		if (!token) continue;
		const contactId = token.match(/ct_[a-zA-Z0-9_-]+/)?.[0] ?? "";
		const meta = contactMeta(contactId);
		const cls = meta.valid ? "chip chip-im" : "chip chip-im chip-im-invalid";
		html += `<span class="${cls}" contenteditable="false" data-token="${escapeHtmlLocal(token)}">📨 ${escapeHtmlLocal(meta.label)}</span>`;
	}
	return html;
}
