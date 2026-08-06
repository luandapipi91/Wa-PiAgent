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
import { chunkByBytes, composeReply } from "./channels/reply-composer";
import type { ChannelAdapter, InboundMessage } from "./channels/types";
import { MockAdapter } from "./channels/mock-adapter";
import { expandSkillTokens } from "./channels/skill-expand";
import type { AgentManager } from "./agent-manager";
import type { ConfigStore } from "./config-store";
import type { ProjectStore } from "./project-store";

type AdapterFactory = (channel: ChannelConfig) => ChannelAdapter;

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
	skillManager?: { scan(): Promise<{ skills: { name: string; path: string }[] }> };
}

export class ChannelManager {
	private adapters = new Map<string, ChannelAdapter>();
	private statuses = new Map<string, { status: ChannelStatus; detail?: string }>();
	/** channelId:chatId → 最近一条进站帧（被动回复必须携带） */
	private lastFrames = new Map<string, unknown>();
	/** sessionId → 回复基线（getMessages 下标），agent_end 后更新，避免排队回合重复回复 */
	private replyBaseline = new Map<string, number>();
	/** sessionId → 映射键，onSessionEvent 反查用 */
	private sessionIndex = new Map<string, string>();
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
			if (ch.enabled) await this.connectChannel(ch);
		}
	}

	async stop(): Promise<void> {
		for (const a of this.adapters.values()) await a.disconnect().catch(() => {});
		this.adapters.clear();
	}

	async listWithStatus(): Promise<ChannelStatusInfo[]> {
		const channels = await loadChannels(this.channelsFile);
		return channels.map((c) => ({
			...c,
			credentials: { botId: c.credentials.botId, secret: maskSecret(c.credentials.secret) },
			status: this.statuses.get(c.id)?.status ?? (c.enabled ? "connecting" : "disconnected"),
			statusDetail: this.statuses.get(c.id)?.detail,
		}));
	}

	async create(input: Omit<ChannelConfig, "id" | "createdAt">): Promise<void> {
		const err = validateChannelInput(input);
		if (err) throw new Error(err);
		const channels = await loadChannels(this.channelsFile);
		if (channels.some((c) => c.credentials.botId === input.credentials.botId)) {
			throw new Error("Bot ID 已被其他机器人使用（同一 Bot ID 仅允许一条长连接）");
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
		const next = { ...channels[idx], ...patch, id, createdAt: channels[idx].createdAt };
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
			throw new Error("Bot ID 已被其他机器人使用（同一 Bot ID 仅允许一条长连接）");
		}
		channels[idx] = next;
		await saveChannels(channels, this.channelsFile);
		// 重建连接（先断后连，enabled 才连）
		await this.adapters.get(id)?.disconnect().catch(() => {});
		this.adapters.delete(id);
		if (next.enabled) await this.connectChannel(next);
		else this.statuses.set(id, { status: "disconnected" });
		// 提示词/模型/智能体变更需重建会话进程生效
		this.deps.agentManager.markAllDirty();
		this.deps.broadcast({ type: "channels:changed" });
	}

	async remove(id: string): Promise<void> {
		const channels = await loadChannels(this.channelsFile);
		await saveChannels(channels.filter((c) => c.id !== id), this.channelsFile);
		await this.adapters.get(id)?.disconnect().catch(() => {});
		this.adapters.delete(id);
		this.statuses.delete(id);
		this.deps.broadcast({ type: "channels:changed" });
	}

	/** 智能体被渠道引用的统计（删除智能体确认提示用） */
	async agentUsage(agentName: string): Promise<{ count: number; channelNames: string[] }> {
		const channels = await loadChannels(this.channelsFile);
		const used = channels.filter((c) => c.agentName === agentName).map((c) => c.name);
		return { count: used.length, channelNames: used };
	}

	async listConversations(): Promise<ChannelConversationInfo[]> {
		const [mappings, channels, { projects }] = await Promise.all([
			loadChannelMappings(this.mappingsFile),
			loadChannels(this.channelsFile),
			this.deps.projectStore.load(),
		]);
		const result: ChannelConversationInfo[] = [];
		for (const m of mappings) {
			const channel = channels.find((c) => c.id === m.channelId);
			if (!channel) continue; // 渠道已删：历史映射不在列表显示
			const sessionId = m.sessions[m.currentProjectId];
			if (!sessionId) continue;
			const project = projects.find((p) => p.id === m.currentProjectId);
			result.push({
				channelId: m.channelId,
				channelName: channel.name,
				channelType: channel.type,
				chatId: m.chatId,
				chatType: m.chatType,
				sessionId,
				projectId: m.currentProjectId,
				projectName: project?.name ?? m.currentProjectId,
				lastMessagePreview: m.lastMessagePreview,
				updatedAt: m.updatedAt,
			});
		}
		return result.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	/** 由 index.ts 的 AgentManager onEvent 挂钩（throttle 之前调用，agent_end 不可被节流丢弃） */
	onSessionEvent(sessionId: string, event: { type: string; [k: string]: any }): void {
		if (event.type !== "agent_end") return;
		const key = this.sessionIndex.get(sessionId);
		if (!key) return; // 非渠道会话
		void this.replyTurn(sessionId, key, event).catch((e) =>
			console.warn("[channel-manager] 回复失败:", e),
		);
	}

	/** mock 测试端点：注入进站消息 / 读取出站记录 */
	mockInbound(channelId: string, chatId: string, text: string): void {
		const a = this.adapters.get(channelId);
		if (a instanceof MockAdapter) a.inject({ chatId, text });
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
			this.statuses.set(channel.id, { status: "error", detail: `渠道类型 ${channel.type} 暂未支持` });
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
		const key = `${channel.id}:${msg.chatId}`;
		this.lastFrames.set(key, msg.replyFrame);
		const reply = async (text: string) => {
			for (const chunk of chunkByBytes(text)) {
				await adapter.sendText(msg.replyFrame, chunk);
			}
		};

		if (msg.unsupported) {
			await reply(`暂不支持该消息类型（${msg.unsupported}），请发送文本或图片。`);
			return;
		}

		// 找/建映射
		const mappings = await loadChannelMappings(this.mappingsFile);
		let mapping = mappings.find((m) => m.channelId === channel.id && m.chatId === msg.chatId);
		const isNewMapping = !mapping;
		if (isNewMapping) {
			mapping = {
				channelId: channel.id,
				chatId: msg.chatId,
				chatType: msg.chatType,
				currentProjectId: SYSTEM_PROJECT_ID,
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
			});
			if (cmd.handled) {
				if (cmd.switchProjectId) {
					mapping.currentProjectId = cmd.switchProjectId;
					mapping.updatedAt = Date.now();
					await persist();
				}
				if (cmd.resetSession) {
					delete mapping.sessions[mapping.currentProjectId];
					await persist();
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
			await reply("机器人未配置可用模型：请在设置页为机器人或关联智能体指定模型。");
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
				{ imChannelContext: channel.extraSystemPrompt ? expandSkillTokens(channel.extraSystemPrompt, skills) : undefined },
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

			this.replyBaseline.set(sessionId, this.deps.agentManager.getMessages(sessionId).length);
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
	private async loadSkillContents(): Promise<{ name: string; content: string }[]> {
		if (!this.deps.skillManager) return [];
		const { skills } = await this.deps.skillManager
			.scan()
			.catch(() => ({ skills: [] as { name: string; path: string }[] }));
		const result: { name: string; content: string }[] = [];
		for (const s of skills) {
			try {
				result.push({ name: s.name, content: await readFile(join(s.path, "SKILL.md"), "utf8") });
			} catch {
				/* 单个技能读取失败不阻塞 */
			}
		}
		return result;
	}

	/** 智能体解析：渠道指定 → 删除兜底 listAgents()[0]（与前端新建会话的默认规则一致） */
	private async resolveAgent(channel: ChannelConfig): Promise<AgentConfig | null> {
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

	/** 会话解析：__system__ 需先 mkdir 与 createdAt 严格同名的目录（既有 ws-server 约定） */
	private async ensureSession(
		mapping: ChannelSessionMapping,
		agent: AgentConfig,
	): Promise<string> {
		const existing = mapping.sessions[mapping.currentProjectId];
		if (existing) return existing;
		const createdAt = Date.now();
		if (mapping.currentProjectId === SYSTEM_PROJECT_ID) {
			await mkdir(join(SYSTEM_PROJECT_CWD, String(createdAt)), { recursive: true });
		}
		const session = await this.deps.projectStore.createSession({
			projectId: mapping.currentProjectId,
			primaryAgent: agent.displayName,
			title: `IM · ${mapping.chatId.slice(0, 12)}`,
			id: `im-${mapping.channelId}-${mapping.currentProjectId}-${createdAt}`,
			createdAt,
		});
		mapping.sessions[mapping.currentProjectId] = session.id;
		return session.id;
	}

	/** agent_end → 按粒度组装回复（stopReason=error 或空正文 → 错误提示） */
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

		let text: string;
		if (event.stopReason === "error") {
			text = `处理出错：${event.error ?? "未知错误"}`;
		} else {
			text = composeReply(turn, channel.replyGranularity);
			if (!text) text = "（本轮无文本回复）";
		}
		for (const chunk of chunkByBytes(text)) {
			await adapter.sendText(frame, chunk);
		}
	}
}
