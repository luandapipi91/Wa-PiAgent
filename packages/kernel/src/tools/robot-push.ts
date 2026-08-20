import type { ChannelManager } from "../channel-manager";
import type { ImPushInjection } from "../agent-manager";

// ---------------------------------------------------------------------------
// @im-push-to(ch_xxx,ct_xxx) 函数式标记（唯一格式；旧 @ch_/@ct_ 裸标记已废弃）。
// bot 段为联系人所属渠道，信息性保留；推送路由以联系人自身 channelId 为准。
// ---------------------------------------------------------------------------

/** 匹配完整的 @im-push-to(ch_xxx,ct_xxx) 标记 */
const IM_PUSH_MENTION_RE =
	/@im-push-to\(ch_[a-zA-Z0-9_-]+,ct_[a-zA-Z0-9_-]+\)/g;

/** 提取 prompt 中全部 @im-push-to 标记的联系人 id（去重，只取 ct_ 段） */
export function parseImPushMentions(prompt: string): string[] {
	const matches = prompt.match(IM_PUSH_MENTION_RE) ?? [];
	const ids = matches
		.map((m) => m.match(/ct_[a-zA-Z0-9_-]+/)?.[0] ?? "")
		.filter(Boolean);
	return [...new Set(ids)];
}

/** 定时任务推送目标的系统提示（注入 system prompt 的 im-push 段，而非拼进 prompt）。
 *  有 @im-push-to 标记时返回引导：明确标记语义（非智能体引用，防 delegate 误判）+ 推送工具用法。
 *  LLM 不会天然理解 @im-push-to(...) 是推送目标，不加提示会把它当普通文本。 */
export function buildImPushSystemPrompt(contactIds: string[]): string {
	if (contactIds.length === 0) return "";
	return `任务指令中的 @im-push-to(渠道,联系人) 标记（如 ${contactIds[0]}）表示推送目标联系人，它们不是智能体引用，不要对其调用 delegate。请完成任务后用 im_push_to 工具把结果推送给这些联系人。`;
}

/** 通用 IM 推送引导：注入所有非定时任务会话 system prompt 的 im-push 段（常驻）。
 *  背景：im_push_to 工具始终注册后，主聊天会话消息里也可能出现 @im-push-to 标记；
 *  系统提示词在进程 spawn 时定死、无法预知联系人，故引导不含具体目标——
 *  联系人 id 由消息中的标记自描述，kernel 会话注册表按标记动态激活推送能力。
 *  定时任务会话仍用 buildImPushSystemPrompt（含具体目标），优先级高于本通用文案。 */
export const GENERIC_IM_PUSH_PROMPT =
	"用户消息中可能出现 @im-push-to(渠道,联系人) 标记，它们表示任务结果的 IM 推送目标联系人，不是智能体引用，不要对其调用 delegate。出现该标记时，完成任务后调用 im_push_to 工具把结果推送给标记中的联系人（contact 参数填标记里的 ct_xxx）；消息中没有该标记时不要调用 im_push_to。";

interface ImPushResultPayload {
	targetId: string;
	success: boolean;
	error?: string;
}
export interface ImPushToolDeps {
	channelManager: ChannelManager;
	/** 任务 prompt 中解析出的目标联系人（ct_xxx ID 列表） */
	contactIds: string[];
	/** 推送结果回调（供调度器收集 pushResults） */
	onPushResult: (result: ImPushResultPayload) => void;
}

/** im_push_to 工具定义（兼容 pi RPC 工具格式） */
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

/** 构建 im_push_to 工具定义（动态填充 contact enum；仅 pushToContact 主动推送） */
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
				// 诊断：定位推送乱码发生在 kernel 之前还是之后（记录实际收到的 message 原文+字节长）
				console.log(
					`[im-push-diagnose] contact=${contact} message=${JSON.stringify(message)} byteLength=${Buffer.byteLength(message, "utf8")}`,
				);
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

/** 定时任务 im_push_to 注入构造：
 *  有 @im-push-to 标记 → 白名单（仅标记联系人）+ 结果收集（onPushResult 回填执行记录）；
 *  无标记 → 拒绝型注入——无人值守任务必须显式声明推送目标才允许推送，
 *  防止 agent 误调时落到主聊天全局 executor（可推任意联系人）。 */
export function buildScheduledImPush(
	contactIds: string[],
	deps: {
		channelManager: ChannelManager;
		onPushResult: (r: ImPushResultPayload) => void;
	},
): ImPushInjection {
	if (contactIds.length === 0) {
		return {
			targets: [],
			execute: async () =>
				"本任务未配置推送目标：任务指令中需包含 @im-push-to(渠道,联系人) 标记",
		};
	}
	const tool = createImPushTool({
		channelManager: deps.channelManager,
		contactIds,
		onPushResult: deps.onPushResult,
	});
	return {
		targets: contactIds,
		execute: (contact, message) => tool.execute({ contact, message }),
	};
}
