// NewSessionPane × 小视口输入框可达性 组件测试：
// 根因（系统化调试定位）：主列为「无收缩出口 + justify-center 对称溢出」的 flex 列，
// 文件树 aside 挤窄主列 → ComposerInput/附件 chips 换行增高 → 内容总高超限 →
// 整列溢出且底部（输入框）被祖先 overflow-hidden 裁出视口。
// 契约：主列必须提供「溢出时改为顶对齐可滚动」的安全出口（scroll 容器 +
// min-h-full 内层保持常规视口下的视觉居中不变），保证任何视口下输入框可达。
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

const { NewSessionPane } = await import("../NewSessionPane");

afterEach(() => cleanup());

beforeEach(() => {
	Object.defineProperty(window, "innerWidth", {
		value: 2400,
		configurable: true,
	});
});

test("主列提供纵向滚动出口，且移除对称溢出元凶 justify-center", () => {
	render(<NewSessionPane />);
	const mainCol = screen.getByTestId("new-session-scroll");
	// 兼容滚动出口：内容超高时可滚达输入框，而非被祖先裁剪
	expect(mainCol.className).toContain("overflow-y-auto");
	// 元凶移除：justify-center 在溢出时上下对称裁切（输入框恰在下半截）
	expect(mainCol.className).not.toContain("justify-center");
});
