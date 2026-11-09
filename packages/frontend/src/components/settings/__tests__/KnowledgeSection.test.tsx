// 知识库设置分区注册：nav 入口 + KnowledgePage 壳。
// 注：仓库无 vitest/jest-dom，沿用 bun:test + @testing-library/react 约定
// （照抄 ExtensionSection.test.tsx，断言 toBeTruthy 而非 toBeInTheDocument）。
// mock api-client：默认分区的 GeneralSection mount 时会 GET 多个设置端点。
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SettingsModal } from "../../SettingsModal";
import { KnowledgeSection } from "../KnowledgeSection";
import { useSettingsStore } from "../../../store/settings";

mock.module("../../../api-client", () => ({
	api: {
		get: mock(async () => ({})),
		post: mock(async () => ({})),
		put: mock(async () => ({})),
		del: mock(async () => ({})),
	},
}));

describe("知识库设置分区", () => {
	beforeEach(() => {
		cleanup();
		useSettingsStore.setState({ showSettings: false, activeSection: "general" });
	});

	test("设置分区含知识库入口且点击后渲染 KnowledgePage", () => {
		render(<SettingsModal onClose={() => {}} />);
		// 点击前默认 general 分区，无知识库页面标题（nav 按钮文案不算页面标题）
		expect(screen.queryByRole("heading", { name: /知识库/ })).toBeNull();
		fireEvent.click(screen.getByTestId("settings-nav-knowledge"));
		expect(screen.getByRole("heading", { name: /知识库/ })).toBeTruthy();
	});

	test("KnowledgeSection 壳直接渲染知识库页面", () => {
		render(<KnowledgeSection />);
		expect(screen.getByText(/知识库/)).toBeTruthy();
	});
});
