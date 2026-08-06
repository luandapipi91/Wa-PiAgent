import type { ChannelStatus, ChannelType } from "@wa-pi/shared";

/** 渠道无关的进站消息模型：各适配器把平台消息归一化成它 */
export interface InboundMessage {
	/** 会话标识：群聊=群 chatid，单聊=发送者 userid */
	chatId: string;
	chatType: "single" | "group";
	fromUserId: string;
	/** 平台消息唯一 id（排重用） */
	msgId: string;
	text?: string;
	image?: { url: string; aeskey?: string; name?: string };
	/** 不支持的消息类型说明（voice/file/video…），设置后 text/image 为空 */
	unsupported?: string;
	/** 平台原始帧，回复时必须透传（企微需携带 req_id）；适配器自定义形状 */
	replyFrame: unknown;
}

export interface ChannelImageRef {
	url: string;
	aeskey?: string;
}

/** 渠道适配器接口：飞书/QQ 等后续渠道各实现一个 */
export interface ChannelAdapter {
	readonly type: ChannelType;
	connect(): Promise<void>;
	disconnect(): Promise<void>;
	/** 发送 markdown 文本（被动回复；replyFrame 来自最近一条进站消息） */
	sendText(replyFrame: unknown, markdown: string): Promise<void>;
	onMessage(cb: (msg: InboundMessage) => void): void;
	onStatus(cb: (status: ChannelStatus, detail?: string) => void): void;
	/** 下载并解密图片（无图片能力的适配器可不实现） */
	downloadImage?(image: ChannelImageRef): Promise<Buffer>;
}
