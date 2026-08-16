import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// 列表「测试连接」走 ProviderSection.handleTest → store.test；
// 必须把 provider.slug 传给后端，否则 kernel 按 model id 匹配会污染 baseUrl（同名模型跨 provider）。
const testProvider = mock(async () => ({ ok: true }));
const remove = mock(() => {});

const provider = {
	id: "p1",
	name: "OpenCode Zen Go",
	slug: "opencode-go",
	baseUrl: "https://opencode.ai/zen/go",
	apiKey: "sk-test",
	api: "openai-completions",
	models: [{ id: "deepseek-v4-flash", contextWindow: 1000000, maxTokens: 384000 }],
};

const state = {
	providers: [provider],
	remove,
	test: testProvider,
};

const useProvidersStore = (selector?: (s: typeof state) => unknown) =>
	selector ? selector(state) : state;

mock.module("../../store/providers", () => ({ useProvidersStore }));

const { ProviderSection } = await import("./ProviderSection");

beforeEach(() => {
	testProvider.mockClear();
	remove.mockClear();
});
afterEach(() => cleanup());

test("列表测试连接：把 provider.slug 传给后端（对齐内置目录 baseUrl 解析）", async () => {
	render(<ProviderSection />);
	fireEvent.click(screen.getByText("测试连接"));
	await act(async () => {});
	expect(testProvider).toHaveBeenCalledWith({
		baseUrl: "https://opencode.ai/zen/go",
		apiKey: "sk-test",
		api: "openai-completions",
		models: [
			{ id: "deepseek-v4-flash", contextWindow: 1000000, maxTokens: 384000 },
		],
		slug: "opencode-go",
	});
});
