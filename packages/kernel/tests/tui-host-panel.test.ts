import { describe, expect, test } from "bun:test";
import { Text, type Component, type TuiAltScreen } from "@earendil-works/pi-tui";
import { createPanelHost } from "../src/tui-host/panel.ts";
import type { TuiFrame } from "../src/tui-host/frame.ts";

/** pi 的组件可以带 dispose，但 pi-tui 的 Component 契约里没有 */
type ProbeComponent = Component & { dispose?: () => void };

/** 可控测试组件：记录收到的按键，可按需回写内容 */
function makeProbeComponent(getText: () => string) {
	const keys: string[] = [];
	return {
		keys,
		component: {
			render: (_width: number) => [getText()],
			invalidate: () => {},
			handleInput: (data: string) => {
				keys.push(data);
			},
		},
	};
}

/** 让异步工厂分支的微任务跑完；不依赖面板自身的 80ms 定时器 */
async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

/** 读取 TuiAltScreen 实例上的内部字段：pi-tui 把宿主钩子存成实例属性，没有公开 getter */
function readInternal(tui: TuiAltScreen, key: string): unknown {
	return (tui as unknown as Record<string, unknown>)[key];
}

describe("createPanelHost", () => {
	test("打开后 sample() 采到组件渲染的行", () => {
		const host = createPanelHost({
			title: "probe",
			cols: 40,
			rows: 10,
			factory: () => new Text("hello panel"),
			theme: undefined as never,
			keybindings: undefined as never,
		});
		const frame = host.sample();
		expect(frame?.lines.join("\n")).toContain("hello panel");
		host.dispose();
	});

	test("inject 把按键交给组件；done 回调结束并返回结果", async () => {
		// 用对象属性承接 done：局部 let 会被控制流分析窄化成 null（赋值发生在闭包里）
		const doneRef: { fn: ((r: string) => void) | null } = { fn: null };
		const probe = makeProbeComponent(() => "pick");
		const host = createPanelHost({
			title: "probe",
			cols: 40,
			rows: 10,
			factory: (_tui, _theme, _kb, done) => {
				doneRef.fn = done;
				return probe.component;
			},
			theme: undefined as never,
			keybindings: undefined as never,
		});
		host.start();
		host.inject("\u001b[B");
		expect(probe.keys).toEqual(["\u001b[B"]);
		doneRef.fn?.("confirmed");
		await expect(host.result).resolves.toEqual({ status: "done", value: "confirmed" });
	});

	test("cancel 结束并标记 cancelled", async () => {
		const host = createPanelHost({
			title: "probe",
			cols: 40,
			rows: 10,
			factory: () => new Text("x"),
			theme: undefined as never,
			keybindings: undefined as never,
		});
		host.start();
		host.cancel();
		await expect(host.result).resolves.toEqual({ status: "cancelled" });
	});

	test("resize 后新采样按新宽度渲染", () => {
		const widths: number[] = [];
		const host = createPanelHost({
			title: "probe",
			cols: 40,
			rows: 10,
			factory: () => ({
				render: (w: number) => {
					widths.push(w);
					return [`w=${w}`];
				},
				invalidate: () => {},
			}),
			theme: undefined as never,
			keybindings: undefined as never,
		});
		host.sample();
		host.resize(60, 12);
		host.sample();
		expect(widths).toEqual([40, 60]);
		host.dispose();
	});

	test("factory 抛错时以 cancelled 结束且不抛给调用方", async () => {
		const host = createPanelHost({
			title: "probe",
			cols: 40,
			rows: 10,
			factory: () => {
				throw new Error("boom");
			},
			theme: undefined as never,
			keybindings: undefined as never,
		});
		host.start();
		await expect(host.result).resolves.toEqual({ status: "cancelled" });
	});

	test("dispose 后 result 以 cancelled 结束（会话销毁兜底）", async () => {
		const host = createPanelHost({
			title: "probe",
			cols: 40,
			rows: 10,
			factory: () => new Text("x"),
			theme: undefined as never,
			keybindings: undefined as never,
		});
		host.start();
		host.dispose();
		await expect(host.result).resolves.toEqual({ status: "cancelled" });
	});

	// —— 异步分支、推送去重与重复收尾（补齐入库覆盖）——

	test("factory 返回 Promise 时：start 后挂载，sample 取到组件渲染内容", async () => {
		const frames: TuiFrame[] = [];
		let text = "async panel v1";
		const host = createPanelHost({
			title: "probe",
			cols: 40,
			rows: 10,
			factory: async () => makeProbeComponent(() => text).component,
			theme: undefined as never,
			keybindings: undefined as never,
			onFrame: (frame) => frames.push(frame),
		});
		host.start();
		// 异步分支要等微任务：此刻组件还没挂载，没有帧
		expect(host.sample()).toBeNull();
		expect(frames).toEqual([]);

		await flushMicrotasks();
		// 组件已挂载：异步分支到达后立即推首帧
		expect(frames).toHaveLength(1);
		expect(frames[0]?.lines.join("\n")).toContain("async panel v1");

		// 挂载后的组件可被采样：内容变化即取到新帧
		text = "async panel v2";
		expect(host.sample()?.lines.join("\n")).toContain("async panel v2");
		host.dispose();
	});

	test("settled 之后迟到的异步组件被释放并丢弃，不产生帧", async () => {
		let disposed = 0;
		const frames: TuiFrame[] = [];
		// 用对象属性承接 resolve：局部 let 会被控制流分析窄化成 null
		const deferred: { resolve: ((c: ProbeComponent) => void) | null } = { resolve: null };
		const pending = new Promise<ProbeComponent>((r) => {
			deferred.resolve = r;
		});
		const lateComponent: ProbeComponent = {
			render: () => ["late"],
			invalidate: () => {},
			dispose: () => {
				disposed++;
			},
		};
		const host = createPanelHost({
			title: "probe",
			cols: 40,
			rows: 10,
			factory: () => pending,
			theme: undefined as never,
			keybindings: undefined as never,
			onFrame: (frame) => frames.push(frame),
		});
		host.start();
		host.cancel();
		await expect(host.result).resolves.toEqual({ status: "cancelled" });

		deferred.resolve?.(lateComponent);
		await flushMicrotasks();

		expect(disposed).toBe(1);
		expect(frames).toEqual([]);
		expect(host.sample()).toBeNull();
	});

	test("onFrame 只在内容变化时回调（去重契约）", () => {
		const frames: TuiFrame[] = [];
		let text = "v1";
		const host = createPanelHost({
			title: "probe",
			cols: 40,
			rows: 10,
			factory: () => makeProbeComponent(() => text).component,
			theme: undefined as never,
			keybindings: undefined as never,
			onFrame: (frame) => frames.push(frame),
		});
		const first = host.sample();
		expect(first?.lines.join("\n")).toContain("v1");
		expect(frames).toHaveLength(1);

		// 内容不变：不采样出帧，也不推送
		expect(host.sample()).toBeNull();
		expect(frames).toHaveLength(1);

		text = "v2";
		const second = host.sample();
		expect(second?.lines.join("\n")).toContain("v2");
		expect(frames).toHaveLength(2);
		expect(frames[1]?.lines.join("\n")).toContain("v2");
		host.dispose();
	});

	test("组件 render 抛错时以 cancelled 结束且不向调用方抛错", async () => {
		const host = createPanelHost({
			title: "probe",
			cols: 40,
			rows: 10,
			factory: () => ({
				render: () => {
					throw new Error("render boom");
				},
				invalidate: () => {},
			}),
			theme: undefined as never,
			keybindings: undefined as never,
		});
		expect(() => host.start()).not.toThrow();
		expect(() => host.sample()).not.toThrow();
		expect(host.sample()).toBeNull();
		await expect(host.result).resolves.toEqual({ status: "cancelled" });
	});

	test("dispose 幂等：连调两次不抛错、组件只释放一次、result 只 settle 一次", async () => {
		let disposed = 0;
		const doneRef: { fn: ((r: string) => void) | null } = { fn: null };
		const host = createPanelHost({
			title: "probe",
			cols: 40,
			rows: 10,
			factory: (_tui, _theme, _kb, done) => {
				doneRef.fn = done;
				return {
					render: () => ["x"],
					invalidate: () => {},
					dispose: () => {
						disposed++;
					},
				};
			},
			theme: undefined as never,
			keybindings: undefined as never,
		});
		host.start();
		expect(() => {
			host.dispose();
			host.dispose();
		}).not.toThrow();
		expect(disposed).toBe(1);

		// 已 settle 后再调 done 不得改写结果（settle 只发生一次）
		doneRef.fn?.("late");
		await expect(host.result).resolves.toEqual({ status: "cancelled" });
	});

	test("自定义 copySelection / openUrl 透传给 TuiAltScreen 构造", () => {
		const copySelection = async (_text: string) => true;
		const openUrl = (_url: string) => {};
		let capturedTui!: TuiAltScreen;
		const host = createPanelHost({
			title: "probe",
			cols: 40,
			rows: 10,
			factory: (tui) => {
				capturedTui = tui;
				return { render: () => ["x"], invalidate: () => {} };
			},
			theme: undefined as never,
			keybindings: undefined as never,
			copySelection,
			openUrl,
		});
		host.start();
		expect(readInternal(capturedTui, "copySelection")).toBe(copySelection);
		expect(readInternal(capturedTui, "openUrl")).toBe(openUrl);
		host.dispose();
	});

	test("未提供 copySelection / openUrl 时用安全默认", async () => {
		let capturedTui!: TuiAltScreen;
		const host = createPanelHost({
			title: "probe",
			cols: 40,
			rows: 10,
			factory: (tui) => {
				capturedTui = tui;
				return { render: () => ["x"], invalidate: () => {} };
			},
			theme: undefined as never,
			keybindings: undefined as never,
		});
		host.start();
		// 剪贴板通道未接入时不得假装复制成功；超链接默认 no-op
		const copySelection = readInternal(capturedTui, "copySelection") as () => Promise<boolean>;
		await expect(copySelection()).resolves.toBe(false);
		const openUrl = readInternal(capturedTui, "openUrl") as (url: string) => void;
		expect(() => openUrl("https://example.com")).not.toThrow();
		host.dispose();
	});

	test("onFrame 抛错不向调用方冒泡", () => {
		const host = createPanelHost({
			title: "probe",
			cols: 40,
			rows: 10,
			factory: () => makeProbeComponent(() => "boom").component,
			theme: undefined as never,
			keybindings: undefined as never,
			onFrame: () => {
				throw new Error("channel boom");
			},
		});
		expect(() => host.start()).not.toThrow();
		expect(() => host.sample()).not.toThrow();
		// 帧已记为上一帧，通道异常后不重复推送
		expect(host.sample()).toBeNull();
		host.dispose();
	});
});
