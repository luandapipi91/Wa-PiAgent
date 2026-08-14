// 前端版 @bot_xxx 渠道提及解析纯函数。
// 与后端 packages/kernel/src/tools/robot-push.ts 的 parseChannelMentions 保持相同契约：
// 从 prompt 中提取 @bot_xxx，去掉 @ 前缀返回去重后的 bot ID 列表。

const BOT_MENTION_RE = /@bot_[a-zA-Z0-9_-]+/g;

export function parseChannelMentions(prompt: string): string[] {
	const matches = prompt.match(BOT_MENTION_RE) ?? [];
	// 去掉 @ 前缀 → "bot_xxx"，再去重
	return [...new Set(matches.map((m) => m.slice(1)))];
}
