// 知识库设置分区注册：nav 入口 + KnowledgePage 壳。
// 注：仓库无 vitest/jest-dom，沿用 bun:test + @testing-library/react 约定
// （照抄 ExtensionSection.test.tsx，断言 toBeTruthy 而非 toBeInTheDocument）。
// mock api-client：默认分区的 GeneralSection mount 时会 GET 多个设置端点。
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { SettingsModal } from "../../SettingsModal";
import { KnowledgeSection } from "../KnowledgeSection";
import { useSettingsStore } from "../../../store/settings";

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

describe("知识库设置分区", () => {
	beforeEach(() => {
		cleanup();
		useSettingsStore.setState({ showSettings: false, activeSection: "general" });
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
