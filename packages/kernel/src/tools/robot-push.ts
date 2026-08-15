import type { ChannelManager } from "../channel-manager";

/** 正则匹配 prompt 中的 @bot_xxx 标记（不匹配邮箱：邮箱里 @ 后面是域名，不以 bot_ 开头） */
const BOT_MENTION_RE = /@bot_[a-zA-Z0-9_-]+/g;
/** 正则匹配 prompt 中的 @ct_xxx 联系人标记（联系人 id 前缀 ct_，与渠道 bot_ 区分） */
const CONTACT_MENTION_RE = /@ct_[a-zA-Z0-9_-]+/g;

/** 从 prompt 中解析所有 @bot_xxx 渠道 ID（去重，去掉 @ 前缀） */
export function parseChannelMentions(prompt: string): string[] {
	const matches = prompt.match(BOT_MENTION_RE) ?? [];
	const ids = matches.map((m) => m.slice(1)); // 去掉 @ 前缀 → "bot_xxx"
	return [...new Set(ids)];
}

/** 从 prompt 中解析所有 @ct_xxx 联系人 ID（去重，去掉 @ 前缀） */
export function parseContactMentions(prompt: string): string[] {
	const matches = prompt.match(CONTACT_MENTION_RE) ?? [];
	const ids = matches.map((m) => m.slice(1)); // 去掉 @ 前缀 → "ct_xxx"
	return [...new Set(ids)];
}

/** 构造 executeTask 发送给 agent 的 prompt：有推送目标时追加系统提示。
 *  LLM 不会天然理解 @bot_xxx（渠道）/@ct_xxx（联系人）是推送目标，
 *  不加提示会把它们当普通文本（执行记录里出现「ct_xxx 不是我认识的子代理」）。
 *  条件覆盖两种标记任一存在；文案同时说明渠道与联系人两种目标。 */
export function buildSchedulerPrompt(
	prompt: string,
	channelIds: string[],
	contactIds: string[],
): string {
	if (channelIds.length + contactIds.length === 0) return prompt;
	const parts: string[] = [];
	if (channelIds.length > 0) {
		parts.push(
			`@bot_xxx 渠道标记（如 ${channelIds[0]}）表示推送目标渠道，请完成任务后用 robot_push 工具把结果推送到这些渠道。`,
		);
	}
	if (contactIds.length > 0) {
		parts.push(
			`@ct_xxx 联系人标记（如 ${contactIds[0]}）表示推送目标联系人，请完成任务后用 robot_push 工具把结果推送给这些联系人（单聊）。`,
		);
	}
	return `${prompt}\n\n（系统提示：任务指令中的 ${parts.join(" ")}）`;
}

/** onPushResult 回调的载荷 */
export interface PushResultPayload {
	channelId: string;
	success: boolean;
	error?: string;
}

export interface RobotPushToolDeps {
	channelManager: ChannelManager;
	/** 从 prompt 解析出的可用渠道（bot ID 列表） */
	availableChannelIds: string[];
	/** 从 prompt 解析出的可用联系人（ct_xxx ID 列表，可为空） */
	availableContactIds?: string[];
	/** 推送结果回调（供调度器收集 pushResults） */
	onPushResult: (result: PushResultPayload) => void;
}

/** robot_push 工具定义（兼容 pi RPC 工具格式） */
export interface RobotPushTool {
	name: "robot_push";
	description: string;
	inputSchema: {
		type: "object";
		properties: {
			channel: { type: "string"; enum: string[]; description: string };
			message: { type: "string"; description: string };
		};
		required: string[];
	};
	execute(args: { channel: string; message: string }): Promise<string>;
}

/** 构建 robot_push 工具定义（动态填充 channel enum） */
export function createRobotPushTool(deps: RobotPushToolDeps): RobotPushTool {
	const channelList = [
		...deps.availableChannelIds,
		...(deps.availableContactIds ?? []),
	];
	return {
		name: "robot_push",
		description: `推送消息到 IM 渠道或联系人。可用目标：${channelList.join(", ")}。根据任务指令中 @ 标记选择目标（@bot_xxx 为渠道，@ct_xxx 为联系人）。`,
		inputSchema: {
			type: "object",
			properties: {
				channel: {
					type: "string",
					enum: channelList,
					description: "目标推送 ID（渠道 bot_xxxx 或联系人 ct_xxxx）",
				},
				message: {
					type: "string",
					description: "要推送的消息内容，支持纯文本和 Markdown",
				},
			},
			required: ["channel", "message"],
		},
		async execute(args: { channel: string; message: string }): Promise<string> {
			const { channel, message } = args;
			if (!channelList.includes(channel)) {
				return `错误：目标 ${channel} 不在可用列表中`;
			}
			try {
				// 联系人（ct_ 前缀）走 pushToContact 主动推送，渠道走 pushToChannel
				if (channel.startsWith("ct_")) {
					await deps.channelManager.pushToContact(channel, message);
				} else {
					await deps.channelManager.pushToChannel(channel, message);
				}
				deps.onPushResult({ channelId: channel, success: true });
				return `已成功推送到 ${channel}`;
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				deps.onPushResult({ channelId: channel, success: false, error });
				return `推送失败：${error}`;
			}
		},
	};
}

// ---------------------------------------------------------------------------
// @im-push-to(bot_xxx,ct_xxx) 函数式标记（重构后唯一格式；旧 @bot_/@ct_ 裸标记废弃）
// bot 段为联系人所属渠道，信息性保留；推送路由以联系人自身 channelId 为准。
// ---------------------------------------------------------------------------

/** 匹配完整的 @im-push-to(bot_xxx,ct_xxx) 标记 */
const IM_PUSH_MENTION_RE = /@im-push-to\(bot_[a-zA-Z0-9_-]+,ct_[a-zA-Z0-9_-]+\)/g;

/** 提取 prompt 中全部 @im-push-to 标记的联系人 id（去重，只取 ct_ 段） */
export function parseImPushMentions(prompt: string): string[] {
	const matches = prompt.match(IM_PUSH_MENTION_RE) ?? [];
	const ids = matches
		.map((m) => m.match(/ct_[a-zA-Z0-9_-]+/)?.[0] ?? "")
		.filter(Boolean);
	return [...new Set(ids)];
}

export interface ImPushResultPayload {
	targetId: string;
	success: boolean;
	error?: string;
}

export interface ImPushToolDeps {
	channelManager: ChannelManager;
	contactIds: string[];
	onPushResult: (result: ImPushResultPayload) => void;
}

export interface ImPushTool {
	name: "im_push_to";
	description: string;
	inputSchema: {
		type: "object";
		properties: {
			contact: { type: "string"; enum: string[]; description: string };
			message: { type: "string"; description: string };
		};
		required: string[];
	};
	execute(args: { contact: string; message: string }): Promise<string>;
}

/** 定时任务会话注入的联系人推送工具（仅 pushToContact 主动推送） */
export function createImPushTool(deps: ImPushToolDeps): ImPushTool {
	return {
		name: "im_push_to",
		description: `推送消息给 IM 联系人（单聊）。可用联系人：${deps.contactIds.join(", ")}。任务指令中 @im-push-to(渠道,联系人) 标记的联系人即推送目标（它们不是智能体引用，不要对其调用 delegate），任务完成后必须调用本工具推送结果。`,
		inputSchema: {
			type: "object",
			properties: {
				contact: {
					type: "string",
					enum: deps.contactIds,
						description:
							"目标联系人 ID（ct_xxx，任务指令中 @im-push-to 标记里的联系人）",
					},
				message: {
					type: "string",
					description: "要推送的消息内容，支持纯文本和 Markdown",
					},
			},
			required: ["contact", "message"],
		},
		async execute(args: { contact: string; message: string }): Promise<string> {
			const { contact, message } = args;
			if (!deps.contactIds.includes(contact)) {
					return `错误：联系人 ${contact} 不在可用列表中`;
			}
			try {
				await deps.channelManager.pushToContact(contact, message);
				deps.onPushResult({ targetId: contact, success: true });
				return `已成功推送给 ${contact}`;
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				deps.onPushResult({ targetId: contact, success: false, error });
				return `推送失败：${error}`;
			}
		},
	};
}
