// scheduler store 对含 URL 保留字符的 taskId 的编码契约测试（bun:test）。
// 后端 http-router 对 path 段 decodeURIComponent，query 值不编码会误解析 & = + # %，
// 导致含这些字符的 id 被误删/查错。本测试锁定 deleteTask/runTaskNow/loadRecords 均编码。
import { afterEach, expect, mock, test } from "bun:test";

const getMock = mock();
const postMock = mock();
const putMock = mock();
const delMock = mock();

mock.module("../../api-client", () => ({
	api: {
		get: getMock,
		post: postMock,
		put: putMock,
		del: delMock,
	},
}));

import { useSchedulerStore } from "../scheduler";

afterEach(() => {
	getMock.mockReset();
	postMock.mockReset();
	putMock.mockReset();
	delMock.mockReset();
	useSchedulerStore.setState({ records: [], tasks: [], taskErrors: [] });
});

test("deleteTask 对含保留字符的 id 编码 path 段", async () => {
	await useSchedulerStore.getState().deleteTask("a&b=1#c");
	expect(delMock.mock.calls[0]?.[0]).toBe(
		`/api/scheduled-tasks/${encodeURIComponent("a&b=1#c")}`,
	);
});

test("runTaskNow 对含保留字符的 id 编码 path 段", async () => {
	await useSchedulerStore.getState().runTaskNow("a&b=1#c");
	expect(postMock.mock.calls[0]?.[0]).toBe(
		`/api/scheduled-tasks/${encodeURIComponent("a&b=1#c")}/run`,
	);
});

test("loadRecords 对含保留字符的 taskId 编码 query 参数", async () => {
	await useSchedulerStore.getState().loadRecords("a&b=1#c");
	expect(getMock.mock.calls[0]?.[0]).toBe(
		`/api/execution-records?taskId=${encodeURIComponent("a&b=1#c")}`,
	);
});

test("updateTask 复用统一编码助手，保持既有编码行为", async () => {
	await useSchedulerStore.getState().updateTask("a&b=1#c", { name: "x" });
	expect(putMock.mock.calls[0]?.[0]).toBe(
		`/api/scheduled-tasks/${encodeURIComponent("a&b=1#c")}`,
	);
});
