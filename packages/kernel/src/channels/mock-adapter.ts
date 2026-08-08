import { randomUUID } from "node:crypto";
import type { ChannelConfig, ChannelStatus } from "@wa-pi/shared";
import type {
	ChannelAdapter,
	ChannelImageRef,
	InboundMessage,
} from "./types";

/** 内存假渠道：单元测试与 E2E（WA_PI_CHANNELS_MOCK=1）用，不进真实网络 */
export class MockAdapter implements ChannelAdapter {
	readonly type = "mock" as const;
	status: ChannelStatus = "disconnected";
	/** 出站记录：sendText 整轮发送 { text }；streamReply 流式帧 { streamId, text, finish } */
	outbox: { replyFrame: unknown; text: string; streamId?: string; finish?: boolean }[] = [];
	/** 模拟下载图片时返回的内容 */
	imageStub: Buffer = Buffer.from("fake-image");
	private msgCb?: (msg: InboundMessage) => void;
	private statusCb?: (status: ChannelStatus, detail?: string) => void;

	constructor(private channel: ChannelConfig) {}

	async connect(): Promise<void> {
		this.setStatus("connected");
	}
	async disconnect(): Promise<void> {
		this.setStatus("disconnected");
	}
	async sendText(replyFrame: unknown, markdown: string): Promise<void> {
		this.outbox.push({ replyFrame, text: markdown });
	}
	/** 流式增量回复（内存记录供测试断言流式帧序列） */
	async streamReply(replyFrame: unknown, streamId: string, content: string, finish: boolean): Promise<void> {
		this.outbox.push({ replyFrame, text: content, streamId, finish });
	}
	async downloadImage(_image: ChannelImageRef): Promise<Buffer> {
		return this.imageStub;
	}
	onMessage(cb: (msg: InboundMessage) => void): void {
		this.msgCb = cb;
	}
	onStatus(cb: (status: ChannelStatus, detail?: string) => void): void {
		this.statusCb = cb;
	}

	/** 模拟一条进站消息（测试/E2E 注入用） */
	inject(msg: Partial<InboundMessage> & { chatId: string }): void {
		this.msgCb?.({
			chatType: "single",
			fromUserId: msg.chatId,
			msgId: randomUUID(),
			replyFrame: { mock: true, chatId: msg.chatId },
			...msg,
		} as InboundMessage);
	}

	private setStatus(s: ChannelStatus): void {
		this.status = s;
		this.statusCb?.(s);
	}
}
