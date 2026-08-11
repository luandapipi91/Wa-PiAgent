// export-chat-image.ts — 聊天消息导出为图片的逻辑层。
// collectTurns：从会话消息切片出「当条 AI 回复往前最多 5 轮」的文本对话；
// downloadBlob：a[download] 触发浏览器下载；
// renderTurnsToPngBlob（屏外渲染转 PNG）在 Task 2 加入本文件。
import type { SessionMessage } from "@wa-pi/shared";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { toBlob } from "html-to-image";
import { ExportImageCard } from "../components/blocks/ExportImageCard";

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
		.filter(
			(b) => b?.type === "text" && typeof b.text === "string" && b.text.trim(),
		)
		.map((b) => String(b.text))
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
	includeUser = true,
): ExportTurn[] {
	// 1. 先按「回合首块 timestamp」过滤 user/assistant。
	//    关键：必须按回合首块时间判断，不能逐条按原始 timestamp 过滤——
	//    流式期间 store 未 compact，同一回合 assistant 是多条（thinking 块 ts=T1 +
	//    text 正文块 ts=T2）。uptoTimestamp 来自渲染合并行（保留回合首块 ts=T1），
	//    若逐条过滤会把同回合 ts 更大的 text 正文块（T2 > T1）误过滤掉，只剩
	//    thinking 文字。所以先标记每条 assistant 所属回合的首块 ts，整回合
	//    「首块 ≤ uptoTimestamp」则全部保留，否则全部丢弃。
	//    user 消息独立成一个边界，按自身 ts 判断。
	const turnStartTs = new Map<number, number>(); // 原始 index → 回合首块 ts
	let curTurnStart: number | null = null;
	let curTurnAgent: string | undefined;
	for (let k = 0; k < messages.length; k++) {
		const m = messages[k].message as any;
		if (m.role !== "user" && m.role !== "assistant") continue;
		const ts = typeof m.timestamp === "number" ? m.timestamp : 0;
		if (m.role === "assistant") {
			// 同 agent 连续 assistant 属同一回合（与 collapseSameTurnAssistants 口径一致）；
			// agent 切换或 user 之后开新回合。
			if (curTurnStart == null || curTurnAgent !== messages[k].agentName) {
				curTurnStart = ts;
				curTurnAgent = messages[k].agentName;
			}
			turnStartTs.set(k, curTurnStart as number);
		} else {
			curTurnStart = null; // user 重置回合起点
			curTurnAgent = undefined;
			turnStartTs.set(k, ts);
		}
	}
	const filtered = messages.filter((sm, k) => {
		const m = sm.message as any;
		if (m.role !== "user" && m.role !== "assistant") return false;
		const start = turnStartTs.get(k) ?? 0;
		return start <= uptoTimestamp;
	});

	// 2. 合并同回合连续 assistant（拷贝后合并，不改原数组）。
	//    message.timestamp 更新为轮末（轮结束时刻），ExportTurn.timestamp 取它——
	//    与既有契约一致（ExportImageCard 显示「AI 回复完成时间」）。
	const merged: SessionMessage[] = [];
	for (const sm of filtered) {
		const m = sm.message as any;
		if (m.role !== "user" && m.role !== "assistant") continue;
		const prevRow = merged[merged.length - 1];
		const prev = prevRow?.message as any;
		if (
			m.role === "assistant" &&
			prev?.role === "assistant" &&
			prevRow?.agentName === sm.agentName
		) {
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
	//    注意：extension 斜杠命令（pi 拦截执行）不产生 user 消息，此时 user 留空
	//    仍收集该轮——导出图片里只显示 AI 回复行，不丢这类对话。
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
		turns.push({
			user: includeUser ? user : "",
			assistant,
			agentName: sm.agentName ?? "agent",
			timestamp: m.timestamp,
		});
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

/**
 * 屏外渲染 ExportImageCard 并转 PNG Blob。
 * 容器 fixed 定位到视口外（display:none 会导致布局为 0，不能用）；
 * toBlob 负责内联计算样式与 @font-face（MiSans/JetBrains Mono 为同源 woff2）。
 */
export async function renderTurnsToPngBlob(turns: ExportTurn[]): Promise<Blob> {
	const host = document.createElement("div");
	host.style.position = "fixed";
	host.style.left = "-10000px";
	host.style.top = "0";
	host.style.pointerEvents = "none";
	document.body.appendChild(host);
	const root = createRoot(host);
	try {
		root.render(createElement(ExportImageCard, { turns }));
		// 等 React 提交（轮询 firstElementChild 出现，超时兜底）+ 字体加载（图片里不缺字形）
		const deadline = Date.now() + 1000;
		while (!host.firstElementChild && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 16));
		}
		await (document as any).fonts?.ready;
		const card = host.firstElementChild as HTMLElement;
		if (!card) throw new Error("导出卡片渲染失败");
		const blob = await toBlob(card, { pixelRatio: 2 });
		if (!blob) throw new Error("PNG 生成失败");
		return blob;
	} finally {
		root.unmount();
		host.remove();
	}
}
