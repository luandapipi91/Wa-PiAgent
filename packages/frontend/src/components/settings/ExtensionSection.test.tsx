// ExtensionSection 插件卡片测试：升级 changelog 展示（pi 1.5.0 配套功能）
// 事件链：kernel upgrade 完成 → broadcast extension:upgrade:done → store.changelogs → 卡片渲染
import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen } from "@testing-library/react";
import { ExtensionSection } from "./ExtensionSection";
import { useExtensionsStore } from "../../store/extensions";

mock.module("../../api-client", () => ({
	api: {
		get: async () => ({ packages: [] }),
		post: () => Promise.resolve({}),
	},
}));

beforeEach(() => {
	useExtensionsStore.setState({
		packages: [
			{ name: "demo-ext", source: "npm", version: "1.1.0", enabled: true },
		],
		installs: {},
		upgrading: {},
		uninstalling: {},
		repairing: null,
		error: null,
		changelogs: {},
	});
});

test("升级后插件卡片展示「本次更新内容」区块（含条目文本）", () => {
	useExtensionsStore.setState({
		changelogs: { "demo-ext": "## 1.1.0\n- 新功能列表" },
	});
	render(<ExtensionSection />);
	const block = screen.getByTestId("ext-changelog-demo-ext");
	expect(block).toBeTruthy();
	expect(block.textContent).toContain("新功能列表");
	expect(screen.getByText("本次更新内容")).toBeTruthy();
});

test("无 changelog 的插件不渲染更新内容块", () => {
	render(<ExtensionSection />);
	expect(screen.queryByTestId("ext-changelog-demo-ext")).toBeNull();
});
