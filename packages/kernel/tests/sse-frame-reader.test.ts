// /api/events SSE 帧读取助手（helpers/http-api-kit.readSseFrame）的契约测试
//
// 背景（2026-09-20 定位）：kernel gate 里「真实扩展客户端（host.ts）↔ kernel：帧上行、输入下行
// 全链路对齐」用例在负载下会挂满 60s 用例超时。根因是 readSseFrame 把解析缓冲声明在函数内部，
// 返回一帧时把「同一个 TCP chunk 里已读到的其余完整帧」整段丢弃；负载下服务端连续两次广播
// （open + frame）被合并进同一 chunk，被丢的正好是用例在等的第二帧 sdk:event → 之后只剩 5s
// 一次的心跳帧，空等到用例超时。
//
// 本文件锁定两条契约：
//   ① 帧不因 chunk 边界而丢失（解析缓冲必须跨调用保留，按 reader 存状态）；
//   ② 等待有上限——真收不到帧时快速失败并报出卡点，而不是静默挂满用例级超时。
import { test, expect } from "bun:test";
import { readSseFrame } from "./helpers/http-api-kit";

/** 按脚本产出 chunk 的假 SSE 流；keepOpen=true 时脚本用完后保持挂起（不 close），
 *  用于模拟「连接活着但帧一直不来」 */
function streamOf(chunks: string[], opts: { keepOpen?: boolean } = {}) {
	const enc = new TextEncoder();
	let i = 0;
	return new ReadableStream<Uint8Array>({
		pull(c) {
			if (i < chunks.length) {
				c.enqueue(enc.encode(chunks[i++]));
				return;
			}
			if (opts.keepOpen) return new Promise<void>(() => {}); // 永不 settle：不 enqueue、不 close
			c.close();
		},
	});
}

const frame = (n: number) => `data: {"type":"sdk:event","n":${n}}\n\n`;
const heartbeat = `data: {"type":"heartbeat"}\n\n`;

test("同一 chunk 内两帧：第二帧不丢（负载下被合并的真实现场）", async () => {
	const reader = streamOf([heartbeat + frame(1)]).getReader();

	expect((await readSseFrame(reader)).data.type).toBe("heartbeat");
	expect((await readSseFrame(reader)).data).toEqual({ type: "sdk:event", n: 1 });
});

test("同一 chunk 内三帧：按序全部可读", async () => {
	const reader = streamOf([frame(1) + heartbeat + frame(2)]).getReader();

	expect((await readSseFrame(reader)).data).toEqual({ type: "sdk:event", n: 1 });
	expect((await readSseFrame(reader)).data.type).toBe("heartbeat");
	expect((await readSseFrame(reader)).data).toEqual({ type: "sdk:event", n: 2 });
});

test("两帧分属两个 chunk：都能读到（回归防线）", async () => {
	const reader = streamOf([heartbeat, frame(3)]).getReader();

	expect((await readSseFrame(reader)).data.type).toBe("heartbeat");
	expect((await readSseFrame(reader)).data).toEqual({ type: "sdk:event", n: 3 });
});

test("注释帧与数据帧同 chunk：注释跳过、数据帧不丢", async () => {
	const reader = streamOf([`: connected\n\n${frame(4)}`]).getReader();

	expect((await readSseFrame(reader)).data).toEqual({ type: "sdk:event", n: 4 });
});

test("单个帧被拆到两个 chunk：拼回后可解析", async () => {
	const reader = streamOf(['data: {"type":"sdk:', 'event","n":5}\n\n']).getReader();

	expect((await readSseFrame(reader)).data).toEqual({ type: "sdk:event", n: 5 });
});

test("多字节字符跨 chunk 拆断：不乱码（解码器状态跨调用保留）", async () => {
	const reader = streamOf(['data: {"type":"sdk:event","t":"中文', '断点"}\n\n']).getReader();

	expect((await readSseFrame(reader)).data).toEqual({ type: "sdk:event", t: "中文断点" });
});

test(
	"一直收不到帧：按读取上限快速失败，并报出已读帧数（不再静默挂满用例超时）",
	async () => {
		// 只有注释帧，之后连接活着但永不再来 data 帧：上限内应抛错，而不是无限等待
		const reader = streamOf([": connected\n\n", ": ping\n\n"], { keepOpen: true }).getReader();

		const started = Date.now();
		let err: Error | undefined;
		try {
			await readSseFrame(reader, { timeoutMs: 300 });
		} catch (e) {
			err = e as Error;
		}
		const elapsed = Date.now() - started;

		expect(err).toBeInstanceOf(Error);
		expect(err?.message).toContain("读取超时");
		expect(err?.message).toContain("300ms");
		expect(elapsed).toBeLessThan(2000);
	},
	{ timeout: 10_000 },
);
