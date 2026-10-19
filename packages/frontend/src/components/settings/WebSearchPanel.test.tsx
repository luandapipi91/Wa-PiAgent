// WebSearchPanel（设置 → 联网 → 互联网搜索）组件测试：
// 1. mount 回填 GET /api/settings/websearch（供应商 + 开关 + 双 key 掩码态；默认供应商 bing）
// 2. 供应商切换 + 开关 + 双 key 保存 → PUT body 断言
// 3. 已保存 key 时掩码展示，未点「修改」时保存传空（服务端保留语义）
// 4. GET 失败静默（保持默认值，可正常保存）
import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WebSearchPanel } from "./WebSearchPanel";
import { useToastStore } from "../../store/toast";

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

const defaultView = {
	webSearch: {
		provider: "bing",
		searchEnabled: true,
		fetchEnabled: true,
		hasApiKey: false,
		hasApiKeyBigmodel: false,
	},
};

beforeEach(() => {
	getMock.mockReset();
	putMock.mockReset();
	getMock.mockImplementation(async () => defaultView);
	putMock.mockImplementation(async () => ({
		webSearch: {
			provider: "deepseek",
			searchEnabled: true,
			fetchEnabled: true,
			hasApiKey: true,
			hasApiKeyBigmodel: false,
		},
	}));
	useToastStore.setState({ items: [] } as any);
});

test("mount 回填：供应商/开关/key 掩码态按服务端渲染", async () => {
	getMock.mockImplementation(async () => ({
		webSearch: {
			provider: "bigmodel",
			searchEnabled: false,
			fetchEnabled: true,
			hasApiKey: false,
			hasApiKeyBigmodel: true,
		},
	}));
	render(<WebSearchPanel />);
	await screen.findByTestId("websearch-panel");
	const search = screen.getByTestId(
		"websearch-toggle-search",
	) as HTMLInputElement;
	const fetchT = screen.getByTestId(
		"websearch-toggle-fetch",
	) as HTMLInputElement;
	const select = screen.getByTestId(
		"websearch-provider-select",
	) as HTMLSelectElement;
	await waitFor(() => expect(search.checked).toBe(false));
	expect(fetchT.checked).toBe(true);
	expect(select.value).toBe("bigmodel");
	// 智谱 key 已保存 → 掩码；供应商为 bigmodel → DeepSeek key 区块不渲染
	expect(screen.getByTestId("websearch-key-bigmodel-mask")).toBeTruthy();
	expect(screen.queryByTestId("websearch-key-deepseek-input")).toBeNull();
});

test("切供应商 + 填双 key 保存 → PUT body 携带全部字段", async () => {
	render(<WebSearchPanel />);
	await screen.findByTestId("websearch-panel");
	const select = screen.getByTestId(
		"websearch-provider-select",
	) as HTMLSelectElement;
	// 默认 bing：不渲染任何 Key 输入区，展示免费提示
	await waitFor(() => expect(select.value).toBe("bing"));
	expect(screen.queryByTestId("websearch-key-deepseek-input")).toBeNull();
	expect(screen.getByTestId("websearch-bing-hint")).toBeTruthy();
	// 切到 deepseek：填 DeepSeek key（bing 免费提示随之消失）
	fireEvent.change(select, { target: { value: "deepseek" } });
	expect(screen.queryByTestId("websearch-bing-hint")).toBeNull();
	fireEvent.change(screen.getByTestId("websearch-key-deepseek-input"), {
		target: { value: "sk-new" },
	});
	// 切到 bigmodel：DeepSeek 输入区卸载、智谱输入区出现，填智谱 key
	fireEvent.change(select, { target: { value: "bigmodel" } });
	expect(screen.queryByTestId("websearch-key-deepseek-input")).toBeNull();
	expect(screen.queryByTestId("websearch-bing-hint")).toBeNull();
	fireEvent.click(screen.getByTestId("websearch-toggle-fetch"));
	fireEvent.change(screen.getByTestId("websearch-key-bigmodel-input"), {
		target: { value: "zhu-new" },
	});
	fireEvent.click(screen.getByTestId("websearch-save"));
	await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
	const [path, body] = putMock.mock.calls[0];
	expect(path).toBe("/api/settings/websearch");
	// 切供应商不影响已填的 DeepSeek key（state 保留，上传时照常携带）
	expect(body.webSearch).toEqual({
		provider: "bigmodel",
		searchEnabled: true,
		fetchEnabled: false,
		apiKey: "sk-new",
		apiKeyBigmodel: "zhu-new",
	});
});

test("已保存 key：掩码展示；不改 key 直接保存 → PUT 传空串（服务端保留）", async () => {
	getMock.mockImplementation(async () => ({
		webSearch: {
			provider: "deepseek",
			searchEnabled: true,
			fetchEnabled: true,
			hasApiKey: true,
			hasApiKeyBigmodel: false,
		},
	}));
	render(<WebSearchPanel />);
	await screen.findByTestId("websearch-key-deepseek-mask");
	expect(screen.queryByTestId("websearch-key-deepseek-input")).toBeNull();
	// 点「修改」进入输入态
	fireEvent.click(screen.getByTestId("websearch-key-deepseek-modify"));
	expect(screen.getByTestId("websearch-key-deepseek-input")).toBeTruthy();
	// 不输入新值直接保存 → apiKey 空串（服务端保留旧 key）
	fireEvent.click(screen.getByTestId("websearch-save"));
	await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
	const [, body] = putMock.mock.calls[0];
	expect(body.webSearch.apiKey).toBe("");
	expect(body.webSearch.apiKeyBigmodel).toBe("");
});

test("GET 失败静默：面板仍渲染，保存按默认值提交", async () => {
	getMock.mockImplementation(async () => {
		throw new Error("network down");
	});
	render(<WebSearchPanel />);
	await screen.findByTestId("websearch-panel");
	expect(screen.getByTestId("websearch-toggle-search")).toBeTruthy();
	fireEvent.click(screen.getByTestId("websearch-save"));
	await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
	const [, body] = putMock.mock.calls[0];
	expect(body.webSearch.provider).toBe("bing");
	expect(body.webSearch.searchEnabled).toBe(true);
});

test("默认 bing：不渲染任何 Key 输入区，展示免费提示；保存 PUT 携带 bing", async () => {
	render(<WebSearchPanel />);
	await screen.findByTestId("websearch-panel");
	await waitFor(() =>
		expect((screen.getByTestId("websearch-provider-select") as HTMLSelectElement).value).toBe("bing"),
	);
	expect(screen.queryByTestId("websearch-key-deepseek-input")).toBeNull();
	expect(screen.queryByTestId("websearch-key-bigmodel-input")).toBeNull();
	expect(screen.getByTestId("websearch-bing-hint")).toBeTruthy();
	fireEvent.click(screen.getByTestId("websearch-save"));
	await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
	expect(putMock.mock.calls[0][1].webSearch.provider).toBe("bing");
});

test("供应商 select 有可访问名：aria-label = 供应商", async () => {
	render(<WebSearchPanel />);
	const select = await screen.findByTestId("websearch-provider-select");
	expect(select.getAttribute("aria-label")).toBe("供应商");
});

test("描述段落已移除：面板不再渲染联网能力说明文案（2026-10-19 用户裁决）", async () => {
	render(<WebSearchPanel />);
	await screen.findByTestId("websearch-panel");
	expect(screen.queryByText(/联网能力由/)).toBeNull();
	expect(screen.queryByText(/保存后即时生效/)).toBeNull();
});

test("供应商 bing 选项文本不带括号后缀：仅显示 Bing（2026-10-19 用户裁决）", async () => {
	render(<WebSearchPanel />);
	const select = await screen.findByTestId("websearch-provider-select");
	const option = select.querySelector('option[value="bing"]');
	expect(option?.textContent).toBe("Bing");
	expect(screen.queryByText(/免费免/)).toBeNull();
});
