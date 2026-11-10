// 知识库设置分区注册：nav 入口 + KnowledgePage 壳。
// 注：仓库无 vitest/jest-dom，沿用 bun:test + @testing-library/react 约定
// （照抄 ExtensionSection.test.tsx，断言 toBeTruthy 而非 toBeInTheDocument）。
// mock api-client：默认分区的 GeneralSection mount 时会 GET 多个设置端点。
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import { SettingsModal } from "../../SettingsModal";
import { KnowledgeSection } from "../KnowledgeSection";
import { useSettingsStore } from "../../../store/settings";
import { _setFsTransport } from "../../../fs-client";

mock.module("../../../api-client", () => ({
	api: {
		// KnowledgePage（B2 起）mount 即拉清单：返回合理结构而非空对象，
		// 避免与 store 的取数逻辑隐式耦合
		get: mock(async () => ({ type: "knowledge:list", kbs: [] })),
		post: mock(async () => ({})),
		put: mock(async () => ({})),
		del: mock(async () => ({})),
	},
}));

// B2 起 KnowledgePage mount 即拉清单（异步 setState）：flush 一次避免 act 警告
const flushLoad = () => act(async () => {});

// 「浏览」回退目录树（浏览器环境）会走 fs transport 拉目录树：注入伪传输避免真实网络
function mockFsTransport() {
	_setFsTransport({
		get: async (path: string) => {
			if (path === "/api/fs/home") return { home: "/Users/co" };
			if (path === "/api/fs/roots") return { roots: ["/"] };
			return {};
		},
		post: async (path: string) => {
			if (path === "/api/fs/list-dir")
				return { entries: [{ name: "资料", isDir: true }] };
			return {};
		},
		del: async () => ({}),
	});
}

describe("知识库设置分区", () => {
	beforeEach(() => {
		cleanup();
		useSettingsStore.setState({ showSettings: false, activeSection: "general" });
	});

	afterEach(() => {
		_setFsTransport(null);
	});

	test("弹窗内点「浏览」：目录选择器挂到 body 顶层，不被设置弹窗遮挡", async () => {
		mockFsTransport();
		render(<SettingsModal onClose={() => {}} />);
		fireEvent.click(screen.getByTestId("settings-nav-knowledge"));
		await flushLoad();
		fireEvent.click(screen.getByTestId("kb-add-button"));
		await waitFor(() => expect(screen.getByTestId("kb-browse")).toBeTruthy());
		fireEvent.click(screen.getByTestId("kb-browse"));
		const picker = await screen.findByTestId("dir-picker");
		// 覆盖层不能留在任何弹窗遮罩的层叠上下文内（否则被后挂载的弹窗压住、无法操作）
		expect(picker.closest('[data-testid="modal-overlay"]')).toBeNull();
		expect(picker.parentElement).toBe(document.body);
		await flushLoad();
	});

	test("设置分区含知识库入口且点击后渲染 KnowledgePage", async () => {
		render(<SettingsModal onClose={() => {}} />);
		// 点击前默认 general 分区，无知识库页面标题（nav 按钮文案不算页面标题）
		expect(screen.queryByRole("heading", { name: /知识库/ })).toBeNull();
		fireEvent.click(screen.getByTestId("settings-nav-knowledge"));
		expect(screen.getByRole("heading", { name: /知识库/ })).toBeTruthy();
		await flushLoad();
	});

	test("KnowledgeSection 壳直接渲染知识库页面", async () => {
		render(<KnowledgeSection />);
		// B2 起页面含「+ 新建知识库」按钮，/知识库/ 不再唯一 → 断言页头 heading
		expect(screen.getByRole("heading", { name: /知识库/ })).toBeTruthy();
		await flushLoad();
	});
});
