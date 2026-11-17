// 文件预览独立窗口主窗口侧 driver 的行为契约。
// 设施模式照抄 preview-window-driver.test.tsx：装桥 mock 收集 calls/listeners，
// emit 用 act 派发；afterEach(cleanup) 必须——renderHook 跨用例 hook 泄漏是踩过的坑。
import { test, expect, beforeEach, afterEach } from "bun:test";
import { renderHook, act, cleanup } from "@testing-library/react";
import {
	useFilePreviewWindowDriver,
	loadFilePreviewDetachedRect,
	saveFilePreviewDetachedRect,
} from "./file-preview-window-driver";
import { useSessionStore } from "./store/session";
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
	calls.acts = [];
	listeners = [];
	(window as any).waPiFilePreviewWin = {
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

/** 模拟独立窗口 → 主窗口的事件（filepreviewwin:event 经主进程中转） */
function emit(e: any) {
	act(() => {
		for (const l of listeners) l(e);
	});
}

function resetFilePreview() {
	useSessionStore.setState({ filePreview: null });
	localStorage.removeItem("waPiFilePreviewDetachedRect");
}

beforeEach(() => {
	installBridge();
	resetFilePreview();
});

afterEach(() => {
	cleanup();
	delete (window as any).waPiFilePreviewWin;
	resetFilePreview();
});

test("filePreview 非空且有桥 → open 携带 path/sessionId（无记忆位置时 rect 为 null）", () => {
	useSessionStore.setState({ filePreview: { path: "/a/x.md", sessionId: "s1" } });
	renderHook(() => useFilePreviewWindowDriver());
	expect(calls.opens).toEqual([{ path: "/a/x.md", sessionId: "s1", rect: null }]);
});

test("再次 open 携带持久化的 rect（上次拖动位置记忆）", () => {
	saveFilePreviewDetachedRect({ x: 11, y: 22, w: 700, h: 500 });
	useSessionStore.setState({ filePreview: { path: "/a/y.md", sessionId: "s2" } });
	renderHook(() => useFilePreviewWindowDriver());
	expect(calls.opens).toEqual([
		{ path: "/a/y.md", sessionId: "s2", rect: { x: 11, y: 22, w: 700, h: 500 } },
	]);
});

test("filePreview 清空 → 要求关窗（主进程对无窗口场景静默忽略）", () => {
	useSessionStore.setState({ filePreview: { path: "/a/x.md", sessionId: "s1" } });
	renderHook(() => useFilePreviewWindowDriver());
	expect(calls.cmds).toEqual([]);
	act(() => {
		useSessionStore.getState().closeFilePreview();
	});
	expect(calls.cmds).toEqual([{ type: "close" }]);
});

test("无桥（纯浏览器）→ store 变化不调任何桥也不抛错", () => {
	delete (window as any).waPiFilePreviewWin;
	renderHook(() => useFilePreviewWindowDriver());
	expect(() => {
		act(() => {
			useSessionStore.setState({ filePreview: { path: "/a/z.md", sessionId: "s3" } });
		});
	}).not.toThrow();
	// 桥 mock 已卸载：calls 不再增长（后续即便重装桥也不会收到迟到的调用）
	expect(calls.opens).toEqual([]);
	expect(calls.cmds).toEqual([]);
});

test("closed 事件 → closeFilePreview；store 已空时不再重复动作（幂等守卫）", () => {
	useSessionStore.setState({ filePreview: { path: "/a/x.md", sessionId: "s1" } });
	renderHook(() => useFilePreviewWindowDriver());
	emit({ type: "closed" });
	expect(useSessionStore.getState().filePreview).toBeNull();
	// 兜底不重复：已经为空时再收到 closed（如正常关闭路径已清空后的迟到回报）不再动作
	emit({ type: "closed" });
	expect(useSessionStore.getState().filePreview).toBeNull();
});

test("rect 事件 → 持久化到 localStorage（下次 open 回原位）", () => {
	renderHook(() => useFilePreviewWindowDriver());
	emit({ type: "rect", rect: { x: 9, y: 8, w: 700, h: 500 } });
	expect(loadFilePreviewDetachedRect()).toEqual({ x: 9, y: 8, w: 700, h: 500 });
});

test("path 事件 → openFilePreview 更新 store；同值重复上报引用不变（回环终止）", () => {
	renderHook(() => useFilePreviewWindowDriver());
	emit({ type: "path", path: "/a/y.md", sessionId: "s1" });
	const first = useSessionStore.getState().filePreview;
	expect(first).toEqual({ path: "/a/y.md", sessionId: "s1" });
	emit({ type: "path", path: "/a/y.md", sessionId: "s1" });
	expect(useSessionStore.getState().filePreview).toBe(first);
});

test("open-settings 事件 → 设置弹窗打开并切到对应节", () => {
	renderHook(() => useFilePreviewWindowDriver());
	emit({ type: "open-settings", section: "share" });
	const s = useSettingsStore.getState() as any;
	expect(s.showSettings).toBe(true);
	expect(s.activeSection).toBe("share");
});
