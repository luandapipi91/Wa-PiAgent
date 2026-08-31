// BrowserPanel × 元素选中显性开关 组件测试（bun:test + @testing-library/react）：
// 此前「元素选中/高亮」只能靠页面内 Ctrl/⌘ 快捷键切换（preview-inspect.js 处理），
// 主应用工具栏无可视入口。本组测试锁定新增开关的行为契约：
//   1) 开关初始态来自 localStorage（hiagent.preview.inspect，缺省开启）；
//   2) 点击切换 → 回写 localStorage + 向预览 iframe postMessage hiagent:inspect:set；
//   3) iframe 上报 hiagent:inspect:changed（快捷键切换的结果）→ 按钮状态反向同步；
//   4) 仅本地预览可用（外部 URL 无注入脚本），空窗口/无内容时禁用。
import { beforeEach, afterEach, expect, mock, test } from "bun:test";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	act,
} from "@testing-library/react";

// —— BrowserPanel 的外围依赖 mock（被测联动只涉及 browser store + HtmlPreview + message 协议）——
mock.module("../store/session", () => ({
	useSessionStore: Object.assign((sel: any) => sel({}), {
		getState: () => ({ openFilePreview: () => {} }),
	}),
}));
mock.module("../store/projects", () => ({
	useProjectsStore: Object.assign((sel: any) => sel({ projects: [] }), {
		getState: () => ({ projects: [] }),
	}),
}));
mock.module("../store/toast", () => ({
	useToastStore: Object.assign((sel: any) => sel({}), {
		getState: () => ({ add: () => {} }),
	}),
}));
mock.module("../util/clipboard", () => ({
	copyToClipboard: async () => {},
}));
mock.module("../../element-pick", () => ({
	parseInspectMessage: () => null,
	sendElementToChat: async () => {},
}));
mock.module("../i18n/useTranslation", () => ({
	useTranslation: () => ({ t: (k: string) => k }),
}));
mock.module("./ui/Icon", () => ({
	Icon: (props: any) => <svg data-icon={props.name} />,
}));
mock.module("./ui/ShareButton", () => ({
	ShareResultModal: () => null,
}));

import { useBrowserStore } from "../../store/browser";

const { BrowserPanel } = await import("../BrowserPanel");

/** 与 BrowserPanel 内约定一致的持久化键（协议字符串，kernel 注入脚本同源使用） */
const INSPECT_KEY = "hiagent.preview.inspect";

afterEach(() => cleanup());

beforeEach(() => {
	localStorage.removeItem(INSPECT_KEY);
	useBrowserStore.setState({
		open: true,
		path: "/tmp/proj/index.html",
		sessionId: "s1",
		mode: "split",
		refreshToken: 0,
		bySession: {},
	});
});

function iframeEl(): HTMLIFrameElement {
	return screen.getByTestId("html-preview-iframe") as HTMLIFrameElement;
}

function inspectBtn(): HTMLButtonElement {
	return screen.getByTestId("browser-inspect") as HTMLButtonElement;
}

test("本地预览默认渲染选中开关，缺省为开启态（localStorage 无值）", () => {
	render(<BrowserPanel />);
	const btn = inspectBtn();
	expect(btn).toBeTruthy();
	expect(btn.getAttribute("aria-pressed")).toBe("true");
	expect(btn.disabled).toBe(false);
});

test("localStorage 标记 off 时开关初始为关闭态", () => {
	localStorage.setItem(INSPECT_KEY, "off");
	render(<BrowserPanel />);
	expect(inspectBtn().getAttribute("aria-pressed")).toBe("false");
});

test("点击关闭：回写 off 并向 iframe 发送 inspect:set(false)", () => {
	render(<BrowserPanel />);
	const win = iframeEl().contentWindow!;
	const postSpy = mock((_data: any, _origin: string) => {});
	win.postMessage = postSpy as any;
	fireEvent.click(inspectBtn());
	expect(inspectBtn().getAttribute("aria-pressed")).toBe("false");
	expect(localStorage.getItem(INSPECT_KEY)).toBe("off");
	expect(postSpy).toHaveBeenCalledWith(
		{ type: "hiagent:inspect:set", enabled: false },
		"*",
	);
});

test("再次点击开启：回写 on 并向 iframe 发送 inspect:set(true)", () => {
	localStorage.setItem(INSPECT_KEY, "off");
	render(<BrowserPanel />);
	const win = iframeEl().contentWindow!;
	const postSpy = mock((_data: any, _origin: string) => {});
	win.postMessage = postSpy as any;
	fireEvent.click(inspectBtn());
	expect(inspectBtn().getAttribute("aria-pressed")).toBe("true");
	expect(localStorage.getItem(INSPECT_KEY)).toBe("on");
	expect(postSpy).toHaveBeenCalledWith(
		{ type: "hiagent:inspect:set", enabled: true },
		"*",
	);
});

test("iframe 上报 changed（快捷键切换结果）→ 按钮状态与 localStorage 反向同步", () => {
	render(<BrowserPanel />);
	const f = iframeEl();
	// 构造 source 匹配预览 iframe 的消息（parseInspectMessage 已被 mock 掉，不影响）
	const evt = new Event("message") as any;
	evt.data = { type: "hiagent:inspect:changed", enabled: false };
	evt.source = f.contentWindow;
	act(() => {
		window.dispatchEvent(evt);
	});
	expect(inspectBtn().getAttribute("aria-pressed")).toBe("false");
	expect(localStorage.getItem(INSPECT_KEY)).toBe("off");
});

test("无内容（空窗口）时开关禁用", () => {
	useBrowserStore.setState({ path: null });
	render(<BrowserPanel />);
	expect(inspectBtn().disabled).toBe(true);
});

test("iframe load 后主动 push 当前开关状态（与 iframe 主动 query 双通道互补）", () => {
	// 场景：刷新/换代后 iframe 主动 query 可能被 source 校验丢弃（曾致开关与实际
	// 高亮状态不符）——load 完成后主应用主动 push 一次，确定性对齐。
	localStorage.setItem(INSPECT_KEY, "off");
	render(<BrowserPanel />);
	const iframe = iframeEl();
	const postSpy = mock((_data: any, _origin: string) => {});
	iframe.contentWindow!.postMessage = postSpy as any;
	act(() => {
		fireEvent.load(iframe);
	});
	expect(postSpy).toHaveBeenCalledWith(
		{ type: "hiagent:inspect:set", enabled: false },
		"*",
	);
});
