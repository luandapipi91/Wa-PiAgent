// SdkEventThrottle 单测：message_update（0.84 delta 协议）不得丢帧。
//
// 背景：0.84 起 RPC 序列化剥离 partial 快照，message_update 只携带 delta 增量
// （text_delta/thinking_delta），前端按到达顺序自行累积。节流器若按旧协议
// 「窗口内取最新一帧、中间帧丢弃」，会导致增量永久丢失——流式预览跳字/乱序，
// 只有 message_end 权威消息定稿后才正确（即用户报告的"输出过程顺序乱、完成才对"）。
// 渲染合帧已由前端 streaming-batcher（rAF）承担，kernel 侧无需再对 delta 节流。
import { test, expect } from "bun:test";
import { SdkEventThrottle } from "../src/event-throttle";
import type { SDKEventEnvelope, SDKEvent } from "@wa-pi/shared";

function fakeClock(start = 10_000) {
	let now = start;
	const timers: Array<{ id: number; at: number; fn: () => void }> = [];
	let nextId = 1;
	return {
		now: () => now,
		schedule: (fn: () => void, ms: number) => {
			const id = nextId++;
			timers.push({ id, at: now + ms, fn });
			return id;
		},
		cancelSchedule: (h: unknown) => {
			const i = timers.findIndex((t) => t.id === h);
			if (i >= 0) timers.splice(i, 1);
		},
		advance(ms: number) {
			now += ms;
			for (;;) {
				const due = timers
					.filter((t) => t.at <= now)
					.sort((a, b) => a.at - b.at);
				if (due.length === 0) break;
				for (const t of due) {
					timers.splice(timers.indexOf(t), 1);
					t.fn();
				}
			}
		},
	};
}

function envelope(sessionId: string, event: SDKEvent): SDKEventEnvelope {
	return {
		type: "sdk:event",
		projectId: "p",
		sessionId,
		agentName: "agent",
		event,
	};
}

function textDelta(delta: string, contentIndex = 0): SDKEvent {
	return {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex, delta },
	};
}

function thinkingDelta(delta: string, contentIndex = 1): SDKEvent {
	return {
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", contentIndex, delta },
	};
}

test("窗口内多个 text_delta 全部透传且保序（0.84 delta 协议不能丢帧）", () => {
	const sent: string[] = [];
	const clock = fakeClock();
	const th = new SdkEventThrottle(
		(e) => {
			const ae = (e.event as any).assistantMessageEvent;
			sent.push(ae?.delta ?? "");
		},
		{ ...clock },
	);

	th.handle(envelope("s1", textDelta("你")));
	th.handle(envelope("s1", textDelta("好")));
	th.handle(envelope("s1", textDelta("啊")));
	clock.advance(50);

	// 修复前只发首帧+末帧（["你","啊"]），中间帧「好」被丢弃 → 前端累积跳字
	expect(sent).toEqual(["你", "好", "啊"]);
});

test("多 contentIndex 交错 delta（text + thinking）各自保序透传", () => {
	const sent: Array<[number, string]> = [];
	const clock = fakeClock();
	const th = new SdkEventThrottle(
		(e) => {
			const ae = (e.event as any).assistantMessageEvent;
			sent.push([ae.contentIndex, ae.delta]);
		},
		{ ...clock },
	);

	th.handle(envelope("s1", textDelta("A", 0)));
	th.handle(envelope("s1", thinkingDelta("想", 1)));
	th.handle(envelope("s1", textDelta("B", 0)));
	th.handle(envelope("s1", thinkingDelta("法", 1)));
	clock.advance(50);

	expect(sent).toEqual([
		[0, "A"],
		[1, "想"],
		[0, "B"],
		[1, "法"],
	]);
});

test("非 update 事件（message_end）仍原样透传，不丢帧", () => {
	const sent: string[] = [];
	const clock = fakeClock();
	const th = new SdkEventThrottle((e) => sent.push((e.event as any).type), {
		...clock,
	});

	th.handle(envelope("s1", textDelta("a")));
	th.handle(envelope("s1", { type: "message_end", message: {} as any }));
	clock.advance(50);

	expect(sent).toEqual(["message_update", "message_end"]);
});

test("dispose 后不再发送", () => {
	const sent: string[] = [];
	const clock = fakeClock();
	const th = new SdkEventThrottle(
		(e) => {
			const ae = (e.event as any).assistantMessageEvent;
			sent.push(ae?.delta ?? "");
		},
		{ ...clock },
	);

	th.handle(envelope("s1", textDelta("a"))); // dispose 前：首帧立即发
	th.dispose();
	th.handle(envelope("s1", textDelta("b"))); // dispose 后：不再发送
	clock.advance(50);

	expect(sent).toEqual(["a"]);
});
