import { test, expect, afterEach } from "bun:test";

// 回归守卫（task-7 P0）：StreamingBatcher 的 schedule 必须用箭头包裹 rAF，
// 不可裸引用 requestAnimationFrame。裸引用在 batcher 内 `this.scheduleFn(cb)`
// （this=batcher 实例）的成员访问调用下，会被真实 Chromium 原生 rAF 拒绝并抛
// "Illegal invocation"，导致所有 message_update(text_delta) 流式预览在真实浏览器
// 里不更新（直到 message_end 定稿）——任务 1–6 的合帧优化在真实浏览器从未生效。
//
// happy-dom 的 rAF 是 setTimeout mock、不校验 receiver，故组件层测不出。这里用
// 「校验 receiver 的 rAF 替身」模拟原生严格语义：合法 receiver 为 globalThis
// （`globalThis.requestAnimationFrame(cb)`）或裸调用；拒绝其他具体对象（如
// batcher 实例）。
//
// 注意 bun(JSC) 与浏览器(V8) 的裸调用 this 语义差异：真实浏览器(V8 web-compat)
// 裸调用全局属性 this=globalThis；bun(JSC) 严格模式裸调用 this=undefined。故替身
// 放宽接受 undefined 作为「裸调用」在 bun 下的近似——这恰好把「裸引用 + 成员访问
// （this=batcher，bug 场景）」与「箭头内裸调用（this=undefined，修复场景）」分开。

const originalRAF = globalThis.requestAnimationFrame;
let illegalReceiverCalls = 0;

globalThis.requestAnimationFrame = function (this: unknown, _cb: FrameRequestCallback) {
	// 近似原生 rAF 的 receiver 校验：接受 globalThis（成员访问 globalThis.rAF）与
	// 裸调用（V8 下 this=globalThis，bun 下 this=undefined）；拒绝其他具体对象
	// （成员访问 this.scheduleFn 时 this=batcher → bug 场景）。
	if (this !== undefined && this !== globalThis) {
		illegalReceiverCalls++;
		throw new TypeError("Illegal invocation");
	}
	// 不真实调度帧回调，仅校验调用方式合法；返回非 null handle 占位。
	return 0;
} as typeof requestAnimationFrame;

// 动态导入：保证 raf 闭包在替身生效后求值（静态 import 会被 hoist 到替换前执行，
// 此时 globalThis.requestAnimationFrame 仍是 happy-dom mock）。
const { useSessionStore } = await import("./session");

afterEach(() => {
	// 还原全局 rAF，避免污染进程内其他测试文件的 happy-dom mock。
	globalThis.requestAnimationFrame = originalRAF;
});

test("message_update 流式路径在严格 rAF（校验 receiver）下不抛 Illegal invocation", () => {
	const sid = "regress-raf-this";
	const store = useSessionStore.getState();

	// message_start(assistant) 建立 streaming 占位（message_update 须先有 cur 基准）
	store.handleSDKEvent(sid, {
		event: {
			type: "message_start",
			message: { role: "assistant", content: [], model: "m", timestamp: Date.now() },
		},
		agentName: "dev",
	} as any);

	// text_delta → batcher.update → this.scheduleFn(cb) 同步调度。
	//   修复前（raf = requestAnimationFrame 裸引用）：this.scheduleFn receiver=batcher
	//     → 严格替身拒绝 → Illegal invocation；
	//   修复后（raf = (fn)=>requestAnimationFrame(fn) 箭头包裹）：箭头内裸调用
	//     receiver=undefined（bun 近似）→ 替身接受 → 通过。
	expect(() => {
		store.handleSDKEvent(sid, {
			event: {
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "片段" },
			},
			agentName: "dev",
		} as any);
	}).not.toThrow();
	// 全程未以非法 receiver 调用 rAF
	expect(illegalReceiverCalls).toBe(0);
});
