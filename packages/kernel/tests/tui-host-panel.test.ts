import { describe, expect, test } from "bun:test";
import {
	Text,
	type Component,
	type TuiAltScreen,
} from "@earendil-works/pi-tui";
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
		await expect(host.result).resolves.toEqual({
			status: "done",
			value: "confirmed",
		});
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
		const deferred: { resolve: ((c: ProbeComponent) => void) | null } = {
			resolve: null,
		};
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

	test("未提供 copySelection 时不传（保留 pi-tui 的 OSC 52 兜底）；openUrl 缺省为 no-op", () => {
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
		// 规格 §7.5：缺省必须不传。pi-tui 的 copyTextToClipboard 只在 copySelection 为假值时
		// 才回退到 OSC 52 写；传一个返回 false 的函数会把它赋成实例字段、关掉这条兜底。
		expect(readInternal(capturedTui, "copySelection")).toBeUndefined();
		// 超链接没有回退行为要求，缺省为 no-op
		const openUrl = readInternal(capturedTui, "openUrl") as (url: string) => void;
		expect(typeof openUrl).toBe("function");
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

describe("createPanelHost：点击回退（未实现 handleMouse 的键盘型对话框）", () => {
	/**
	 * 键盘型编号选项对话框：只实现 render / invalidate / handleInput
	 * （与 pi-goal-x 的 goal-questionnaire 同形——它没有 handleMouse，
	 * 真实终端里鼠标点击同样只会落在「文本选择」，用户看到的就是「按钮点不到」）。
	 */
	function makeKeyboardDialog(contextLines = 0) {
		const keys: string[] = [];
		const doneRef: { fn: ((v: string) => void) | null } = { fn: null };
		const items = ["Confirm — create this goal now", "Continue chatting", "Cancel — discard this draft"];
		let index = 0;
		const component: ProbeComponent = {
			render: () => [
				" Confirm Goal Draft",
				...Array.from({ length: contextLines }, (_, i) => ` context line ${i + 1}`),
				"",
				...items.map((it, i) => `${i === index ? "> " : "  "}${i + 1}. ${it}`),
				"",
				" ↑↓ navigate • Enter select • Esc cancel",
			],
			invalidate: () => {},
			handleInput: (data: string) => {
				keys.push(data);
				if (data === "\u001b[B") index = Math.min(items.length - 1, index + 1);
				else if (data === "\u001b[A") index = Math.max(0, index - 1);
				else if (data === "\r") doneRef.fn?.(String(index + 1));
			},
		};
		return { keys, doneRef, component };
	}

	/** 前端 lib/tui-keys.ts 的编码（SGR 鼠标，坐标 1-based） */
	const mouse = (phase: "down" | "up", col: number, row: number) =>
		`\u001b[<0;${col};${row}${phase === "up" ? "m" : "M"}`;

	test("点击选项 2 → 选项被选中并确认（组件收到 ↓ + 回车）", async () => {
		const dialog = makeKeyboardDialog();
		const frames: TuiFrame[] = [];
		const host = createPanelHost({
			title: "probe",
			cols: 40,
			rows: 12,
			factory: (_tui, _theme, _kb, done) => {
				dialog.doneRef.fn = done as (v: string) => void;
				return dialog.component;
			},
			theme: undefined as never,
			keybindings: undefined as never,
			onFrame: (f) => frames.push(f),
		});
		host.start();
		const row = frames[0]!.lines.findIndex((l) => l.includes("2. Continue chatting"));
		expect(row).toBeGreaterThan(0);
		// 鼠标命中依赖 alt-screen 自己的布局树（`currentLayout`），而它是在
		// TuiBase 那个节流的渲染循环里建的（process.nextTick + ≥16ms），
		// 宿主直接调 tui.render() 并不建布局——先等它跑完再点，否则拿到 undefined 命中表
		await new Promise((r) => setTimeout(r, 50));

		host.inject(mouse("down", 8, row + 1));
		host.inject(mouse("up", 8, row + 1));

		expect(dialog.keys).toEqual(["\u001b[B", "\r"]);
		await expect(host.result).resolves.toEqual({ status: "done", value: "2" });
	});

	/**
	 * 生产几何：帧（37 行）高于终端视口（17 行），alt-screen 视口停在底部。
	 * 前端发的是**帧行**（用户点的是画面上那一行），宿主必须先折算成终端视口行——
	 * 少这一步就是「点 2 中 3」（浏览器侧客户端高度不是格高的整数倍，可见首行只有半行，
	 * 两侧 floor 出来的行号天然差 1）。
	 */
	test("长帧（37 行 > 17 行视口）：点帧行也能命中该选项（帧行 → 视口行折算）", async () => {
		const dialog = makeKeyboardDialog(30);
		const frames: TuiFrame[] = [];
		const host = createPanelHost({
			title: "probe",
			cols: 80,
			rows: 17,
			factory: (_tui, _theme, _kb, done) => {
				dialog.doneRef.fn = done as (v: string) => void;
				return dialog.component;
			},
			theme: undefined as never,
			keybindings: undefined as never,
			onFrame: (f) => frames.push(f),
		});
		host.start();
		await new Promise((r) => setTimeout(r, 50));

		const frameRow = frames[0]!.lines.findIndex((l) =>
			l.includes("2. Continue chatting"),
		);
		expect(frameRow).toBe(33);

		host.inject(mouse("down", 8, frameRow + 1));
		host.inject(mouse("up", 8, frameRow + 1));

		expect(dialog.keys).toEqual(["\u001b[B", "\r"]);
		await expect(host.result).resolves.toEqual({ status: "done", value: "2" });
	});

	test("插件自带 handleMouse 时不接管（补充、不覆盖）", async () => {
		const dialog = makeKeyboardDialog();
		const own: string[] = [];
		dialog.component.handleMouse = (event) => {
			own.push(event.type);
			return undefined;
		};
		const frames: TuiFrame[] = [];
		const host = createPanelHost({
			title: "probe",
			cols: 40,
			rows: 12,
			factory: () => dialog.component,
			theme: undefined as never,
			keybindings: undefined as never,
			onFrame: (f) => frames.push(f),
		});
		host.start();
		const row = frames[0]!.lines.findIndex((l) =>
			l.includes("2. Continue chatting"),
		);
		await new Promise((r) => setTimeout(r, 50));

		host.inject(mouse("down", 8, row + 1));
		host.inject(mouse("up", 8, row + 1));

		// 事件到了插件手上（原样调用），宿主没有塞自己的键盘序列
		expect(own).toContain("click");
		expect(dialog.keys).toEqual([]);
		host.dispose();
	});

	test("点击正文行不动选项、不发键", () => {
		const dialog = makeKeyboardDialog();
		const host = createPanelHost({
			title: "probe",
			cols: 40,
			rows: 12,
			factory: () => dialog.component,
			theme: undefined as never,
			keybindings: undefined as never,
		});
		host.start();
		host.sample();

		host.inject(mouse("down", 8, 1));
		host.inject(mouse("up", 8, 1));

		expect(dialog.keys).toEqual([]);
		host.dispose();
	});
});
