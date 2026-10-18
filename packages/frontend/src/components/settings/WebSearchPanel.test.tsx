// WebSearchPanel（设置 → 联网 → 互联网搜索）组件测试：
// 1. mount 回填 GET /api/settings/websearch（供应商 + 开关 + 双 key 掩码态）
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
		provider: "deepseek",
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
	const bigmodelRadio = screen.getByTestId(
		"websearch-provider-bigmodel",
	) as HTMLInputElement;
	await waitFor(() => expect(search.checked).toBe(false));
	expect(fetchT.checked).toBe(true);
	expect(bigmodelRadio.checked).toBe(true);
	// 智谱 key 已保存 → 掩码；供应商为 bigmodel → DeepSeek key 区块不渲染
	expect(screen.getByTestId("websearch-key-bigmodel-mask")).toBeTruthy();
	expect(screen.queryByTestId("websearch-key-deepseek-input")).toBeNull();
});

test("切供应商 + 填双 key 保存 → PUT body 携带全部字段", async () => {
	render(<WebSearchPanel />);
	await screen.findByTestId("websearch-panel");
	await waitFor(() =>
		expect(screen.getByTestId("websearch-key-deepseek-input")).toBeTruthy(),
	);
	// 默认 deepseek：填 DeepSeek key
	fireEvent.change(screen.getByTestId("websearch-key-deepseek-input"), {
		target: { value: "sk-new" },
	});
	// 切到 bigmodel：DeepSeek 输入区卸载、智谱输入区出现，填智谱 key
	fireEvent.click(screen.getByTestId("websearch-provider-bigmodel"));
	expect(screen.queryByTestId("websearch-key-deepseek-input")).toBeNull();
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
	expect(body.webSearch.provider).toBe("deepseek");
	expect(body.webSearch.searchEnabled).toBe(true);
});
