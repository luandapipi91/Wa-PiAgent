// ExtensionSection 修复依赖按钮：渲染/确认弹窗/进度态/成功恢复。
// 注：简报原文使用 vitest + jest-dom，但本仓库未安装 vitest，22 个既有组件测试
// 均用 bun:test + @testing-library/react（照抄 AutomationSidebar 约定，断言 toBeTruthy）。
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { ExtensionSection } from "../ExtensionSection";
import { useExtensionsStore } from "../../../store/extensions";
import { useToastStore } from "../../../store/toast";

// mock api-client：修复走 fire-and-forget POST，结果经 SSE 事件回流 store
const postMock = mock(async () => ({}));

mock.module("../../../api-client", () => ({
	api: {
		get: mock(async () => ({ packages: [] })),
		post: postMock,
		put: mock(async () => ({})),
		del: mock(async () => ({})),
	},
}));

const openSettings = () => render(<ExtensionSection />);

describe("ExtensionSection 修复依赖", () => {
	beforeEach(() => {
		cleanup();
		postMock.mock.calls.length = 0;
		useExtensionsStore.setState({
			packages: [],
			installs: {},
			upgrading: {},
			uninstalling: {},
			error: null,
			repairing: null,
		});
		useToastStore.setState({ toasts: [] });
	});

	test("渲染修复依赖按钮", () => {
		openSettings();
		expect(screen.getByTestId("ext-repair-btn")).toBeTruthy();
	});

	test("点击弹确认框，取消不发请求", () => {
		openSettings();
		fireEvent.click(screen.getByTestId("ext-repair-btn"));
		expect(screen.getByText("确认修复依赖")).toBeTruthy();
		fireEvent.click(screen.getByTestId("confirm-cancel"));
		expect(screen.queryByText("确认修复依赖")).toBeNull();
		expect(postMock.mock.calls.length).toBe(0);
	});

	test("确认后 POST /api/extensions/repair 且进入修复态（按钮禁用+进度占位）", () => {
		openSettings();
		fireEvent.click(screen.getByTestId("ext-repair-btn"));
		fireEvent.click(screen.getByTestId("confirm-ok"));
		expect(postMock).toHaveBeenCalledWith("/api/extensions/repair", {});
		// repairing="" → 按钮禁用 + 默认进度文案
		expect((screen.getByTestId("ext-repair-btn") as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByTestId("ext-repair-progress")).toBeTruthy();
	});

	test("SSE 进度行回流后显示最新进度；repair:done 后恢复并可再触发", () => {
		openSettings();
		fireEvent.click(screen.getByTestId("ext-repair-btn"));
		fireEvent.click(screen.getByTestId("confirm-ok"));
		act(() => {
			useExtensionsStore.getState().applyRepairProgress({ type: "extension:repair:progress", message: "bun install 50%" });
		});
		expect(screen.getByText("bun install 50%")).toBeTruthy();
		act(() => {
			useExtensionsStore.getState().completeRepair();
		});
		expect((screen.getByTestId("ext-repair-btn") as HTMLButtonElement).disabled).toBe(false);
		expect(screen.queryByTestId("ext-repair-progress")).toBeNull();
	});

	test("修复失败落全局 error 区", () => {
		openSettings();
		act(() => {
			useExtensionsStore.getState().setError({ type: "extension:error", name: "repair", error: "删除 node_modules 失败" });
		});
		expect(screen.getByText("删除 node_modules 失败")).toBeTruthy();
		// 失败同时必须清 repairing（按钮解禁）
		expect((screen.getByTestId("ext-repair-btn") as HTMLButtonElement).disabled).toBe(false);
	});
});
