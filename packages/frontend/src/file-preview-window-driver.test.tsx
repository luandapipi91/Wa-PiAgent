// 文件预览独立窗口主窗口侧 driver 的行为契约。
// 设施模式照抄 preview-window-driver.test.tsx：装桥 mock 收集 calls/listeners，
// emit 用 act 派发；afterEach(cleanup) 必须——renderHook 跨用例 hook 泄漏是踩过的坑。
import { test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderHook, act, cleanup } from "@testing-library/react";
import {
	useFilePreviewWindowDriver,
	loadFilePreviewDetachedRect,
	saveFilePreviewDetachedRect,
} from "./file-preview-window-driver";
import { useSessionStore } from "./store/session";
import { useSettingsStore } from "./store/settings";
import { useToastStore } from "./store/toast";

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

// ── 接线契约（源码断言；main.cjs 类做法，锁挂载点防回潮）──

const appSrc = readFileSync(join(import.meta.dir, "App.tsx"), "utf8");
const mainTsxSrc = readFileSync(join(import.meta.dir, "main.tsx"), "utf8");
const rootSrc = readFileSync(
	join(import.meta.dir, "components", "PreviewWindowRoot.tsx"),
	"utf8",
);

test("App.tsx 挂载文件窗口 driver", () => {
	expect(appSrc).toContain("useFilePreviewWindowDriver()");
});

test("App.tsx 的 FilePreviewModal 仅无桥时渲染（有桥进独立窗口，杜绝双份）", () => {
	// 同一片源码里同时出现桥判断与常驻挂载点
	const i = appSrc.indexOf("<FilePreviewModal />");
	expect(i).toBeGreaterThan(-1);
	const ctx = appSrc.slice(Math.max(0, i - 200), i + 50);
	expect(ctx).toContain("hasFilePreviewBridge");
});

test("PreviewWindowRoot 内的 FilePreviewModal 保持无条件渲染（保住 html 窗口「代码」按钮）", () => {
	expect(rootSrc).toContain("<FilePreviewModal />");
	// 若误套「无桥才渲染」，html 独立窗口内有桥会把该现有功能砍成点了没反应
	expect(rootSrc).not.toContain("hasFilePreviewBridge");
});

test("main.tsx 按 kind=file 分流到 FilePreviewWindowRoot", () => {
	expect(mainTsxSrc).toContain("FilePreviewWindowRoot");
	expect(mainTsxSrc).toContain('kind === "file"');
});

// 窗口创建后加载失败（ready 超时 / did-fail-load）：主进程关窗前回报 load-failed，
// driver 收尾 store 并 toast 提示可重试（2026-11-26 补充防御）。
test("load-failed 事件 → 清空 filePreview + 入队 error toast（提示重试）", () => {
	renderHook(() => useFilePreviewWindowDriver());
	useSessionStore.setState({
		filePreview: { path: "/work/a.md", sessionId: "s1" },
	});
	const before = useToastStore.getState().toasts.length;
	emit({ type: "load-failed" });
	expect(useSessionStore.getState().filePreview).toBeNull();
	const toasts = useToastStore.getState().toasts;
	expect(toasts.length).toBe(before + 1);
	expect(toasts[toasts.length - 1].type).toBe("error");
});
