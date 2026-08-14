import type { ChannelManager } from "../channel-manager";

/** 正则匹配 prompt 中的 @bot_xxx 标记（不匹配邮箱：邮箱里 @ 后面是域名，不以 bot_ 开头） */
const BOT_MENTION_RE = /@bot_[a-zA-Z0-9_-]+/g;

/** 从 prompt 中解析所有 @bot_xxx 渠道 ID（去重，去掉 @ 前缀） */
export function parseChannelMentions(prompt: string): string[] {
	const matches = prompt.match(BOT_MENTION_RE) ?? [];
	const ids = matches.map((m) => m.slice(1)); // 去掉 @ 前缀 → "bot_xxx"
	return [...new Set(ids)];
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
	const channelList = deps.availableChannelIds.join(", ");
	return {
		name: "robot_push",
		description: `推送消息到 IM 渠道。可用渠道：${channelList}。根据任务指令中 @ 标记的渠道选择目标。`,
		inputSchema: {
			type: "object",
			properties: {
				channel: {
					type: "string",
					enum: deps.availableChannelIds,
					description: "目标推送渠道 ID（如 bot_xxxx）",
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
			if (!deps.availableChannelIds.includes(channel)) {
				return `错误：渠道 ${channel} 不在可用列表中`;
			}
			try {
				await deps.channelManager.pushToChannel(channel, message);
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
