// export-chat-image.ts — 聊天消息导出为图片的逻辑层。
// collectTurns：从会话消息切片出「当条 AI 回复往前最多 5 轮」的文本对话；
// downloadBlob：a[download] 触发浏览器下载；
// renderTurnsToPngBlob（屏外渲染转 PNG）在 Task 2 加入本文件。
import type { SessionMessage } from "@wa-pi/shared";

export interface ExportTurn {
	user: string; // 用户消息纯文本
	assistant: string; // AI 回复 markdown 源文（text 块拼接）
	agentName: string; // AI 回复所属 agent（显示用）
	timestamp: number; // AI 回复（轮结束）时间戳
}

/** 提取消息文本：user content 可能是 string；assistant 只取 text 块（与 MessageList fullText 同口径，\n\n 拼接） */
function extractText(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b?.type === "text")
		.map((b) => String(b.text ?? ""))
		.join("\n\n");
}

/**
 * 从 messages 中截取 timestamp ≤ uptoTimestamp 的部分（含当条 AI 回复），
 * 往前取最多 maxTurns 轮文本对话（一轮 = 一条 user + 其后最近一条 assistant 的文字回复）。
 * 同轮连续 assistant（历史 jsonl 会按 toolCall 拆成多条）先合并；纯过程轮 / 无配对 user 的轮跳过。
 * 返回时间正序数组；无文本对话时返回 []。
 */
export function collectTurns(
	messages: SessionMessage[],
	uptoTimestamp: number,
	maxTurns = 5,
): ExportTurn[] {
	// 1. 只留当条（含）之前的 user/assistant
	const eligible = messages.filter((sm) => {
		const m = sm.message as any;
		const ts = typeof m.timestamp === "number" ? m.timestamp : 0;
		return ts <= uptoTimestamp && (m.role === "user" || m.role === "assistant");
	});
	// 2. 合并同轮连续 assistant（拷贝后合并，不改原数组）
	const merged: SessionMessage[] = [];
	for (const sm of eligible) {
		const m = sm.message as any;
		const prevRow = merged[merged.length - 1];
		const prev = prevRow?.message as any;
		if (m.role === "assistant" && prev?.role === "assistant") {
			prev.content = [
				...(Array.isArray(prev.content) ? prev.content : []),
				...(Array.isArray(m.content) ? m.content : []),
			];
			prev.timestamp = m.timestamp; // 轮结束时刻
			continue;
		}
		merged.push({
			...sm,
			message: {
				...m,
				content: Array.isArray(m.content) ? [...m.content] : m.content,
			},
		});
	}
	// 3. 逆序配对：assistant → 往前最近的 user
	const turns: ExportTurn[] = [];
	let i = merged.length - 1;
	while (i >= 0 && turns.length < maxTurns) {
		const sm = merged[i];
		const m = sm.message as any;
		if (m.role !== "assistant") {
			i--;
			continue;
		}
		const assistant = extractText(m.content).trim();
		if (!assistant) {
			i--;
			continue; // 纯过程轮（无文字回复）跳过
		}
		let user = "";
		let j = i - 1;
		for (; j >= 0; j--) {
			const um = merged[j].message as any;
			if (um.role === "user") {
				user = extractText(um.content).trim();
				break;
			}
		}
		if (user) {
			turns.push({
				user,
				assistant,
				agentName: sm.agentName ?? "agent",
				timestamp: m.timestamp,
			});
		}
		i = Math.min(j, i - 1); // 跳过已配对的 user；未找到（j=-1）时循环终止
	}
	return turns.reverse();
}

/** a[download] 触发浏览器下载。 */
export function downloadBlob(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
