// WebSearchPanel（设置 → 联网 → 互联网搜索）组件测试：
// 1. mount 回填 GET /api/settings/websearch（开关状态 + hasApiKey 决定掩码/输入态）
// 2. 开关 + key 输入保存 → PUT body 断言（webSearch.searchEnabled/fetchEnabled/apiKey）
// 3. 已保存 key 时掩码展示，未点「修改」时保存传空 apiKey（服务端保留语义）
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

beforeEach(() => {
	getMock.mockReset();
	putMock.mockReset();
	getMock.mockImplementation(async () => ({
		webSearch: { searchEnabled: true, fetchEnabled: true, hasApiKey: false },
	}));
	putMock.mockImplementation(async () => ({
		webSearch: { searchEnabled: true, fetchEnabled: true, hasApiKey: true },
	}));
	useToastStore.setState({ items: [] } as any);
});

test("mount 回填：服务端开关关闭时 checkbox 不勾选；未配 key 显示输入框", async () => {
	getMock.mockImplementation(async () => ({
		webSearch: { searchEnabled: false, fetchEnabled: true, hasApiKey: false },
	}));
	render(<WebSearchPanel />);
	await screen.findByTestId("websearch-panel");
	const search = screen.getByTestId("websearch-toggle-search") as HTMLInputElement;
	const fetchT = screen.getByTestId("websearch-toggle-fetch") as HTMLInputElement;
	await waitFor(() => expect(search.checked).toBe(false));
	expect(fetchT.checked).toBe(true);
	// 无已存 key → 输入框（非掩码）
	expect(screen.getByTestId("websearch-key-input")).toBeTruthy();
	expect(screen.queryByTestId("websearch-key-mask")).toBeNull();
});

test("关掉抓取 + 输入 key 保存 → PUT body 携带 searchEnabled/fetchEnabled/apiKey", async () => {
	render(<WebSearchPanel />);
	await screen.findByTestId("websearch-panel");
	await waitFor(() => expect(screen.getByTestId("websearch-key-input")).toBeTruthy());
	fireEvent.click(screen.getByTestId("websearch-toggle-fetch"));
	fireEvent.change(screen.getByTestId("websearch-key-input"), {
		target: { value: "sk-new-key" },
	});
	fireEvent.click(screen.getByTestId("websearch-save"));
	await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
	const [path, body] = putMock.mock.calls[0];
	expect(path).toBe("/api/settings/websearch");
	expect(body.webSearch).toEqual({
		searchEnabled: true,
		fetchEnabled: false,
		apiKey: "sk-new-key",
	});
});

test("已保存 key：掩码展示；不改 key 直接保存 → PUT apiKey 为空串（服务端保留）", async () => {
	getMock.mockImplementation(async () => ({
		webSearch: { searchEnabled: true, fetchEnabled: true, hasApiKey: true },
	}));
	render(<WebSearchPanel />);
	await screen.findByTestId("websearch-key-mask");
	// 掩码态无输入框
	expect(screen.queryByTestId("websearch-key-input")).toBeNull();
	// 点「修改」进入输入态
	fireEvent.click(screen.getByTestId("websearch-key-modify"));
	expect(screen.getByTestId("websearch-key-input")).toBeTruthy();
	// 不输入新值直接保存 → apiKey 空串（服务端保留旧 key）
	fireEvent.click(screen.getByTestId("websearch-save"));
	await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
	const [, body] = putMock.mock.calls[0];
	expect(body.webSearch.apiKey).toBe("");
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
	expect(body.webSearch.searchEnabled).toBe(true);
});
