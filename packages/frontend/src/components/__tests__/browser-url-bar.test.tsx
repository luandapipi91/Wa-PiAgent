// BrowserPanel × URL 地址栏可拖拽调宽 组件测试（bun:test + @testing-library/react）：
// 此前地址栏 flex-1 占满剩余空间显得过长；改为默认限宽 + SidebarResizer 拖拽把手，
// 且多余空白落在输入区与按钮之间（按钮组贴工具栏右缘，不被输入区伸缩挤动）。
// 契约：
//   1) 初始宽度来自 localStorage（hiagent.preview.urlbar.width），无值回退默认 360；
//   2) 拖拽把手水平位移 → 输入区宽度实时更新，松手后持久化；
//   3) clamp [160, 工具栏宽 − 按钮区预留]；
//   4) 宽度改变不影响任何图标按钮的存在与可点性。
import { beforeEach, afterEach, expect, mock, test } from "bun:test";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	act,
} from "@testing-library/react";

// —— BrowserPanel 的外围依赖 mock（与 browser-inspect-toggle.test.tsx 同套）——
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

/** 与实现一致的把手 testId */
const HANDLE_ID = "browser-url-resize";

afterEach(() => cleanup());

beforeEach(() => {
	// 拉大模拟视口：确保比例上限（innerWidth×0.6）不小于绝对上限（工具栏−按钮预留），
	// 否则 happy-dom 默认 1024 视口会让断言被比例上限抢先生效
	Object.defineProperty(window, "innerWidth", {
		value: 2400,
		configurable: true,
	});
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
	// 输入区容器 = 地址 input 的直接父级（宽度受控于 inline style）
	return screen.getByTestId("browser-input").parentElement as HTMLElement;
}

/** 固定工具栏布局宽度（happy-dom 无布局引擎，clientWidth 恒为 0，需显式注入） */
function withToolbarWidth(px: number) {
	Object.defineProperty(toolbarEl(), "clientWidth", {
		value: px,
		configurable: true,
	});
}

function dragTo(dx: number, opts?: { skipUp?: boolean }) {
	const handle = screen.getByTestId(HANDLE_ID);
	// 记录 handle 初始视口 X（happy-dom getBoundingClientRect 恒 0，鼠标事件自造坐标即可）
	fireEvent.mouseDown(handle, { clientX: 100 });
	act(() => {
		window.dispatchEvent(new MouseEvent("mousemove", { clientX: 100 + dx }));
	});
	if (!opts?.skipUp) {
		act(() => {
			window.dispatchEvent(new MouseEvent("mouseup"));
		});
	}
}

test("无定制记录时默认占工具栏一半（CSS 50%），且存在拖拽把手", () => {
	render(<BrowserPanel />);
	expect(urlAreaEl().style.width).toBe("50%");
	expect(screen.getByTestId(HANDLE_ID)).toBeTruthy();
});

test("localStorage 已有宽度（如 480）→ 挂载时恢复", () => {
	localStorage.setItem(URLBAR_WIDTH_KEY, "480");
	render(<BrowserPanel />);
	expect(urlAreaEl().style.width).toBe("480px");
});

test("从默认半宽起点向右拖 100px → 600，松手后持久化", () => {
	render(<BrowserPanel />);
	withToolbarWidth(1000); // 起点 = 工具栏一半 500；上限 1000-380=620
	dragTo(100);
	expect(urlAreaEl().style.width).toBe("600px");
	expect(localStorage.getItem(URLBAR_WIDTH_KEY)).toBe("600");
});

test("拖过头：向上限截断（工具栏 1000 − 按钮预留 = 620）", () => {
	render(<BrowserPanel />);
	withToolbarWidth(1000);
	dragTo(2000);
	expect(urlAreaEl().style.width).toBe("620px");
	expect(localStorage.getItem(URLBAR_WIDTH_KEY)).toBe("620");
});

test("向左拖过头：不低于最小宽度 160", () => {
	render(<BrowserPanel />);
	withToolbarWidth(1000);
	dragTo(-3000);
	expect(Number.parseInt(urlAreaEl().style.width, 10)).toBe(160);
	expect(localStorage.getItem(URLBAR_WIDTH_KEY)).toBe("160");
});

test("把手可视化提示：悬浮 title 且渲染为 inline 小把手形态", () => {
	render(<BrowserPanel />);
	const handle = screen.getByTestId(HANDLE_ID);
	// i18n 由 bunfig preload 初始化（返回真实文案），这里只锁「可发现性」契约本身
	expect(handle.getAttribute("title")).toBeTruthy();
	expect(handle.getAttribute("data-variant")).toBe("inline");
});

test("宽度变化后所有图标按钮仍然存在且可用（刷新可点击）", () => {
	render(<BrowserPanel />);
	withToolbarWidth(1000);
	dragTo(140);
	const refresh = screen.getByTestId("browser-refresh") as HTMLButtonElement;
	expect(refresh.disabled).toBe(false);
	fireEvent.click(refresh);
	expect(useBrowserStore.getState().refreshToken).toBe(1);
});
