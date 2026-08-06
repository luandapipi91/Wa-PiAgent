import type { AgentMessage, ReplyGranularity } from "@wa-pi/shared";

/** 企微 stream/markdown 内容上限 20480 字节，留余量取 20000 */
export const REPLY_MAX_BYTES = 20_000;

/** 拼接本轮助手消息的全部 text 块（跳过 thinking/toolCall） */
export function extractAssistantText(turnMessages: AgentMessage[]): string {
	const parts: string[] = [];
	for (const m of turnMessages) {
		if (m.role !== "assistant") continue;
		for (const block of m.content as any[]) {
			if (block.type === "text" && typeof block.text === "string") {
				parts.push(block.text);
			}
		}
	}
	return parts.join("\n").trim();
}

/** 提取本轮 edit/write 工具调用的文件路径（去重、保序） */
export function extractChangedFiles(turnMessages: AgentMessage[]): string[] {
	const files: string[] = [];
	for (const m of turnMessages) {
		if (m.role !== "assistant") continue;
		for (const block of m.content as any[]) {
			if (
				block.type === "toolCall" &&
				(block.name === "edit" || block.name === "write") &&
				typeof block.arguments?.path === "string" &&
				!files.includes(block.arguments.path)
			) {
				files.push(block.arguments.path);
			}
		}
	}
	return files;
}

/** 按回复粒度组装出站文本 */
export function composeReply(
	turnMessages: AgentMessage[],
	granularity: ReplyGranularity,
): string {
	const text = extractAssistantText(turnMessages);
	if (granularity === "simple") return text;
	const files = extractChangedFiles(turnMessages);
	return files.length > 0 ? `${text}\n\n📄 修改：${files.join("、")}` : text;
}

/** 按 UTF-8 字节上限切分；优先在换行处断开，绝不在多字节字符中间切断 */
export function chunkByBytes(
	text: string,
	maxBytes: number = REPLY_MAX_BYTES,
): string[] {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return [text];
	const chunks: string[] = [];
	let rest = text;
	while (Buffer.byteLength(rest, "utf8") > maxBytes) {
		// 按码点累积，保证不切断多字节字符
		let taken = "";
		let bytes = 0;
		for (const ch of rest) {
			const b = Buffer.byteLength(ch, "utf8");
			if (bytes + b > maxBytes) break;
			taken += ch;
			bytes += b;
		}
		// 优先在最后一个换行处断（至少保留 1/4 长度，避免碎块）
		const nl = taken.lastIndexOf("\n");
		if (nl > taken.length / 4) taken = taken.slice(0, nl);
		chunks.push(taken);
		rest = rest.slice(taken.length).replace(/^\n/, "");
	}
	if (rest.length > 0) chunks.push(rest);
	return chunks;
}
