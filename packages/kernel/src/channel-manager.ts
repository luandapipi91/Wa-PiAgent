import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
	CHANNELS_FILE,
	CHANNEL_SESSIONS_FILE,
	CHANNEL_TMP_DIR,
	SYSTEM_PROJECT_CWD,
	SYSTEM_PROJECT_ID,
	type AgentConfig,
	type ChannelConfig,
	type ChannelConversationInfo,
	type ChannelStatus,
	type ChannelStatusInfo,
	type ChannelType,
	type WSServerEvent,
} from "@wa-pi/shared";
import {
	loadChannelMappings,
	loadChannels,
	maskSecret,
	saveChannelMappings,
	saveChannels,
	validateChannelInput,
	type ChannelSessionMapping,
} from "./channel-store";
import { parseCommand } from "./channels/commands";
import {
	chunkByBytes,
	composeReply,
	extractAssistantText,
} from "./channels/reply-composer";
import type { ChannelAdapter, InboundMessage } from "./channels/types";
import { MockAdapter } from "./channels/mock-adapter";
import { expandSkillTokens } from "./channels/skill-expand";
import type { AgentManager } from "./agent-manager";
import type { ConfigStore } from "./config-store";
import type { ProjectStore } from "./project-store";

type AdapterFactory = (channel: ChannelConfig) => ChannelAdapter;

/** Bot ID 冲突（同一 Bot ID 已被其他渠道占用）：ws-server 据此把错误映射为 HTTP 409 */
export class ChannelConflictError extends Error {}

export interface ChannelManagerDeps {
	configStore: ConfigStore;
	projectStore: ProjectStore;
	agentManager: AgentManager;
	broadcast: (e: WSServerEvent) => void;
	/** 测试注入；缺省仅注册 mock（且需 WA_PI_CHANNELS_MOCK=1）。wecom 在 index.ts 注册 */
	adapterFactories?: Partial<Record<ChannelType, AdapterFactory>>;
	channelsFile?: string;
	mappingsFile?: string;
	tmpDir?: string;
	/** 技能管理器（结构子集）：用于展开渠道提示词里的 $[技能名] token；缺省不展开 */
	skillManager?: {
		scan(): Promise<{ skills: { name: string; path: string }[] }>;
	};
}

export class ChannelManager {
	private adapters = new Map<string, ChannelAdapter>();
	private statuses = new Map<
		string,
		{ status: ChannelStatus; detail?: string }
	>();
	/** channelId:chatId:fromUserId → 最近一条进站帧（被动回复必须携带） */
	private lastFrames = new Map<string, unknown>();
	/** sessionId → 回复基线（getMessages 下标），agent_end 后更新，避免排队回合重复回复 */
	private replyBaseline = new Map<string, number>();
	/** sessionId → 映射键，onSessionEvent 反查用 */
	private sessionIndex = new Map<string, string>();
	/** 流式回复状态：key（channelId:chatId:fromUserId）→ { streamId, 节流 timer, 最近发送时间, 挂起的最新文本 } */
	private activeStreams = new Map<
		string,
		{
			streamId: string;
			timer?: ReturnType<typeof setTimeout>;
			lastSendAt: number;
			pendingText?: string;
		}
	>();
	/** sessionId → 当前正在流式的 assistant 消息各 text block（contentIndex → 累积文本）的 delta 累积（0.84 起 RPC 无 partial 快照） */
	private streamingDeltas = new Map<string, Map<number, string>>();
	/** 流式节流最小间隔（ms）：避免每个 token 一次 WS 往返打爆企微 */
	private static readonly STREAM_THROTTLE_MS = 500;
	private factories: Partial<Record<ChannelType, AdapterFactory>>;

	constructor(private deps: ChannelManagerDeps) {
		this.factories = deps.adapterFactories ?? {};
		if (!deps.adapterFactories && process.env.WA_PI_CHANNELS_MOCK === "1") {
			this.factories.mock = (c) => new MockAdapter(c);
		}
	}

	private get channelsFile() {
		return this.deps.channelsFile ?? CHANNELS_FILE;
	}
	private get mappingsFile() {
		return this.deps.mappingsFile ?? CHANNEL_SESSIONS_FILE;
	}
	private get tmpDir() {
		return this.deps.tmpDir ?? CHANNEL_TMP_DIR;
	}

	/** 启动全部 enabled 渠道（kernel 启动时调用） */
	async start(): Promise<void> {
		for (const ch of await loadChannels(this.channelsFile)) {
			if (!ch.enabled) continue;
			try {
				await this.connectChannel(ch);
			} catch (e) {
				this.statuses.set(ch.id, {
					status: "error",
					detail: e instanceof Error ? e.message : String(e),
				});
				console.warn(`[channel-manager] 渠道「${ch.name}」启动失败:`, e);
			}
		}
	}

	async stop(): Promise<void> {
		for (const a of this.adapters.values())
			await a.disconnect().catch(() => {});
		this.adapters.clear();
	}

	async listWithStatus(): Promise<ChannelStatusInfo[]> {
		const channels = await loadChannels(this.channelsFile);
		return channels.map((c) => ({
			...c,
			credentials: {
				botId: c.credentials.botId,
				secret: maskSecret(c.credentials.secret),
			},
			status:
				this.statuses.get(c.id)?.status ??
				(c.enabled ? "connecting" : "disconnected"),
			statusDetail: this.statuses.get(c.id)?.detail,
		}));
	}

	async create(input: Omit<ChannelConfig, "id" | "createdAt">): Promise<void> {
		const err = validateChannelInput(input);
		if (err) throw new Error(err);
		const channels = await loadChannels(this.channelsFile);
		if (channels.some((c) => c.credentials.botId === input.credentials.botId)) {
			throw new ChannelConflictError(
				"Bot ID 已被其他机器人使用（同一 Bot ID 仅允许一条长连接）",
			);
		}
		const channel: ChannelConfig = {
			...input,
			id: `ch_${randomUUID().slice(0, 8)}`,
			createdAt: Date.now(),
		};
		await saveChannels([...channels, channel], this.channelsFile);
		if (channel.enabled) await this.connectChannel(channel);
		this.deps.broadcast({ type: "channels:changed" });
	}

	async update(
		id: string,
		patch: Partial<Omit<ChannelConfig, "id" | "createdAt">>,
	): Promise<void> {
		const channels = await loadChannels(this.channelsFile);
		const idx = channels.findIndex((c) => c.id === id);
		if (idx < 0) throw new Error("机器人不存在");
		const next = {
			...channels[idx],
			...patch,
			id,
			createdAt: channels[idx].createdAt,
		};
		// credentials 合并：secret 缺省（前端留空表示不修改）时保留原值
		if (patch.credentials && patch.credentials.secret === undefined) {
			next.credentials = {
				botId: patch.credentials.botId ?? channels[idx].credentials.botId,
				secret: channels[idx].credentials.secret,
			};
		}
		const err = validateChannelInput(next);
		if (err) throw new Error(err);
		if (
			channels.some(
				(c) => c.id !== id && c.credentials.botId === next.credentials.botId,
			)
		) {
			throw new ChannelConflictError(
				"Bot ID 已被其他机器人使用（同一 Bot ID 仅允许一条长连接）",
			);
		}
		channels[idx] = next;
		await saveChannels(channels, this.channelsFile);
		// 重建连接（先断后连，enabled 才连）
		await this.adapters
			.get(id)
			?.disconnect()
			.catch(() => {});
		this.adapters.delete(id);
		if (next.enabled) await this.connectChannel(next);
		else this.statuses.set(id, { status: "disconnected" });
		// 提示词/模型/智能体变更需重建会话进程生效
		this.deps.agentManager.markAllDirty();
		this.deps.broadcast({ type: "channels:changed" });
	}

	async remove(id: string): Promise<void> {
		const channels = await loadChannels(this.channelsFile);
		await saveChannels(
			channels.filter((c) => c.id !== id),
			this.channelsFile,
		);
		await this.adapters
			.get(id)
			?.disconnect()
			.catch(() => {});
		this.adapters.delete(id);
		this.statuses.delete(id);
		this.deps.broadcast({ type: "channels:changed" });
	}

	/** 会话被删除时联动清理 IM 映射（当前指针 + 历史归档）。
	 *  ws-server 的 session:delete 分支在删完 ProjectStore 后调用。
	 *  非 IM 会话在 mapping 里查不到 → no-op。 */
	async onSessionDeleted(sessionId: string): Promise<void> {
		const mappings = await loadChannelMappings(this.mappingsFile);
		let changed = false;
		for (const m of mappings) {
			for (const [pid, sid] of Object.entries(m.sessions)) {
				if (sid === sessionId) {
					delete m.sessions[pid];
					changed = true;
				}
			}
			if (m.historySessionIds?.length) {
				const before = m.historySessionIds.length;
				m.historySessionIds = m.historySessionIds.filter(
					(id) => id !== sessionId,
				);
				if (m.historySessionIds.length !== before) changed = true;
			}
		}
		if (changed) {
			await saveChannelMappings(mappings, this.mappingsFile);
			this.deps.broadcast({ type: "channel-conversations:changed" });
		}
	}

	/** 智能体被渠道引用的统计（删除智能体确认提示用） */
	async agentUsage(
		agentName: string,
	): Promise<{ count: number; channelNames: string[] }> {
		const channels = await loadChannels(this.channelsFile);
		const used = channels
			.filter((c) => c.agentName === agentName)
			.map((c) => c.name);
		return { count: used.length, channelNames: used };
	}

	async listConversations(): Promise<ChannelConversationInfo[]> {
		const [mappings, channels, { projects, sessions }] = await Promise.all([
			loadChannelMappings(this.mappingsFile),
			loadChannels(this.channelsFile),
			this.deps.projectStore.load(),
		]);
		const result: ChannelConversationInfo[] = [];
		for (const m of mappings) {
			const channel = channels.find((c) => c.id === m.channelId);
			if (!channel) continue; // 渠道已删：历史映射不在列表显示
			// 当前活跃会话（预览来自 mapping）
			const sessionId = m.sessions[m.currentProjectId];
			if (sessionId) {
				const project = projects.find((p) => p.id === m.currentProjectId);
				result.push({
					channelId: m.channelId,
					channelName: channel.name,
					channelType: channel.type,
					chatId: m.chatId,
					chatType: m.chatType,
					fromUserId: m.fromUserId ?? "",
					sessionId,
					projectId: m.currentProjectId,
					projectName: project?.name ?? m.currentProjectId,
					lastMessagePreview: m.lastMessagePreview,
					updatedAt: m.updatedAt,
				});
			}
			// 已归档的历史会话（/new 产生）：从 projectStore 查实体拿 projectId/lastActivity；
			// 实体已被删除（用户右键删过）则跳过——不展示已不存在的会话
			for (const hid of m.historySessionIds ?? []) {
				if (hid === sessionId) continue; // 去重：归档后同一会话又变成当前（理论上不会）
				const ses = sessions.find((s) => s.id === hid);
				if (!ses) continue;
				const project = projects.find((p) => p.id === ses.projectId);
				result.push({
					channelId: m.channelId,
					channelName: channel.name,
					channelType: channel.type,
					chatId: m.chatId,
					chatType: m.chatType,
					fromUserId: m.fromUserId ?? "",
					sessionId: hid,
					projectId: ses.projectId,
					projectName: project?.name ?? ses.projectId,
					lastMessagePreview: "",
					updatedAt: ses.lastActivity,
				});
			}
		}
		return result.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	/** 由 index.ts 的 AgentManager onEvent 挂钩（throttle 之前调用，agent_settled 不可被节流丢弃） */
	onSessionEvent(
		sessionId: string,
		event: { type: string; [k: string]: any },
	): void {
		const key = this.sessionIndex.get(sessionId);
		if (!key) return; // 非渠道会话

		// 消息边界（0.84 无 partial 快照，流式文本靠 delta 累积）：
		// assistant 消息开始 → 重置累积；结束 → 该消息已进 getMessages（settled 覆盖），清空累积。
		if (event.type === "message_start" && event.message?.role === "assistant") {
			this.streamingDeltas.set(sessionId, new Map());
			return;
		}
		if (event.type === "message_end") {
			this.streamingDeltas.delete(sessionId);
			return;
		}

		// 流式增量：message_update（含 text_delta）→ 节流推送累计文本
		if (event.type === "message_update") {
			// 同步累积（保序）：streamUpdate 是 async 且有 await，若在它内部累积，
			// 并发调用（同一帧多个 delta）恢复顺序不定，会把同一 contentIndex 的
			// delta 顺序打乱。这里在同步事件路径按 contentIndex 分块追加，
			// 顺序 = 事件到达顺序；streamUpdate 只读累积值推送。
			const ae = (event as any).assistantMessageEvent;
			if (ae && ae.type === "text_delta") {
				const idx = typeof ae.contentIndex === "number" ? ae.contentIndex : 0;
				const deltas =
					this.streamingDeltas.get(sessionId) ?? new Map<number, string>();
				deltas.set(idx, (deltas.get(idx) ?? "") + (ae.delta ?? ""));
				this.streamingDeltas.set(sessionId, deltas);
			}
			void this.streamUpdate(sessionId, key, event).catch((e) =>
				console.warn("[channel-manager] 流式推送失败:", e),
			);
			return;
		}

		// 用 agent_settled 而非 agent_end：pi 自动重试期间每次失败尝试都会发 agent_end，
		// 按 agent_end 回复会让 IM 用户收到多条重复错误回复；agent_settled 一轮只发一次（终态）
		if (event.type !== "agent_settled") return;
		this.streamingDeltas.delete(sessionId);
		void this.replyTurn(sessionId, key, event).catch((e) =>
			console.warn("[channel-manager] 回复失败:", e),
		);
	}

	/** 流式增量推送：本轮已落地 assistant 文本 + 当前 partial 文本，节流后经适配器 streamReply 发送。
	 *  适配器不支持 streamReply 时静默（终态 agent_settled 兜底整轮发送）。 */
	private async streamUpdate(
		sessionId: string,
		key: string,
		event: { [k: string]: any },
	): Promise<void> {
		const sep = key.indexOf(":");
		const channelId = key.slice(0, sep);
		const adapter = this.adapters.get(channelId);
		const frame = this.lastFrames.get(key);
		if (!adapter || !frame || !adapter.streamReply) return;

		// 极简回复禁用流式增量：过程文字不推送，等 agent_settled 一次性发最后一段
		const channels = await loadChannels(this.channelsFile);
		const channel = channels.find((c) => c.id === channelId);
		if (channel?.replyGranularity === "minimal") return;

		// 仅 text_delta 触发流式（工具调用阶段无 text_delta，消息自然停在上一段末尾）
		const ae = event.assistantMessageEvent;
		if (!ae || ae.type !== "text_delta") return;

		// 读取同步累积的各 text block 文本（onSessionEvent 已按 contentIndex 分块累积、
		// 保序，这里只读不再写）。按 contentIndex 升序拼接：一条消息内多个 text block
		// （thinking/toolCall 分隔）不会交错拼错，且拼接与到达顺序无关。
		const deltas = this.streamingDeltas.get(sessionId);
		const partialText = deltas
			? [...deltas.entries()]
					.sort((a, b) => a[0] - b[0])
					.map(([, t]) => t)
					.filter(Boolean)
					.join("\n")
			: "";
		const baseline = this.replyBaseline.get(sessionId) ?? 0;
		const settled = this.deps.agentManager
			.getMessages(sessionId)
			.slice(baseline);
		const settledText = extractAssistantText(settled);
		const text = [settledText, partialText].filter(Boolean).join("\n");
		if (!text) return;

		// 节流：距上次发送不足间隔则延迟到间隔后发最新文本（取最新丢中间，避免 token 风暴）
		let stream = this.activeStreams.get(key);
		if (!stream) {
			stream = { streamId: randomUUID(), lastSendAt: 0 };
			this.activeStreams.set(key, stream);
		}
		const now = Date.now();
		const elapsed = now - stream.lastSendAt;
		// 已有挂起的节流：只更新 pendingText，timer 触发时发最新的（不每个 delta 都发）
		if (stream.timer) {
			stream.pendingText = text;
			return;
		}
		if (elapsed < ChannelManager.STREAM_THROTTLE_MS) {
			stream.pendingText = text;
			stream.timer = setTimeout(() => {
				if (!stream) return;
				stream.timer = undefined;
				// 发挂起期间最新的文本；若无 pending（未被更新）发注册时的。
				// 断线窗口内 SDK send() 抛错 → sendStreamFrame reject，此处必须消费，
				// 否则 rejection 到达 setTimeout 回调无人处理 → unhandledRejection 崩溃。
				void this.sendStreamFrame(
					key,
					frame,
					stream.streamId,
					stream.pendingText ?? text,
					false,
				).catch((e) => console.warn("[channel-manager] 流式推送失败:", e));
				stream.pendingText = undefined;
			}, ChannelManager.STREAM_THROTTLE_MS - elapsed);
			return;
		}
		await this.sendStreamFrame(key, frame, stream.streamId, text, false);
	}

	/** 发送单个流式帧并更新 lastSendAt */
	private async sendStreamFrame(
		key: string,
		frame: unknown,
		streamId: string,
		content: string,
		finish: boolean,
	): Promise<void> {
		const sep = key.indexOf(":");
		const channelId = key.slice(0, sep);
		const adapter = this.adapters.get(channelId);
		if (!adapter?.streamReply) return;
		await adapter.streamReply(frame, streamId, content, finish);
		const stream = this.activeStreams.get(key);
		if (stream) stream.lastSendAt = Date.now();
		if (finish) this.activeStreams.delete(key);
	}

	/** mock 测试端点：注入进站消息 / 读取出站记录 */
	mockInbound(
		channelId: string,
		chatId: string,
		text: string,
		opts?: { fromUserId?: string; chatType?: "single" | "group" },
	): void {
		const a = this.adapters.get(channelId);
		if (a instanceof MockAdapter) a.inject({ chatId, text, ...opts });
		else throw new Error("该渠道不是 mock 类型或未启用");
	}
	mockOutbox(channelId: string): { text: string }[] {
		const a = this.adapters.get(channelId);
		if (a instanceof MockAdapter) return a.outbox;
		return [];
	}

	// ---------- 内部 ----------

	private async connectChannel(channel: ChannelConfig): Promise<void> {
		const factory = this.factories[channel.type];
		if (!factory) {
			this.statuses.set(channel.id, {
				status: "error",
				detail: `渠道类型 ${channel.type} 暂未支持`,
			});
			return;
		}
		const adapter = factory(channel);
		this.adapters.set(channel.id, adapter);
		this.statuses.set(channel.id, { status: "connecting" });
		adapter.onStatus((status, detail) => {
			this.statuses.set(channel.id, { status, detail });
			this.deps.broadcast({ type: "channels:changed" });
		});
		adapter.onMessage((msg) => {
			void this.handleInbound(channel, adapter, msg).catch((e) =>
				console.warn("[channel-manager] 进站处理失败:", e),
			);
		});
		await adapter.connect();
	}

	private async handleInbound(
		channel: ChannelConfig,
		adapter: ChannelAdapter,
		msg: InboundMessage,
	): Promise<void> {
		const key = `${channel.id}:${msg.chatId}:${msg.fromUserId}`;
		this.lastFrames.set(key, msg.replyFrame);
		const reply = async (text: string) => {
			for (const chunk of chunkByBytes(text)) {
				await adapter.sendText(msg.replyFrame, chunk);
			}
		};

		if (msg.unsupported) {
			await reply(
				`暂不支持该消息类型（${msg.unsupported}），请发送文本或图片。`,
			);
			return;
		}

		// 找/建映射：群聊按「群+用户」匹配（同群不同用户各开独立会话）；单聊 fromUserId 恒等于 chatId。
		// 旧群记录 fromUserId 为空串 → 不命中 → 自然为该用户新建 mapping（旧群会话仍可在 IM tab 右键删除）
		const mappings = await loadChannelMappings(this.mappingsFile);
		let mapping = mappings.find(
			(m) =>
				m.channelId === channel.id &&
				m.chatId === msg.chatId &&
				m.fromUserId === msg.fromUserId,
		);
		const isNewMapping = !mapping;
		if (!mapping) {
			mapping = {
				channelId: channel.id,
				chatId: msg.chatId,
				chatType: msg.chatType,
				fromUserId: msg.fromUserId,
				currentProjectId: channel.defaultProjectId ?? SYSTEM_PROJECT_ID,
				sessions: {},
				lastMessagePreview: "",
				updatedAt: Date.now(),
			};
			mappings.push(mapping);
		}
		const persist = () => saveChannelMappings(mappings, this.mappingsFile);
		// 新建映射立即落盘：即使本轮处理出错（model/智能体解析失败），会话列表也能反映该 IM 对话
		if (isNewMapping) await persist();

		// 指令拦截
		if (msg.text?.trim().startsWith("/")) {
			const { projects } = await this.deps.projectStore.load();
			const cmd = parseCommand(msg.text, {
				projects: projects.map((p) => ({ id: p.id, name: p.name })),
				currentProjectId: mapping.currentProjectId,
				allowSwitch: channel.allowProjectSwitch ?? false,
			});
			if (cmd.handled) {
				if (cmd.switchProjectId) {
					mapping.currentProjectId = cmd.switchProjectId;
					mapping.updatedAt = Date.now();
					await persist();
				}
				if (cmd.resetSession) {
					// 归档当前会话到 historySessionIds（/new 不覆盖历史：旧会话仍在 IM tab 可见、可删）
					const cur = mapping.sessions[mapping.currentProjectId];
					if (cur) {
						const hist = mapping.historySessionIds ?? [];
						if (!hist.includes(cur)) hist.push(cur);
						mapping.historySessionIds = hist;
					}
					delete mapping.sessions[mapping.currentProjectId];
					await persist();
					this.deps.broadcast({ type: "channel-conversations:changed" });
				}
				await reply(cmd.reply ?? "好的");
				return;
			}
		}

		// 渠道附加提示词中含 $ 才扫描技能（避免每条消息都 scan）；进站早期加载，供 ensureStarted 使用
		const skills = channel.extraSystemPrompt?.includes("$")
			? await this.loadSkillContents()
			: [];

		// 智能体解析（每次入站实时解析：删除立即可感知，兜底列表第一项）
		const agent = await this.resolveAgent(channel);
		if (!agent) {
			await reply("机器人配置失效：系统内没有可用智能体，请在设置页检查。");
			return;
		}
		const model = channel.model ?? agent.model;
		if (!model) {
			await reply(
				"机器人未配置可用模型：请在设置页为机器人或关联智能体指定模型。",
			);
			return;
		}

		// 会话解析（同一项目下复用稳定会话）；启动/发送失败必须回复用户，不能静默
		try {
			const sessionId = await this.ensureSession(mapping, agent);
			this.sessionIndex.set(sessionId, key);
			// 会话建立后立即落盘映射：即使后续 prompt 失败（model 无效等），
			// 侧边栏 IM 列表也能反映该对话，用户重发时可续在同一会话
			await persist();
			await this.deps.agentManager.ensureStarted(
				mapping.currentProjectId,
				agent.displayName,
				sessionId,
				{
					imChannelContext: channel.extraSystemPrompt
						? expandSkillTokens(channel.extraSystemPrompt, skills)
						: undefined,
				},
			);

			// 图片附件
			const attachments: any[] = [];
			if (msg.image && adapter.downloadImage) {
				try {
					const buf = await adapter.downloadImage(msg.image);
					const dir = join(this.tmpDir, channel.id);
					await mkdir(dir, { recursive: true });
					const name = msg.image.name ?? `${msg.msgId}.png`;
					const path = join(dir, name);
					await writeFile(path, buf);
					attachments.push({ kind: "image", name, path, size: buf.length });
				} catch {
					await reply("图片处理失败，请重发或改发文字。");
					return;
				}
			}

			this.replyBaseline.set(
				sessionId,
				this.deps.agentManager.getMessages(sessionId).length,
			);
			const text = msg.text?.trim() || (msg.image ? "请分析这张图片" : "");
			await this.deps.agentManager.prompt(sessionId, text, {
				model,
				thinking: agent.thinking ?? undefined,
				attachments: attachments.length ? attachments : undefined,
			});
		} catch (e) {
			await reply(`处理出错：${e instanceof Error ? e.message : String(e)}`);
			return;
		}

		mapping.lastMessagePreview = (msg.text ?? "[图片]").slice(0, 50);
		mapping.updatedAt = Date.now();
		await persist();
		this.deps.broadcast({ type: "channel-conversations:changed" });
	}

	/** 读取全部已启用技能的 name + SKILL.md 内容（读失败的技能跳过，不阻塞入站） */
	private async loadSkillContents(): Promise<
		{ name: string; content: string; location: string }[]
	> {
		if (!this.deps.skillManager) return [];
		const { skills } = await this.deps.skillManager
			.scan()
			.catch(() => ({ skills: [] as { name: string; path: string }[] }));
		const result: { name: string; content: string; location: string }[] = [];
		for (const s of skills) {
			try {
				const location = join(s.path, "SKILL.md");
				result.push({
					name: s.name,
					content: await readFile(location, "utf8"),
					location,
				});
			} catch {
				/* 单个技能读取失败不阻塞 */
			}
		}
		return result;
	}

	/** 智能体解析：渠道指定 → 删除兜底 listAgents()[0]（与前端新建会话的默认规则一致） */
	private async resolveAgent(
		channel: ChannelConfig,
	): Promise<AgentConfig | null> {
		const bound = await this.deps.configStore.getAgent(channel.agentName);
		if (bound) return bound;
		const agents = await this.deps.configStore.listAgents();
		if (channel.agentName && agents.length > 0) {
			console.warn(
				`[channel-manager] 渠道「${channel.name}」关联的智能体 ${channel.agentName} 已删除，降级为 ${agents[0].displayName}`,
			);
		}
		return agents[0] ?? null;
	}

	/** 会话解析：__system__ 需先 mkdir 与 createdAt 严格同名的目录（既有 ws-server 约定）。
	 *  映射里缓存的 sessionId 可能已失效（用户在前端删除了该会话，或数据文件被清理/迁移），
	 *  此时不抛"会话不存在"阻断 IM 通讯，而是兜底新建会话并更新映射。 */
	private async ensureSession(
		mapping: ChannelSessionMapping,
		agent: AgentConfig,
	): Promise<string> {
		const { projects, sessions } = await this.deps.projectStore.load();

		// 项目删除兜底：currentProjectId 指向已删除项目时降级为默认工作区
		if (!projects.some((p) => p.id === mapping.currentProjectId)) {
			console.warn(
				`[channel-manager] IM 映射 currentProjectId=${mapping.currentProjectId} 对应项目已删除，降级为默认工作区`,
			);
			mapping.currentProjectId = SYSTEM_PROJECT_ID;
		}

		const existing = mapping.sessions[mapping.currentProjectId];
		if (existing) {
			// 校验缓存的 sessionId 在 project-store 中仍存在，失效则兜底新建
			if (sessions.some((s) => s.id === existing)) {
				return existing;
			}
			// 旧会话已被删除：清除失效映射，走下方新建流程
			delete mapping.sessions[mapping.currentProjectId];
			console.warn(
				`[channel-manager] IM 映射缓存的会话 ${existing} 已失效（project-store 中不存在），兜底新建会话`,
			);
		}
		const createdAt = Date.now();
		if (mapping.currentProjectId === SYSTEM_PROJECT_ID) {
			await mkdir(join(SYSTEM_PROJECT_CWD, String(createdAt)), {
				recursive: true,
			});
		}
		const session = await this.deps.projectStore.createSession({
			projectId: mapping.currentProjectId,
			primaryAgent: agent.displayName,
			// 群聊按「群+用户」隔离，标题带发送者；单聊 chatId 即 userid，标题不变
			title:
				mapping.chatType === "group"
					? `IM · 群${mapping.chatId.slice(0, 8)} · ${mapping.fromUserId}`
					: `IM · ${mapping.chatId.slice(0, 12)}`,
			id: `im-${mapping.channelId}-${mapping.currentProjectId}-${createdAt}`,
			createdAt,
		});
		mapping.sessions[mapping.currentProjectId] = session.id;
		// 广播 session:created：前端侧边栏会话列表增量感知（本路径不经 ws-server，不广播则
		// 前端 sessions 列表无此会话，点击 IM 会话时 SessionView 因找不到 session 渲染空白）
		this.deps.broadcast({ type: "session:created", session });
		return session.id;
	}

	/** agent_settled → 按粒度组装回复（stopReason=error 或空正文 → 错误提示） */
	private async replyTurn(
		sessionId: string,
		key: string,
		event: { [k: string]: any },
	): Promise<void> {
		const sep = key.indexOf(":");
		const channelId = key.slice(0, sep);
		const adapter = this.adapters.get(channelId);
		const frame = this.lastFrames.get(key);
		if (!adapter || !frame) return;
		const messages = this.deps.agentManager.getMessages(sessionId);
		const baseline = this.replyBaseline.get(sessionId) ?? 0;
		const turn = messages.slice(baseline);
		this.replyBaseline.set(sessionId, messages.length);

		const channels = await loadChannels(this.channelsFile);
		const channel = channels.find((c) => c.id === channelId);
		if (!channel) return;

		// 找本轮最后一条 assistant 消息：错误状态（stopReason:"error"）编码在消息上，而非 agent_end 事件
		// （pi 的 AgentEndEvent 只有 {type, messages}；stopReason/errorMessage 在 AssistantMessage 上，
		// 与 agent-manager.ts:913-919 的判定方式一致）
		const lastAssistant = [...turn]
			.reverse()
			.find((m: any) => m?.role === "assistant") as any;
		let text: string;
		const isError = lastAssistant?.stopReason === "error";
		if (isError) {
			text = `处理出错：${lastAssistant.errorMessage ?? "未知错误"}`;
		} else {
			text = composeReply(turn, channel.replyGranularity);
			if (!text) text = "（本轮无文本回复）";
		}

		// 错误回合始终走 sendText（新消息，醒目）；
		// 正常回合若有活跃 stream（本轮已产生 text_delta）→ 适配器支持流式时用同 streamId
		// 发终结帧锁定消息；否则（适配器不支持 / 本轮无 text_delta）走 sendText 整轮发送。
		const stream = this.activeStreams.get(key);
		const useStream = !isError && !!adapter.streamReply && !!stream;
		if (stream?.timer) {
			clearTimeout(stream.timer);
			stream.timer = undefined;
		}
		if (useStream) {
			await this.sendStreamFrame(key, frame, stream!.streamId, text, true);
		} else {
			for (const chunk of chunkByBytes(text)) {
				await adapter.sendText(frame, chunk);
			}
			// 无活跃 stream 但 activeStreams 残留（如本轮仅工具调用无 text_delta）：清理
			this.activeStreams.delete(key);
		}
	}
}
