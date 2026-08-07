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
	/** 发送 markdown 文本（被动回复；replyFrame 来自最近一条进站消息）。
	 *  整轮一次性发送，用于错误回复、非流式渠道、或流式关闭时的兜底。 */
	sendText(replyFrame: unknown, markdown: string): Promise<void>;
	/** 流式增量回复（可选）：同一 streamId 复用可增量更新同一条消息。
	 *  - 首帧及中间帧 finish=false，content 为截至当前的累计文本
	 *  - 终帧 finish=true 锁定消息
	 *  适配器不实现此方法 = 不支持流式（channel-manager 自动降级为 sendText 整轮发送） */
	streamReply?(replyFrame: unknown, streamId: string, content: string, finish: boolean): Promise<void>;
	onMessage(cb: (msg: InboundMessage) => void): void;
	onStatus(cb: (status: ChannelStatus, detail?: string) => void): void;
	/** 下载并解密图片（无图片能力的适配器可不实现） */
	downloadImage?(image: ChannelImageRef): Promise<Buffer>;
}
