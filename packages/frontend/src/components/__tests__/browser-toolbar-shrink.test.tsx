// BrowserPanel × 工具栏窄面板收缩契约（bun:test + @testing-library/react）：
// 回归背景：工具栏单行 nowrap，地址栏 shrink-0 锁死宽度，split 半屏面板宽度
// 小于工具栏需求总宽时 flex 行向右溢出、被 split 容器 overflow-hidden 裁剪，
// 行尾的关闭按钮最先不可见（小窗口下用户点不到关闭）。
// 契约（布局行为需真实浏览器验证，见 e2e/preview-close-narrow.spec.ts；
// 这里锁定 DOM/class 层的收缩契约）：
//   1) 工具栏允许换行（flex-wrap）——极窄面板下按钮行整体换行兜底；
//   2) 地址栏容器可收缩（min-w-0，不再 shrink-0）——中窄面板下地址栏先让位。
import { beforeEach, afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

// —— BrowserPanel 的外围依赖 mock（与 browser-url-bar.test.tsx 同套）——
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
const { URLBAR_WIDTH_KEY } = await import("../urlbar-size");

afterEach(() => cleanup());

beforeEach(() => {
	localStorage.removeItem(URLBAR_WIDTH_KEY);
	useBrowserStore.setState({
		open: true,
		path: "/tmp/proj/index.html",
		sessionId: "s1",
		mode: "split",
		refreshToken: 0,
		bySession: {},
	});
});

function toolbarEl(): HTMLElement {
	// 工具栏 = 面板根节点下第一个子 div
	const panel = screen.getByTestId("browser-panel");
	return panel.firstElementChild as HTMLElement;
}

function urlAreaEl(): HTMLElement {
	// 输入区容器 = 地址 input 的直接父级
	return screen.getByTestId("browser-input").parentElement as HTMLElement;
}

test("工具栏允许换行（flex-wrap）：极窄面板下按钮行整体换行兜底", () => {
	render(<BrowserPanel />);
	expect(toolbarEl().className).toContain("flex-wrap");
});

test("地址栏容器可收缩（min-w-0，无 shrink-0）：中窄面板下地址栏先让位", () => {
	render(<BrowserPanel />);
	const cls = urlAreaEl().className;
	expect(cls).toContain("min-w-0");
	expect(cls).not.toContain("shrink-0");
});
