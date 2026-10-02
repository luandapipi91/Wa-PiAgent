// 子代理转录只读弹窗（规格 §9.2）：委托卡「查看全部内容」写入 store 目标实例后，
// 由 App 根的常驻挂载点渲染本组件——卡片随流式结束 / 轮级折叠 / 卸载时弹窗不被连带关闭。
//
// 关键约束：
// - **按需加载**：只在弹窗打开时拉转录（卡片渲染期不预取）。
// - **只读**：无输入框、不向子代理会话追加任何内容。
// - **不复用 MessageList**（它强绑定 session store、无 messages 入参）：这里用轻量渲染器 ——
//   Markdown(interactive=false) + ThinkingCard + ToolCallCard，toolCall ↔ toolResult 自行按
//   toolCallId 配对（配对逻辑抽成纯函数 buildTranscriptSegments，单独单测）。
// - **筛选纯前端**：全部 / 思考 / 工具 / 正文只过滤已拉到的段，绝不重新请求。
// - 位置与尺寸记忆沿用 ui/Modal 的持久化键（对齐 FilePreviewModal）。
import { useEffect, useMemo, useState } from "react";
import type { SessionMessage, ToolCall, ToolResultMessage } from "@wa-pi/shared";
import { api } from "../../api-client";
import { useTranslation } from "../../i18n/useTranslation";
import { Modal } from "../ui/Modal";
import { MODAL_POS_KEYS } from "../ui/modal-position";
import { MODAL_SIZE_KEYS } from "../ui/modal-size";
import { ThinkingCard } from "./ThinkingCard";
import { ToolCallCard } from "./ToolCallCard";
import { Markdown } from "./Markdown";
import { useLiveElapsed } from "./useLiveElapsed";
import { Icon } from "../ui/Icon";
import { fmtTok } from "../../util/format";
import { copyToClipboard } from "../../util/clipboard";
import { useToastStore } from "../../store/toast";
import { useSessionStore } from "../../store/session";

/** 转录接口返回的 meta（kernel SubagentMeta 的可渲染子集；未用到的字段不声明） */
export interface TranscriptMeta {
	agentId: string;
	subagentType: string;
	status: "running" | "completed" | "failed" | "interrupted";
	/** 实例创建时刻（epoch ms；spawn 前生成）。运行期 `elapsedMs` 还没落盘，靠它本地推算耗时 */
	createdAt?: number;
	/** 同一次委托（delegate 调用）的公共 id：同 toolCallId 的实例构成左侧列表 */
	toolCallId?: string;
	/** fleet 内序号；单委托为 null */
	taskIndex?: number | null;
	/** 子代理收到的任务正文 */
	task?: string;
	elapsedMs?: number;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		total?: number;
	};
}

/** 时间线可渲染段：任务（user 消息）/ 思考 / 工具（配对后带结果）/ 正文 */
export type TranscriptSegment =
	| { kind: "task"; text: string }
	| { kind: "thinking"; text: string }
	| { kind: "text"; text: string }
	| { kind: "tool"; toolCall: ToolCall; toolResult?: ToolResultMessage };

/** 视图筛选：全部 / 思考 / 工具 / 正文（纯前端过滤，不触发请求） */
export type TranscriptFilter = "all" | "thinking" | "tool" | "text";

/** 取 user 消息的文本：content 可能是 string 或 [{type:"text",text}] 数组 */
function userText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return (content as Array<Record<string, unknown>>)
		.filter((b) => b?.type === "text" && typeof b.text === "string")
		.map((b) => b.text as string)
		.join("\n")
		.trim();
}

/**
 * 把会话消息数组拍平成可渲染段；toolCall 与 toolResult 按 toolCallId 配对。
 * - **user 消息渲染为 task 段**（规格 §6）：resume 时每轮任务都作为新一轮 user 消息追加进
 *   同一份历史，不渲染就看不到续聊那轮下发了什么（用户实测：「第二次发出去的任务，没有写在
 *   正文里面，只能看到第一次下发的」）。
 * - 简单任务的模型可能**完全没有 thinking 块**（R5）：思考段缺失不影响工具/正文成段。
 * - 空/纯空白块跳过，避免渲染空气泡。
 * - 找不到配对 toolCall 的 toolResult 直接忽略（没有可挂靠的卡片）。
 */
export function buildTranscriptSegments(
	messages: SessionMessage[],
): TranscriptSegment[] {
	const out: TranscriptSegment[] = [];
	const pending = new Map<string, number>(); // toolCallId → out 里的下标
	for (const m of messages) {
		const msg = m?.message as { role?: string; content?: unknown } | undefined;
		if (!msg) continue;
		if (msg.role === "user") {
			const text = userText(msg.content);
			if (text) out.push({ kind: "task", text });
		} else if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content as Array<Record<string, unknown>>) {
				if (
					block?.type === "thinking" &&
					typeof block.thinking === "string" &&
					block.thinking.trim()
				) {
					out.push({ kind: "thinking", text: block.thinking });
				} else if (
					block?.type === "text" &&
					typeof block.text === "string" &&
					block.text.trim()
				) {
					out.push({ kind: "text", text: block.text });
				} else if (block?.type === "toolCall" && typeof block.id === "string") {
					pending.set(block.id, out.length);
					out.push({ kind: "tool", toolCall: block as unknown as ToolCall });
				}
			}
		} else if (msg.role === "toolResult") {
			const id = (msg as { toolCallId?: string }).toolCallId;
			const at = id ? pending.get(id) : undefined;
			if (at != null) {
				const seg = out[at];
				if (seg.kind === "tool") {
					seg.toolResult = msg as unknown as ToolResultMessage;
				}
			}
		}
	}
	return out;
}

/** 段 → 纯文本（「复制全文」用）：思考 / 工具（含参数与结果）/ 正文依次拼接 */
export function segmentsToPlainText(segments: TranscriptSegment[]): string {
	const parts: string[] = [];
	for (const s of segments) {
		if (s.kind === "task") {
			parts.push(`[任务]\n${s.text}`);
		} else if (s.kind === "thinking") {
			parts.push(`[思考]\n${s.text}`);
		} else if (s.kind === "text") {
			parts.push(s.text);
		} else {
			const args = JSON.stringify(s.toolCall.arguments ?? {});
			const result = (s.toolResult?.content ?? [])
				.map((c) => (c?.type === "text" ? c.text : ""))
				.filter(Boolean)
				.join("\n");
			parts.push(`[工具] ${s.toolCall.name}(${args})${result ? `\n${result}` : ""}`);
		}
	}
	return parts.join("\n\n");
}

/** 子代理运行中，弹窗按此间隔重新拉取转录，跟到最新已落盘内容（2026-10-02 需求：
 *  「弹窗查看子代理委托，也需要根据实时进度更新」）。导出仅为测试可控。 */
export const TRANSCRIPT_POLL_MS = 2000;

/** 该 agentId 当前是否仍在运行（从 store 实时读，不走组件闭包）。
 *  用途：区分两种「详情取不到」——实例还在跑 = 转录尚未落盘（该等），不在跑 = 真的没有转录。
 *  用 getState() 而非 selector：轮询回调是 effect 首次建立的闭包，selector 值不进去，
 *  读实时值才能在「刚跑完 / 刚落盘」的边界上判对。 */
function isInstanceRunning(agentId: string): boolean {
	const map = useSessionStore.getState().progressByToolCall;
	for (const byIndex of Object.values(map)) {
		for (const ev of Object.values(byIndex)) {
			if (ev.agentId === agentId) return ev.status === "running";
		}
	}
	return false;
}

/** 耗时紧凑格式：<60s 用秒，否则 m 分 s 秒 */
function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	if (total < 60) return `${total}s`;
	const m = Math.floor(total / 60);
	const s = total % 60;
	return s ? `${m}m ${s}s` : `${m}m`;
}

export function SubagentTranscriptModal({
	open,
	onClose,
}: {
	open: { sessionId: string; agentId: string } | null;
	onClose: () => void;
}) {
	// open 为空即卸载内容：既满足「按需加载」（关闭即丢数据、重开重拉），
	// 也让 ui/Modal 重新挂载后按持久化键重读上次的位置与尺寸。
	if (!open) return null;
	return (
		<TranscriptDialog
			key={`${open.sessionId}:${open.agentId}`}
			sessionId={open.sessionId}
			initialAgentId={open.agentId}
			onClose={onClose}
		/>
	);
}

function TranscriptDialog({
	sessionId,
	initialAgentId,
	onClose,
}: {
	sessionId: string;
	initialAgentId: string;
	onClose: () => void;
}) {
	const { t } = useTranslation();
	const [agentId, setAgentId] = useState(initialAgentId);
	const [data, setData] = useState<{
		meta: TranscriptMeta;
		messages: SessionMessage[];
	} | null>(null);
	const [state, setState] = useState<"loading" | "ok" | "missing">("loading");
	const [filter, setFilter] = useState<TranscriptFilter>("all");
	const [group, setGroup] = useState<TranscriptMeta[]>([]);

	// 转录本体：打开时拉一次；切换实例（agentId 变化）重拉；子代理仍在运行则按 ~2s 轮询跟进
	// （「查看执行过程」要看到实时进度）。筛选不算依赖 → 切筛选不请求。
	// 轮询停止条件：meta.status 不再是 running（完成/失败/中断）、请求失败（404/网络异常——
	// 不再无限重试打服务）、组件卸载或切实例（cancelled）。
	// 轮询重拉时**不**回到 loading 态、不清 data：时间线不能每 2 秒闪一次空白。
	useEffect(() => {
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		setState("loading");
		setData(null);
		const load = () => {
			api
				.get(
					`/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(agentId)}`,
				)
				.then((body) => {
					if (cancelled) return;
					const payload = body as {
						meta: TranscriptMeta;
						messages: SessionMessage[];
					};
					setData(payload);
					setState("ok");
					// 仍在跑 → 继续跟进；终态即停（此后 jsonl 不再增长，再拉只是白耗）
					if (payload?.meta?.status === "running") {
						timer = setTimeout(load, TRANSCRIPT_POLL_MS);
					}
				})
				.catch(() => {
					if (cancelled) return;
					// 详情取不到（404/400）：两种情形要分开处理——
					// ① 实例**还在跑**：jsonl/meta 尚未落盘（用户实测：子代理刚 spawn 时点进去
					//    会误报「此委托早于转录功能上线」且不再刷新）→ 保持 loading，继续按间隔
					//    重试，落盘后自动加载出内容；
					// ② 实例不在跑：真的没有可看的转录（老数据 / 无效 id）→ 落空态并停拉。
					// 每次重试都重判（不在跑之后不会再无限试）。
					if (isInstanceRunning(agentId)) {
						setState("loading");
						timer = setTimeout(load, TRANSCRIPT_POLL_MS);
					} else {
						setState("missing");
					}
				});
		};
		load();
		return () => {
			cancelled = true;
			if (timer !== undefined) clearTimeout(timer);
		};
	}, [sessionId, agentId]);

	// 会话内实例清单：用于左侧列表（仅同一次委托 ≥2 个实例时展示）。失败静默降级为不展示。
	useEffect(() => {
		let cancelled = false;
		api
			.get(`/api/sessions/${encodeURIComponent(sessionId)}/subagents`)
			.then((body) => {
				if (cancelled) return;
				const list = (body as { subagents?: TranscriptMeta[] })?.subagents ?? [];
				setGroup(list);
			})
			.catch(() => {
				/* 列表拿不到：不显示左侧列表（单委托形态） */
			});
		return () => {
			cancelled = true;
		};
	}, [sessionId]);

	const segments = useMemo(
		() => buildTranscriptSegments(data?.messages ?? []),
		[data],
	);
	const visible = useMemo(
		() => segments.filter((s) => filter === "all" || s.kind === filter),
		[segments, filter],
	);
	// 历史里已经有 task 段（每轮任务都作为 user 消息落在 jsonl）时，顶部不再重复挂 meta.task；
	// 仅当 jsonl 里没有 user 消息（异常/旧数据）时用它兜底。判定用未过滤的 segments。
	const hasTaskSegment = segments.some((s) => s.kind === "task");
	// 同一次委托（toolCallId 相同）的实例，按 fleet 序号排序。
	// 分组依据必须是**会话级列表**而非详情响应：详情一开始 setData(null)、目标实例 404 时 data 长期为 null，
	// 绑详情会让左栏在每次切换的加载窗口内被卸载（闪烁），且目标 jsonl 缺失时左栏永久消失（只能关掉弹窗重开）。
	const siblings = useMemo(() => {
		const tc = group.find((g) => g.agentId === agentId)?.toolCallId;
		if (!tc) return [];
		return group
			.filter((s) => s.toolCallId === tc)
			.sort((a, b) => (a.taskIndex ?? 0) - (b.taskIndex ?? 0));
	}, [group, agentId]);

	const meta = data?.meta;
	// 耗时：运行期必须本地推算——`meta.elapsedMs` 只在 settle 时写盘，运行中恒为 0
	//（2026-10-02 用户实测：子代理跑着、弹窗内容在实时涨，标题栏却一直「运行中 · 0s」）。
	// 起点取 createdAt（绝对时刻，重拉 / 重挂载都不丢，秒数连续不回跳）；终态由 hook 冻结为后端终值。
	const elapsedSeconds = useLiveElapsed(
		meta?.elapsedMs,
		meta?.status === "running",
		meta?.createdAt,
	);
	const toolCount = segments.filter((s) => s.kind === "tool").length;
	const stepCount = (data?.messages ?? []).filter(
		(m) => (m?.message as { role?: string } | undefined)?.role === "assistant",
	).length;
	const usage = meta?.usage;
	const statusLabel = (status: string): string => {
		if (status === "running") return t("common.statusRunning");
		if (status === "failed") return t("common.statusError");
		if (status === "interrupted") return t("common.statusInterrupted");
		return t("common.statusDone");
	};

	const copyAll = async () => {
		try {
			await copyToClipboard(segmentsToPlainText(segments));
			useToastStore.getState().add(t("common.copiedToClipboard"), "success");
		} catch {
			useToastStore.getState().add(t("common.copyFailed"), "error");
		}
	};

	return (
		<Modal
			onClose={onClose}
			width="80vw"
			height="80vh"
			resizable
			draggable
			sizeStorageKey={MODAL_SIZE_KEYS.transcript}
			positionStorageKey={MODAL_POS_KEYS.transcript}
			data-testid="subagent-transcript-modal"
		>
			<div
				role="dialog"
				aria-modal="true"
				aria-label={t("blocks.delegate.transcriptTitle")}
				className="flex h-full flex-col"
			>
				{/* 标题栏：拖拽把手（data-modal-drag-handle），按钮等交互元素不触发拖动 */}
				<div
					data-modal-drag-handle=""
					className="flex items-center gap-1 border-b border-hairline bg-surface px-3 py-2"
				>
					<span className="text-[calc(12px*var(--font-scale))] text-primary font-medium">
						{t("blocks.delegate.transcriptTitle")}
					</span>
					<span
						data-testid="transcript-meta"
						className="text-[calc(11px*var(--font-scale))] text-tertiary min-w-0 flex-1 truncate"
					>
						{meta ? `${meta.subagentType} · ${agentId} · ${statusLabel(meta.status)}` : agentId}
						{meta
							? ` · ${formatElapsed(elapsedSeconds * 1000)}${
									usage?.total != null ? ` · ${fmtTok(usage.total)}` : ""
								}`
							: ""}
					</span>
					<button
						className="fv-btn"
						onClick={onClose}
						title={t("common.close")}
						aria-label={t("common.close")}
					>
						<Icon name="x" size={12} />
					</button>
				</div>

				<div className="flex min-h-0 flex-1">
					{/* 左侧实例列表：仅同一次委托有 ≥2 个实例时出现（单委托隐藏） */}
					{siblings.length > 1 && (
						<div
							data-testid="transcript-siblings"
							className="w-44 shrink-0 overflow-y-auto border-r border-hairline py-2 text-[calc(12px*var(--font-scale))]"
						>
							{siblings.map((s) => (
								<button
									key={s.agentId}
									data-testid={`transcript-sibling-${s.agentId}`}
									onClick={() => setAgentId(s.agentId)}
									className={`block w-full px-3 py-1.5 text-left ${
										s.agentId === agentId ? "bg-accent-soft" : "hover:bg-surface-hover"
									}`}
								>
									<span className="text-primary font-medium">{s.subagentType}</span>
									<span className="text-tertiary ml-2 font-mono text-[calc(10px*var(--font-scale))]">
										{s.agentId}
									</span>
								</button>
							))}
						</div>
					)}

					<div className="flex min-w-0 flex-1 flex-col">
						{/* 视图筛选：纯前端过滤（不发请求） */}
						<div className="flex justify-center gap-1 border-b border-hairline px-3 py-1.5 text-[calc(11px*var(--font-scale))]">
							{(["all", "thinking", "tool", "text"] as const).map((f) => (
								<button
									key={f}
									data-testid={`transcript-filter-${f}`}
									onClick={() => setFilter(f)}
									className={`rounded-pill px-2.5 py-0.5 ${
										filter === f
											? "bg-accent text-white"
											: "text-secondary hover:bg-surface-hover"
									}`}
								>
									{t(`blocks.delegate.filter.${f}`)}
								</button>
							))}
						</div>

						{/* 时间线：任务 → 思考 → 工具 → 正文 */}
						<div
							data-testid="transcript-timeline"
							className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-[calc(12px*var(--font-scale))]"
						>
							{state === "loading" && (
								/* 骨架屏：实例可能刚 spawn、转录尚未落盘，等落盘后会自行加载出内容 */
								<div
									data-testid="transcript-loading"
									aria-busy="true"
									className="space-y-2"
								>
									{[0, 1, 2, 3].map((i) => (
										<div
											key={i}
											className="h-9 rounded-lg bg-surface-hover animate-pulse"
											style={{ width: `${94 - i * 14}%` }}
										/>
									))}
								</div>
							)}
							{state === "missing" && (
								<p data-testid="transcript-missing" className="text-tertiary">
									{t("blocks.delegate.transcriptMissing")}
								</p>
							)}
							{state === "ok" && (
								<>
									{/* meta.task 是实例的**首轮**任务快照（规格 §5：供审计）；每轮任务已由 user 消息
									    在时间线里成 task 段，故仅在历史里没有 task 段时才用它兜底显示 */}
									{!hasTaskSegment && meta?.task && (
										<div
											data-transcript-block="task"
											className="mb-3 rounded-lg border border-hairline bg-surface px-2.5 py-1.5"
										>
											<div className="text-[calc(11px*var(--font-scale))] text-tertiary font-semibold">
												{t("blocks.delegate.taskLabel")}
											</div>
											<div className="text-secondary whitespace-pre-wrap break-words">
												{meta.task}
											</div>
										</div>
									)}
									{visible.map((s, i) => (
										<div
											key={i}
											data-block={s.kind}
											data-transcript-block={s.kind}
											className="mb-3"
										>
											{s.kind === "task" && (
												<div className="rounded-lg border border-hairline bg-surface px-2.5 py-1.5">
													<div className="text-[calc(11px*var(--font-scale))] text-tertiary font-semibold">
														{t("blocks.delegate.taskLabel")}
													</div>
													<div className="text-secondary whitespace-pre-wrap break-words">
														{s.text}
													</div>
												</div>
											)}
											{s.kind === "thinking" && <ThinkingCard thinking={s.text} />}
											{s.kind === "tool" && (
												<ToolCallCard toolCall={s.toolCall} result={s.toolResult} />
											)}
											{s.kind === "text" && (
												<Markdown text={s.text} interactive={false} testId={null} />
											)}
										</div>
									))}
								</>
							)}
						</div>

						{/* 底部用量：工具数 · 步数 · 输入 / 输出 / 缓存读 + 复制全文 */}
						<div
							data-testid="transcript-footer"
							className="text-[calc(11px*var(--font-scale))] text-tertiary flex items-center gap-3 border-t border-hairline px-4 py-1.5"
						>
							<span>{t("blocks.delegate.toolCount", { n: toolCount })}</span>
							<span>{t("blocks.delegate.stepCount", { n: stepCount })}</span>
							<span>{t("blocks.delegate.usageInput", { v: fmtTok(usage?.input ?? 0) })}</span>
							<span>{t("blocks.delegate.usageOutput", { v: fmtTok(usage?.output ?? 0) })}</span>
							<span>
								{t("blocks.delegate.usageCacheRead", { v: fmtTok(usage?.cacheRead ?? 0) })}
							</span>
							<button
								className="ml-auto text-secondary hover:text-primary"
								onClick={copyAll}
								data-testid="transcript-copy-all"
							>
								{t("blocks.delegate.copyAll")}
							</button>
						</div>
					</div>
				</div>
			</div>
		</Modal>
	);
}
