// GeneralSection 设置面板测试：
// 1. 图片导出选项 tab（仅导出 agent 回复 / 对话双方）渲染与选中态，默认=仅 agent 回复
// 2. 通用设置项顺序（自动重试 → 提示音 → 回收站 → 对话导出 → 语言 → 开机自启）
// 3. 图片导出选项草稿态：点保存后才写入 store
// 4. 分组标题「对话导出」+ 分组间横线分隔
import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { GeneralSection } from "./GeneralSection";
import { useUiPrefsStore } from "../../store/ui-prefs";

const getMock = mock();
const putMock = mock();
mock.module("../../api-client", () => ({
	api: {
		get: getMock,
		post: () => Promise.resolve({}),
		put: putMock,
		del: () => Promise.resolve({}),
	},
}));

beforeEach(() => {
	getMock.mockReset();
	putMock.mockReset();
	getMock.mockImplementation(async () => ({ retry: {}, trash: {} }));
	putMock.mockImplementation(async () => ({}));
	useUiPrefsStore.setState({
		exportTurns: 1,
		exportIncludeUser: false,
	});
});

test("渲染图片导出选项 tab：默认选中「仅导出 agent 回复」（exportIncludeUser=false）", async () => {
	render(<GeneralSection />);
	const agentOnly = await screen.findByTestId("export-include-user-agent-only");
	const both = screen.getByTestId("export-include-user-both");
	expect(agentOnly).toBeTruthy();
	expect(both).toBeTruthy();
	expect(agentOnly.getAttribute("data-active")).toBe("true");
	expect(both.getAttribute("data-active")).toBe("false");
});

test("点击「对话双方」切换选中态，保存后写入 store", async () => {
	render(<GeneralSection />);
	const agentOnly = await screen.findByTestId("export-include-user-agent-only");
	const both = screen.getByTestId("export-include-user-both");
	expect(both.getAttribute("data-active")).toBe("false");

	fireEvent.click(both);
	expect(both.getAttribute("data-active")).toBe("true");
	expect(agentOnly.getAttribute("data-active")).toBe("false");
	// 草稿态：未保存时 store 不变
	expect(useUiPrefsStore.getState().exportIncludeUser).toBe(false);

	fireEvent.click(screen.getByTestId("retry-save-btn"));
	await new Promise((r) => setTimeout(r, 10));
	expect(useUiPrefsStore.getState().exportIncludeUser).toBe(true);
});

test("分组标题「对话导出」存在，且导出轮数/图片导出选项都在其分组内", async () => {
	render(<GeneralSection />);
	const sectionTitle = await screen.findByText("对话导出");
	expect(sectionTitle).toBeTruthy();
	const slider = screen.getByTestId("export-turns-slider");
	const agentOnly = screen.getByTestId("export-include-user-agent-only");
	// 标题在前，两个子项在后
	expect(
		sectionTitle.compareDocumentPosition(slider) &
			Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
	expect(
		sectionTitle.compareDocumentPosition(agentOnly) &
			Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
});

test("分组间横线分隔：自动重试/提示音/回收站/对话导出/语言 各组间均有 border-t 分隔容器", async () => {
	// mock 开机自启 IPC，确保 autoLaunch 行渲染
	(window as any).waPiApp = { setLoginItem: () => {} };
	render(<GeneralSection />);
	await screen.findByTestId("retry-max-input");

	// 五组之间应有分隔线：每组相邻 testid 之间至少存在一个带 border-t 的分隔容器
	// （testid 元素嵌套层级不同，不能用 nextElementSibling 遍历，改用 compareDocumentPosition
	//   判定分隔容器在 groups[i] 之后、groups[i+1] 之前）
	const groups = [
		screen.getByTestId("retry-max-input"),
		screen.getByTestId("sound-task-done-toggle"),
		screen.getByTestId("trash-auto-archive-toggle"),
		screen.getByTestId("export-turns-slider"),
		screen.getByTestId("language-select"),
	];
	const separators = Array.from(document.querySelectorAll(".border-t"));
	expect(separators.length).toBeGreaterThanOrEqual(4);
	const inRange = (el: Element, a: Element, b: Element) =>
		a.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING &&
		el.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;
	for (let i = 0; i < groups.length - 1; i++) {
		const found = separators.some((sep) =>
			inRange(sep, groups[i], groups[i + 1]),
		);
		expect(found).toBe(true);
	}
});

test("设置项顺序：自动重试 → 提示音 → 回收站 → 导出轮数 → 图片导出 → 语言 → 开机自启", async () => {
	// mock 开机自启 IPC，确保 autoLaunch 行渲染
	(window as any).waPiApp = { setLoginItem: () => {} };
	render(<GeneralSection />);
	await screen.findByTestId("retry-max-input");

	const order = [
		screen.getByTestId("retry-max-input"),
		screen.getByTestId("sound-task-done-toggle"),
		screen.getByTestId("trash-auto-archive-toggle"),
		screen.getByTestId("export-turns-slider"),
		screen.getByTestId("export-include-user-agent-only"),
		screen.getByTestId("language-select"),
		screen.getByTestId("auto-launch-toggle"),
	];
	for (let i = 0; i < order.length - 1; i++) {
		const a = order[i];
		const b = order[i + 1];
		expect(
			a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	}
});

test("系统代理开关渲染，默认关闭", async () => {
	render(<GeneralSection />);
	await screen.findByTestId("retry-max-input");
	const toggle = screen.getByTestId("use-system-proxy-toggle");
	expect(toggle.getAttribute("data-on")).toBe("false");
});

test("开启系统代理并保存 → PUT /api/settings/proxy（httpProxy 由 kernel 兜底）", async () => {
	render(<GeneralSection />);
	await screen.findByTestId("retry-max-input");
	fireEvent.click(screen.getByTestId("use-system-proxy-toggle"));
	fireEvent.click(screen.getByTestId("retry-save-btn"));
	await new Promise((r) => setTimeout(r, 10));
	expect(putMock).toHaveBeenCalledWith("/api/settings/proxy", {
		proxy: { useSystemProxy: true, httpProxy: "" },
	});
});
