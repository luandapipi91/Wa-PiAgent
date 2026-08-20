import { generateReqId, WSClient, type WsFrame } from "@wecom/aibot-node-sdk";
import type { ChannelConfig, ChannelStatus } from "@wa-pi/shared";
import type { ChannelAdapter, ChannelImageRef, InboundMessage } from "./types";

/** 企微帧的 body 形状子集（仅 normalizeInbound 关心的字段，宽松以兼容 SDK 各 msgtype） */
interface WecomFrameBody {
	msgid?: string;
	chattype?: "single" | "group";
	chatid?: string;
	from?: { userid?: string };
	msgtype?: string;
	text?: { content?: string };
	image?: { url?: string; aeskey?: string };
}

/**
 * 企微帧 → 渠道无关进站消息。
 * 群聊 chatId 取 body.chatid、单聊取 from.userid；群聊文本剥离 "@机器人名" 前缀；
 * 不支持的类型（voice/file/video/mixed 等）置 unsupported；空文本返回 null（不处理）。
 */
export function normalizeInbound(frame: WsFrame): InboundMessage | null {
	const body = (frame.body ?? {}) as WecomFrameBody;
	const chatType: "single" | "group" =
		body.chattype === "group" ? "group" : "single";
	const chatId = chatType === "group" ? body.chatid : body.from?.userid;
	if (!chatId) return null;
	const base = {
		chatId,
		chatType,
		fromUserId: body.from?.userid ?? "",
		msgId: body.msgid ?? "",
		replyFrame: frame,
	};
	switch (body.msgtype) {
		case "text": {
			let text: string = body.text?.content ?? "";
			if (chatType === "group") text = text.replace(/^@\S+\s*/, ""); // 剥离 @机器人 前缀
			if (!text.trim()) return null;
			return { ...base, text };
		}
		case "image":
			return {
				...base,
				image: {
					url: body.image?.url ?? "",
					aeskey: body.image?.aeskey,
					name: `${body.msgid}.png`,
				},
			};
		default:
			return { ...base, unsupported: String(body.msgtype ?? "unknown") };
	}
}

/** 企业微信智能机器人适配器：官方 WS 长连接，无需公网回调 */
export class WecomAdapter implements ChannelAdapter {
	readonly type = "wecom" as const;
	private client: WSClient;
	private msgCb?: (msg: InboundMessage) => void;
	private statusCb?: (status: ChannelStatus, detail?: string) => void;

	constructor(channel: ChannelConfig) {
		this.client = new WSClient({
			botId: channel.credentials.botId,
			secret: channel.credentials.secret,
			maxReconnectAttempts: -1, // 无限重连（指数退避，SDK 内置上限 30s）
			logger: {
				debug: () => {},
				info: (...a: any[]) => console.log("[wecom]", ...a),
				warn: (...a: any[]) => console.warn("[wecom]", ...a),
				error: (...a: any[]) => console.error("[wecom]", ...a),
			},
		});
	}

	async connect(): Promise<void> {
		this.client.on("message", (frame: WsFrame) => {
			const msg = normalizeInbound(frame);
			if (msg) this.msgCb?.(msg);
		});
		this.client.on("authenticated", () => this.statusCb?.("connected"));
		this.client.on("disconnected", () => this.statusCb?.("connecting"));
		this.client.on("reconnecting", () => this.statusCb?.("connecting"));
		// 同一 Bot ID 在别处连接被踢下线
		this.client.on("event.disconnected_event", () =>
			this.statusCb?.("error", "连接被顶替：同一 Bot ID 已在别处连接"),
		);
		this.client.on("error", (err: Error) =>
			this.statusCb?.("error", err.message),
		);
		this.client.connect();
	}

	async disconnect(): Promise<void> {
		this.client.disconnect();
	}

	/** 一次性 markdown 回复 = 流式回复直接 finish（企微被动回复不支持纯 text）。
	 *  每次生成新 streamId + finish=true，用于错误回复、非流式兜底。 */
	async sendText(replyFrame: unknown, markdown: string): Promise<void> {
		await this.client.replyStream(
			replyFrame as WsFrame,
			generateReqId("stream"),
			markdown,
			true,
		);
	}

	/** 主动推送消息到指定会话（定时任务 @联系人 用）：走 SDK 主动发送通道，
	 *  chatId = 单聊 userid 或群聊 chatid，无需进站消息 replyFrame。
	 *  SDK 在企微返回 errcode!=0 时 reject 原始帧对象（非 Error），这里转成可读 Error
	 *  （带 errcode/errmsg），避免上层 String(frame) 序列化成 [object Object] 吞掉真实原因。 */
	async pushMessage(chatId: string, markdown: string): Promise<void> {
		try {
			await this.client.sendMessage(chatId, {
				msgtype: "markdown",
				markdown: { content: markdown },
			});
		} catch (err) {
			if (err instanceof Error) throw err;
			// SDK reject 的 WsFrame：{headers, errcode, errmsg, body}
			const frame = err as { errcode?: number; errmsg?: string };
			throw new Error(
				`企微推送失败${frame.errcode != null ? `（errcode=${frame.errcode}）` : ""}${frame.errmsg ? `：${frame.errmsg}` : ""}`,
			);
		}
	}

	/** 流式增量回复：同 streamId 复用更新同一条消息。
	 *  用 replyStreamNonBlocking：上一帧 ack 未返回时中间帧自动 skip（返回 'skipped'），
	 *  避免 token 生成快于企微 ack 时中间帧排队积压。 */
	async streamReply(
		replyFrame: unknown,
		streamId: string,
		content: string,
		finish: boolean,
	): Promise<void> {
		await this.client.replyStreamNonBlocking(
			replyFrame as WsFrame,
			streamId,
			content,
			finish,
		);
	}

	async downloadImage(image: ChannelImageRef): Promise<Buffer> {
		const { buffer } = await this.client.downloadFile(image.url, image.aeskey);
		return buffer;
	}

	onMessage(cb: (msg: InboundMessage) => void): void {
		this.msgCb = cb;
	}
	onStatus(cb: (status: ChannelStatus, detail?: string) => void): void {
		this.statusCb = cb;
	}
}
