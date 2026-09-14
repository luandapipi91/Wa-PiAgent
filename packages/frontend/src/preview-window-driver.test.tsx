import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { usePreviewWindowDriver } from "./preview-window-driver";
import { useBrowserStore } from "./store/browser";
import { useSettingsStore } from "./store/settings";

interface Calls {
	opens: any[];
	cmds: any[];
	acts: any[];
	sizes: any[];
}

let calls: Calls;
let listeners: Array<(e: any) => void>;

function installBridge() {
	calls = { opens: [], cmds: [], acts: [], sizes: [] };
	listeners = [];
	(window as any).waPiPreviewWin = {
		open: async (p: any) => {
			calls.opens.push(p);
			return { ok: true };
		},
		cmd: (p: any) => calls.cmds.push(p),
		act: (p: any) => calls.acts.push(p),
		setSize: (p: any) => calls.sizes.push(p),
		onEvent: (cb: any) => {
			listeners.push(cb);
			return () => {
				listeners = listeners.filter((l) => l !== cb);
			};
		},
	};
}

/** 模拟独立窗口 → 主窗口的事件 */
function emit(e: any) {
	act(() => {
		for (const l of listeners) l(e);
	});
}

function resetStore() {
	useBrowserStore.setState({
		open: false,
		path: null,
		sessionId: null,
		mode: "split",
		minimized: false,
		detachedRect: null,
		bySession: {},
	});
}

beforeEach(() => {
	installBridge();
	resetStore();
});

afterEach(() => {
	delete (window as any).waPiPreviewWin;
	resetStore();
});

test("浮动模式 + 预览打开 → 请求开窗（带 path/sessionId 与记忆位置）", () => {
	useBrowserStore.setState({
		open: true,
		path: "/proj/index.html",
		sessionId: "s-1",
		mode: "float",
		detachedRect: { x: 200, y: 120, w: 900, h: 700 },
	});
	renderHook(() => usePreviewWindowDriver());
	expect(calls.opens).toEqual([
		{
			path: "/proj/index.html",
			sessionId: "s-1",
			rect: { x: 200, y: 120, w: 900, h: 700 },
		},
	]);
	expect(calls.cmds).toEqual([{ type: "restore" }]); // 未最小化 → 显示并聚焦
});

test("非浮动模式 → 不下发开窗，改为要求关窗（内嵌承载）", () => {
	useBrowserStore.setState({
		open: true,
		path: "/proj/index.html",
		mode: "split",
	});
	renderHook(() => usePreviewWindowDriver());
	expect(calls.opens).toEqual([]);
	expect(calls.cmds).toEqual([{ type: "close" }]);
});

test("预览关闭 → 要求关窗", () => {
	useBrowserStore.setState({ open: false, mode: "float" });
	renderHook(() => usePreviewWindowDriver());
	expect(calls.cmds).toEqual([{ type: "close" }]);
});

test("最小化 → 要求隐藏窗口；恢复 → 要求显示并聚焦", () => {
	useBrowserStore.setState({ open: true, path: "/a.html", mode: "float" });
	renderHook(() => usePreviewWindowDriver());
	expect(calls.cmds.at(-1)).toEqual({ type: "restore" });

	act(() => useBrowserStore.getState().setMinimized(true));
	expect(calls.cmds.at(-1)).toEqual({ type: "hide" });

	act(() => useBrowserStore.getState().setMinimized(false));
	expect(calls.cmds.at(-1)).toEqual({ type: "restore" });
});

describe("独立窗口上报的事件翻译", () => {
	test("minimized → 标记最小化（主窗口据此渲染气泡）", () => {
		renderHook(() => usePreviewWindowDriver());
		emit({ type: "minimized" });
		expect(useBrowserStore.getState().minimized).toBe(true);
	});

	test("close → 关闭预览并清该会话记忆", () => {
		useBrowserStore.setState({
			open: true,
			path: "/a.html",
			sessionId: "A",
			mode: "float",
		});
		renderHook(() => usePreviewWindowDriver());
		emit({ type: "close" });
		expect(useBrowserStore.getState().open).toBe(false);
		expect(useBrowserStore.getState().path).toBeNull();
		expect(useBrowserStore.getState().bySession.A).toEqual({
			open: false,
			path: null,
			minimized: false,
		});
	});

	test("mode → 切回主窗口内嵌模式", () => {
		useBrowserStore.setState({ open: true, path: "/a.html", mode: "float" });
		renderHook(() => usePreviewWindowDriver());
		emit({ type: "mode", mode: "split" });
		expect(useBrowserStore.getState().mode).toBe("split");
	});

	test("rect → 持久化屏幕坐标（下次弹出回到原位）", () => {
		renderHook(() => usePreviewWindowDriver());
		emit({ type: "rect", rect: { x: -1200, y: 40, w: 1000, h: 800 } });
		expect(useBrowserStore.getState().detachedRect).toEqual({
			x: -1200,
			y: 40,
			w: 1000,
			h: 800,
		});
		expect(localStorage.getItem("hiagent.browser.detachedRect")).toContain(
			"-1200",
		);
	});

	test("element → 派发插入事件（前后补空格，与内嵌口径一致）", () => {
		const texts: string[] = [];
		const on = (e: Event) => texts.push((e as CustomEvent).detail.text);
		window.addEventListener("wa-pi:insert-mention", on);
		renderHook(() => usePreviewWindowDriver());
		emit({ type: "element", token: "![/proj/index.html|12-20|div.card]" });
		window.removeEventListener("wa-pi:insert-mention", on);
		expect(texts).toEqual([" ![/proj/index.html|12-20|div.card] "]);
	});

	test("开启主窗口设置：open-settings → 打开设置并定位到指定分区（如 share）", () => {
		useSettingsStore.setState({ showSettings: false, activeSection: "general" });
		renderHook(() => usePreviewWindowDriver());
		emit({ type: "open-settings", section: "share" });
		expect(useSettingsStore.getState().showSettings).toBe(true);
		expect(useSettingsStore.getState().activeSection).toBe("share");
	});

	test("closed 兜底：仍自称浮动模式 → 收尾为关闭预览", () => {
		useBrowserStore.setState({ open: true, path: "/a.html", mode: "float" });
		renderHook(() => usePreviewWindowDriver());
		emit({ type: "closed" });
		expect(useBrowserStore.getState().open).toBe(false);
	});

	test("closed 不重复动作：已切回内嵌（mode 已变）→ 保持预览打开", () => {
		useBrowserStore.setState({ open: true, path: "/a.html", mode: "float" });
		renderHook(() => usePreviewWindowDriver());
		emit({ type: "mode", mode: "full" });
		emit({ type: "closed" });
		expect(useBrowserStore.getState().open).toBe(true);
		expect(useBrowserStore.getState().mode).toBe("full");
	});
});

test("无 IPC 桥（浏览器 dev）时静默不崩", () => {
	delete (window as any).waPiPreviewWin;
	useBrowserStore.setState({ open: true, path: "/a.html", mode: "float" });
	expect(() => renderHook(() => usePreviewWindowDriver())).not.toThrow();
});
