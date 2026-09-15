import { describe, expect, test } from "bun:test";
import { createFrameSink, createPanelBridge, patchUiForTuiHost, type TuiHostPatchBridge } from "../src/tui-host/host.ts";

/** 收集经帧出口发出的消息（模拟 kernel 收到的 NDJSON） */
function collect() {
	const lines: string[] = [];
	const sink = createFrameSink();
	sink.attach((l) => lines.push(l));
	return { sink, frames: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

/** 可控测试组件：记录收到的按键 */
function makeComponent(label: string) {
	const keys: string[] = [];
	return {
		keys,
		component: {
			render: (_width: number) => [label],
			invalidate: () => {},
			handleInput: (data: string) => {
				keys.push(data);
			},
		},
	};
}

/** 轮询等待条件成立（面板/widget 的采样走 80ms 定时器） */
async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!cond() && Date.now() < deadline) await Bun.sleep(10);
}

/** 仿 rpc-mode ui 上下文的测试形状 */
type FakeUi = {
	__waPiTuiHost?: boolean;
	__waPiTuiHostBridge?: unknown;
	custom: (...args: unknown[]) => Promise<unknown>;
	setWidget: (key: string, content: unknown, options?: unknown) => void;
	onTerminalInput: (cb: (data: string) => void) => () => void;
};

/** 构造一个仿 rpc-mode 的最小 ui 上下文 */
function makeUi() {
	const calls: string[] = [];
	const ui: FakeUi = {
		custom: async () => {
			calls.push("orig-custom");
			return undefined;
		},
		setWidget: (key: string, content: unknown) => {
			calls.push(`setWidget:${key}:${typeof content}`);
		},
		onTerminalInput: () => {
			calls.push("orig-onTerminalInput");
			return () => {};
		},
	};
	return { ui, calls };
}

const fakeBridge: TuiHostPatchBridge = {
	openCustom: async () => ({ ok: true }),
	openWidget: () => {},
	closeWidget: () => {},
	setInputListeners: () => {},
};

describe("patchUiForTuiHost", () => {
	test("打上接管标记，且 custom 改为走 bridge", async () => {
		const { ui } = makeUi();
		const seen: unknown[] = [];
		const factory = () => ({ render: () => [] });
		patchUiForTuiHost(ui as unknown as Record<string, unknown>, {
			...fakeBridge,
			openCustom: async (f, options) => {
				seen.push(f, options);
				return "panel-result";
			},
		});
		expect(ui.__waPiTuiHost).toBe(true);
		await expect(ui.custom(factory, { overlay: true })).resolves.toBe("panel-result");
		expect(seen).toEqual([factory, { overlay: true }]);
	});

	test("setWidget 传字符串数组时透传原实现，传组件工厂时走 bridge", () => {
		const { ui, calls } = makeUi();
		const widgetCalls: string[] = [];
		patchUiForTuiHost(ui as unknown as Record<string, unknown>, {
			...fakeBridge,
			openWidget: (key) => {
				widgetCalls.push(key);
			},
		});
		ui.setWidget("a", ["line1"]);
		ui.setWidget("b", () => ({ render: () => [] }));
		expect(calls).toContain("setWidget:a:object");
		expect(widgetCalls).toEqual(["b"]);
	});

	test("setWidget 传非组件（清除/纯文本）时交给 closeWidget，且仍透传原实现", () => {
		const { ui, calls } = makeUi();
		const closed: string[] = [];
		patchUiForTuiHost(ui as unknown as Record<string, unknown>, {
			...fakeBridge,
			closeWidget: (key) => {
				closed.push(key);
			},
		});
		ui.setWidget("dash", undefined);
		ui.setWidget("dash", ["纯文本"]);
		expect(closed).toEqual(["dash", "dash"]);
		expect(calls).toEqual(["setWidget:dash:undefined", "setWidget:dash:object"]);
	});

	test("onTerminalInput 返回可注销函数，且监听器被交给 bridge", () => {
		const { ui } = makeUi();
		const seen: Set<(data: string) => void>[] = [];
		patchUiForTuiHost(ui as unknown as Record<string, unknown>, {
			...fakeBridge,
			setInputListeners: (s) => {
				seen.push(s);
			},
		});
		const off = ui.onTerminalInput(() => {});
		expect(typeof off).toBe("function");
		expect(seen).toHaveLength(1);
	});

	test("换 bridge 重新 patch 时沿用同一个监听器集合（reload 前的订阅不丢）", () => {
		const { ui } = makeUi();
		const asUi = ui as unknown as Record<string, unknown>;
		const seen: Set<(data: string) => void>[] = [];
		const track = (s: Set<(data: string) => void>) => {
			seen.push(s);
		};
		patchUiForTuiHost(asUi, { ...fakeBridge, setInputListeners: track });
		const cb = () => {};
		ui.onTerminalInput(cb);
		patchUiForTuiHost(asUi, { ...fakeBridge, setInputListeners: track });
		expect(seen).toHaveLength(2);
		expect(seen[1]).toBe(seen[0]);
		expect([...seen[1]!]).toEqual([cb]);
	});

	test("重复 patch 不叠加（同一个 bridge 则原样返回）", () => {
		const { ui } = makeUi();
		const asUi = ui as unknown as Record<string, unknown>;
		const bridge: TuiHostPatchBridge = { ...fakeBridge, openCustom: async () => "first" };
		patchUiForTuiHost(asUi, bridge);
		const firstCustom = asUi.custom;
		patchUiForTuiHost(asUi, bridge);
		expect(asUi.custom).toBe(firstCustom);
	});

	test("换 bridge 重新 patch 同一个 ui 对象：custom 走新 bridge", async () => {
		const { ui } = makeUi();
		const asUi = ui as unknown as Record<string, unknown>;
		const seen: string[] = [];
		patchUiForTuiHost(asUi, {
			...fakeBridge,
			openCustom: async () => {
				seen.push("旧");
				return "旧";
			},
		});
		patchUiForTuiHost(asUi, {
			...fakeBridge,
			openCustom: async () => {
				seen.push("新");
				return "新";
			},
		});
		await expect(ui.custom(() => ({ render: () => [] }), undefined, undefined)).resolves.toBe("新");
		expect(seen).toEqual(["新"]);
		// 布尔标记保留：wa-pi-bridge 的兜底靠它让位
		expect(asUi.__waPiTuiHost).toBe(true);
	});
});

describe("createPanelBridge", () => {
	test("工厂同步抛错：Promise 仍 settle 为 undefined，且面板不会留在画面上", async () => {
		const { sink, frames } = collect();
		const bridge = createPanelBridge({ sink });
		await expect(
			bridge.openCustom(
				() => {
					throw new Error("插件的工厂炸了");
				},
				undefined,
				undefined,
			),
		).resolves.toBeUndefined();
		expect(frames().map((f) => f.type)).toEqual(["open", "close"]);
		expect(frames()[1]?.reason).toBe("cancel");
	});

	test("工厂同步返回空值：同样是 settle 为 undefined，不把 TypeError 抛回调用方", async () => {
		const { sink, frames } = collect();
		const bridge = createPanelBridge({ sink });
		await expect(bridge.openCustom(() => undefined, undefined, undefined)).resolves.toBeUndefined();
		expect(frames().map((f) => f.type)).toEqual(["open", "close"]);
		expect(frames()[1]?.reason).toBe("cancel");
	});

	test("同会话同时只开一个面板：第二个排队，首个结束后才 open", async () => {
		const { sink, frames } = collect();
		const bridge = createPanelBridge({ sink });
		const doneRef: { fn: ((r: string) => void) | null } = { fn: null };
		const first = bridge.openCustom(
			(_tui: unknown, _theme: unknown, _kb: unknown, done: (r: string) => void) => {
				doneRef.fn = done;
				return makeComponent("first").component;
			},
			undefined,
			undefined,
		);
		await Bun.sleep(10);
		const second = bridge.openCustom(() => makeComponent("second").component, undefined, undefined);
		await Bun.sleep(10);

		expect(frames().filter((f) => f.type === "open")).toHaveLength(1);
		expect(frames()[0]).toMatchObject({ kind: "custom", pending: 1, cols: 85, rows: 24 });

		doneRef.fn?.("picked");
		await expect(first).resolves.toBe("picked");
		await waitFor(() => frames().filter((f) => f.type === "open").length === 2);
		expect(frames().slice(0, 4).map((f) => f.type)).toEqual(["open", "frame", "close", "open"]);

		bridge.disposeAll();
		await expect(second).resolves.toBeUndefined();
	});

	test("handleInput：按键注入当前面板并交给 onTerminalInput 监听器；cancel 结束面板", async () => {
		const { sink, frames } = collect();
		const bridge = createPanelBridge({ sink });
		const listeners = new Set<(data: string) => void>();
		bridge.setInputListeners(listeners);
		const seen: string[] = [];
		listeners.add((d) => seen.push(d));

		const probe = makeComponent("panel");
		const panel = bridge.openCustom(() => probe.component, undefined, undefined);
		await Bun.sleep(10);
		const panelId = frames()[0]?.panelId as string;

		bridge.handleInput({ type: "key", panelId, data: "\u001b[B" });
		expect(probe.keys).toEqual(["\u001b[B"]);
		expect(seen).toEqual(["\u001b[B"]);

		bridge.handleInput({ type: "key", panelId: "p-unknown", data: "x" });
		expect(probe.keys).toHaveLength(1);

		bridge.handleInput({ type: "cancel", panelId });
		await expect(panel).resolves.toBeUndefined();
		expect(frames().at(-1)?.reason).toBe("cancel");
	});

	test("openWidget：组件工厂走 widget 通道，采样帧带 widgetKey", async () => {
		const { sink, frames } = collect();
		const bridge = createPanelBridge({ sink });
		bridge.openWidget("dash", () => ({ render: () => ["widget line"] }), { placement: "belowEditor" }, undefined);
		expect(frames()[0]).toMatchObject({
			kind: "widget",
			panelId: "w:dash",
			widgetKey: "dash",
			placement: "belowEditor",
		});

		await waitFor(() => frames().some((f) => f.type === "frame" && f.panelId === "w:dash"));
		expect(frames().find((f) => f.type === "frame")?.lines).toEqual(["widget line"]);
		bridge.disposeAll();
	});

	test("widget 工厂抛错或返回空值：open 后立即 close，不留幽灵面板", async () => {
		const { sink, frames } = collect();
		const bridge = createPanelBridge({ sink });
		bridge.openWidget(
			"boom",
			() => {
				throw new Error("插件的工厂炸了");
			},
			undefined,
			undefined,
		);
		expect(frames().map((f) => f.type)).toEqual(["open", "close"]);
		expect(frames()[1]).toMatchObject({ panelId: "w:boom", reason: "empty" });

		bridge.openWidget("empty", () => undefined as never, undefined, undefined);
		expect(frames().map((f) => f.type)).toEqual(["open", "close", "open", "close"]);

		// 没有宿主的 widget 不得留下采样定时器
		await Bun.sleep(200);
		expect(frames().filter((f) => f.type === "frame")).toHaveLength(0);
	});

	test("清除 widget（setWidget(key, undefined)）：发 close 并释放宿主与采样定时器", async () => {
		const { sink, frames } = collect();
		const bridge = createPanelBridge({ sink });
		let disposed = 0;
		bridge.openWidget(
			"dash",
			() => ({ render: () => ["w"], dispose: () => {
				disposed += 1;
			} }),
			undefined,
			undefined,
		);
		await waitFor(() => frames().some((f) => f.type === "frame" && f.panelId === "w:dash"));

		bridge.closeWidget("dash");
		expect(frames().at(-1)).toMatchObject({ type: "close", panelId: "w:dash", reason: "removed" });
		expect(disposed).toBe(1);

		// 采样定时器已停：清除后不再推帧
		await Bun.sleep(200);
		expect(frames().filter((f) => f.panelId === "w:dash" && f.type === "frame")).toHaveLength(1);

		// 从未开过的 key：不发多余帧
		bridge.closeWidget("never");
		expect(frames().some((f) => f.panelId === "w:never")).toBe(false);
		bridge.disposeAll();
	});

	test("openCustom 传 onHandle：overlay 降级路径也照常回调一次安全句柄", async () => {
		const { sink, frames } = collect();
		const bridge = createPanelBridge({ sink });
		type HandleProbe = {
			hide(): void;
			setHidden(hidden: boolean): void;
			isHidden(): boolean;
			focus(): void;
			unfocus(): void;
			isFocused(): boolean;
			getBounds(): unknown;
		};
		const handles: HandleProbe[] = [];
		const panel = bridge.openCustom(
			() => makeComponent("panel").component,
			{ overlay: true, onHandle: (h: unknown) => handles.push(h as HandleProbe) },
			undefined,
		);
		await Bun.sleep(10);

		// 规格 §4.3：onHandle 照常回调——拿不到句柄的插件会在自己的 hide() 上炸 TypeError
		expect(handles).toHaveLength(1);
		const handle = handles[0];
		expect(() => {
			handle.hide();
			handle.setHidden(true);
			handle.isHidden();
			handle.focus();
			handle.unfocus();
			handle.isFocused();
			handle.getBounds();
		}).not.toThrow();

		// overlay 本身降级为普通整屏面板（控制者裁定）：面板照常开着，且只回调一次
		expect(frames().filter((f) => f.type === "open")).toHaveLength(1);
		bridge.handleInput({ type: "cancel", panelId: frames()[0]?.panelId as string });
		await expect(panel).resolves.toBeUndefined();
		expect(handles).toHaveLength(1);
	});

	test("disposeAll（会话 teardown）：挂起面板以 cancelled 结算，widget 采样停止", async () => {
		const { sink, frames } = collect();
		const bridge = createPanelBridge({ sink });
		const panel = bridge.openCustom(() => makeComponent("stuck").component, undefined, undefined);
		// render 每次都不一样：若采样定时器还活着，teardown 后还会继续推新帧
		let renders = 0;
		bridge.openWidget("dash", () => ({ render: () => [`w${++renders}`] }), undefined, undefined);
		await Bun.sleep(10);
		// widget 首帧在 openWidget 里就上屏（与 custom 路径一致），所以不靠 80ms 采样点
		expect(frames().map((f) => f.type)).toEqual(["open", "frame", "open", "frame"]);

		bridge.disposeAll();
		await expect(panel).resolves.toBeUndefined();
		expect(frames().at(-1)).toMatchObject({ type: "close", panelId: "p1", reason: "cancel" });

		// widget 的采样定时器必须停：否则面板关掉后仍会向 kernel 推帧
		await Bun.sleep(200);
		expect(frames().filter((f) => f.panelId === "w:dash" && f.type === "frame")).toHaveLength(1);
	});
});

describe("patchUiForTuiHost + createPanelBridge：会话重建", () => {
	test("teardown 后新 bridge 接管同一个 ui 对象，custom 重新可用（reload 场景）", async () => {
		const { ui } = makeUi();
		const asUi = ui as unknown as Record<string, unknown>;

		// 第一个会话：patch 后又被 teardown（pi 的 session_shutdown）
		const first = collect();
		const firstBridge = createPanelBridge({ sink: first.sink });
		patchUiForTuiHost(asUi, firstBridge);
		firstBridge.disposeAll();

		// reload：同一个 uiContext 对象 + 新 bridge（旧 bridge 的 disposed 不可逆）
		const second = collect();
		const secondBridge = createPanelBridge({ sink: second.sink });
		patchUiForTuiHost(asUi, secondBridge);

		const panel = ui.custom(() => makeComponent("after-reload").component, undefined, undefined);
		await waitFor(() => second.frames().some((f) => f.type === "open"));
		expect(second.frames().map((f) => f.type)).toEqual(["open", "frame"]);

		secondBridge.handleInput({ type: "cancel", panelId: second.frames()[0]?.panelId as string });
		await expect(panel).resolves.toBeUndefined();
		expect(second.frames().at(-1)?.reason).toBe("cancel");
	});
});
