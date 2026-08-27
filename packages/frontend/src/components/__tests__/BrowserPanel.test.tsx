// BrowserPanel × 预览自动刷新 组件测试（bun:test + @testing-library/react）：
// 刷新令牌（store.refreshToken）驱动 iframe 重挂——file_changes 命中后 store 令牌递增，
// iframe 必须替换为新节点（重新加载磁盘最新内容）；手动刷新按钮与自动刷新同源（bumpRefresh）。
// 契约：store 里已有 maybeRefreshForFileChanges 判定（见 browser-refresh.test.ts）、
// session 事件接线（见 session-file-changes-refresh.test.ts），这里锁「令牌变化 → iframe 真的重挂」。
import { beforeEach, afterEach, expect, mock, test } from "bun:test";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	act,
} from "@testing-library/react";

// —— BrowserPanel 的外围依赖 mock（被测联动只涉及 browser store + HtmlPreview）——
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

afterEach(() => cleanup());

beforeEach(() => {
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

test("初始挂载：预览打开即渲染 iframe，src 指向预览路由", () => {
	render(<BrowserPanel />);
	const f = iframeEl();
	expect(f).toBeTruthy();
	expect(f.getAttribute("src")).toContain("/preview/");
});

test("刷新令牌递增（file_changes 命中后的效果）→ iframe 替换为新节点", () => {
	const { unmount } = render(<BrowserPanel />);
	const before = iframeEl();
	expect(before.isConnected).toBe(true);
	// 模拟自动刷新命中：store 令牌 +1（接线与判定已在 store/session 测试锁定）
	// act 包裹：zustand 更新在 act 外触发时 React 18 异步调度，断言前 DOM 未刷新
	act(() => {
		useBrowserStore.getState().bumpRefresh();
	});
	const after = iframeEl();
	expect(after).not.toBe(before); // key 变化 → 重挂 → 新 DOM 节点
	expect(after.isConnected).toBe(true);
	expect(useBrowserStore.getState().refreshToken).toBe(1);
	unmount();
});

test("手动刷新按钮与自动刷新同源：点击递增 store 令牌并重挂 iframe", () => {
	const { unmount } = render(<BrowserPanel />);
	const before = iframeEl();
	fireEvent.click(screen.getByTestId("browser-refresh"));
	const after = iframeEl();
	expect(after).not.toBe(before);
	expect(useBrowserStore.getState().refreshToken).toBe(1);
	unmount();
});
