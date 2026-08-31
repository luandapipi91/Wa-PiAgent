// ExplorerPanel × 右键菜单视口钳制 测试：
// 根因（系统化调试定位）：ep-ctx-menu 用 e.clientY 原样作 position:fixed 的 top，
// 无任何视口边界检测/翻转 → 树底部文件右键时菜单（约 130px 高）固定向下展开，
// 底部菜单项落出视口无法点击。
// 修复契约：菜单渲染后实测尺寸并钳制到视口内（复用 ProjectItem 的 clampMenuPos/useClampMenu
// 既有范本），NewSessionPane 与 SessionView 两处文件树共用本组件，一处修复两处受益。
import { beforeEach, afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// —— 外围副作用隔离（__tests__ 下相对前缀必须 ../../，少一级会静默无效）——
mock.module("../../fs-client", () => ({
	listDir: async () => [
		{ name: "a.txt", isDir: false },
		{ name: "b.txt", isDir: false },
	],
	revealFile: async () => {},
	openFileWithDefaultApp: async () => {},
}));
mock.module("../../store/toast", () => ({
	useToastStore: Object.assign((sel: any) => sel({ add: () => {} }), {
		getState: () => ({ add: () => {} }),
	}),
}));

const { ExplorerPanel } = await import("../ExplorerPanel");
const { clampMenuPos } = await import("../ProjectItem");

// —— clampMenuPos 纯函数守护（ProjectItem 既有导出，防改动回归）——
test("clampMenuPos：底部溢出时上移到视口内", () => {
	const { top, left } = clampMenuPos(350, 380, 140, 130, 1280, 400);
	expect(top).toBe(262); // 400 - 130 - 8
	expect(left).toBe(350); // 未超右边界，不动
});

test("clampMenuPos：右侧溢出时左移，视口内原样", () => {
	expect(clampMenuPos(1200, 100, 140, 130, 1280, 400).left).toBe(1132);
	expect(clampMenuPos(100, 100, 140, 130, 1280, 400)).toEqual({
		left: 100,
		top: 100,
	});
});

test("clampMenuPos：极端超高菜单不产生负坐标", () => {
	const { top } = clampMenuPos(350, 380, 140, 5000, 1280, 400);
	expect(top).toBe(8); // Math.max 保护
});

// —— 集成：右键树节点 → 菜单渲染后钳制到视口内 ——
const origGetBCR = HTMLElement.prototype.getBoundingClientRect;

afterEach(() => {
	cleanup();
	HTMLElement.prototype.getBoundingClientRect = origGetBCR;
});

beforeEach(() => {
	Object.defineProperty(window, "innerWidth", {
		value: 1280,
		configurable: true,
	});
	Object.defineProperty(window, "innerHeight", {
		value: 400,
		configurable: true,
	});
	// jsdom 无布局引擎：模拟菜单实测尺寸 140×130（.ep-ctx-menu 典型尺寸）
	HTMLElement.prototype.getBoundingClientRect = () =>
		({
			width: 140,
			height: 130,
			top: 9999,
			left: 9999,
			right: 10139,
			bottom: 10129,
			x: 9999,
			y: 9999,
			toJSON: () => ({}),
		}) as DOMRect;
});

test("右键树底部文件：菜单 top 被钳到视口内（不再原样钉在 clientY）", async () => {
	render(<ExplorerPanel workspaceDir="H:/fake" onOpenFile={() => {}} />);
	// 树渲染完成
	await screen.findByText("b.txt");

	// 右键视口底部（y=380，视口高 400）的文件
	fireEvent.contextMenu(screen.getByText("b.txt"), {
		clientX: 350,
		clientY: 380,
	});

	const menu = document.querySelector<HTMLElement>(".ep-ctx-menu");
	expect(menu).toBeTruthy();
	// 修复前：style.top 原样 = "380px"，菜单 130px 高 → 底边 510 > 视口 400，底部项不可点
	// 修复后：useClampMenu 实测尺寸并钳制 → top = 262px
	expect(menu!.style.top).toBe("262px");
	expect(menu!.style.left).toBe("350px");
});
