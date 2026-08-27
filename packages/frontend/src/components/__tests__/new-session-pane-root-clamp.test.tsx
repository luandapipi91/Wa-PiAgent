// NewSessionPane × 文件树撑高整行 组件测试：
// 根因（系统化调试定位）：根行 `flex-1 flex min-w-0` 作为 App.tsx overflow-hidden flex 列的
// 子项缺 min-h-0 高度钳制，flex 子项的 automatic minimum size（min-content）被右侧文件树
// 内容高度撑破 → 整行高溢出 → 排在主列文档流末端的 ComposerInput 被 overflow-hidden
// 祖先裁出视口，且滚动不可达。
// 对照组：SessionView.tsx 根行带 h-full，同款 aside 写法不复发 → 根行钳制缺失为充分根因。
// 契约：根行必须带 min-h-0，文件树内容高时由 aside 内部 flex-1 overflow-auto 吸收为内部滚动。
// 既有 reachability 测试只覆盖「输入框自身增高」路径且默认收起文件树，本测试补「文件树展开」路径。
import { beforeEach, afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

// —— 外围副作用隔离（__tests__ 下相对前缀必须 ../../，少一级会静默无效）——
mock.module("../../api-client", () => ({
	api: {
		get: async () => ({}),
		post: async () => ({}),
		put: async () => ({}),
		del: async () => ({}),
	},
}));
mock.module("../../store/session", () => ({
	useSessionStore: Object.assign((sel: any) => sel({}), {
		getState: () => ({ openFilePreview: () => {} }),
	}),
}));
mock.module("../../store/browser", () => ({
	useBrowserStore: Object.assign((sel: any) => sel({}), {
		getState: () => ({ openBrowser: () => {}, activateSession: () => {} }),
	}),
}));
// 只关心布局壳层，文件树内容非本测试关注点
mock.module("../ExplorerPanel", () => ({
	ExplorerPanel: () => <div data-testid="explorer-panel-stub" />,
}));

const { NewSessionPane } = await import("../NewSessionPane");
const { useNewSessionExplorerStore } = await import(
	"../../store/new-session-explorer"
);

afterEach(() => cleanup());

beforeEach(() => {
	Object.defineProperty(window, "innerWidth", {
		value: 2400,
		configurable: true,
	});
});

test("文件树展开时根行带 min-h-0：树内容再高也不撑破 overflow-hidden 祖先", () => {
	// 默认收起，显式展开以覆盖撑高路径
	useNewSessionExplorerStore.setState({ open: true });
	render(<NewSessionPane />);

	const root = screen.getByTestId("new-session-pane");
	// 根行高度钳制：解除 automatic minimum size，行高钉在父容器分配值
	expect(root.className).toContain("min-h-0");

	// aside 已渲染且内部滚动出口就位
	const aside = screen.getByTestId("new-session-explorer-aside");
	expect(aside).toBeTruthy();
	expect(aside.querySelector(".flex-1.overflow-auto")).toBeTruthy();
});
