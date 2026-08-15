// ExecutionDetailView 组件测试（bun:test）
// 覆盖：header 元信息渲染、消息拉取并写入 sessionStore 后渲染 MessageList、
// 无 sessionId 空态、返回按钮触发快照回退、API 失败重试。
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { ExecutionDetailView } from "../ExecutionDetailView";

// —— mocks ——
const closeRecordDetailMock = mock();
const setMessagesMock = mock();

const schedulerState: any = {
	view: "record-detail",
	selectedRecordId: "r1",
	recordDetailBackTo: "records",
	closeRecordDetail: closeRecordDetailMock,
	records: [],
};
const apiGetMock = mock();

mock.module("../../../store/scheduler", () => ({
	useSchedulerStore: (sel: any) =>
		typeof sel === "function" ? sel(schedulerState) : schedulerState,
}));
mock.module("../../../store/session", () => ({
	useSessionStore: {
		getState: () => ({ setMessages: setMessagesMock }),
	},
}));
mock.module("../../../api-client", () => ({
	api: { get: apiGetMock },
}));
// MessageList mock：轻量替身，断言收到正确 sessionId
mock.module("../../MessageList", () => ({
	MessageList: ({ sessionId }: { sessionId: string }) => (
		<div data-testid="message-list-mock">{sessionId}</div>
	),
}));

const RECORD_DETAIL_VIEW = "execution-detail-view";

beforeEach(() => {
	closeRecordDetailMock.mockReset();
	setMessagesMock.mockReset();
	apiGetMock.mockReset();
	schedulerState.records = [
		{
			id: "r1", taskId: "t1", taskName: "日报推送", status: "success",
			startedAt: 1750000000000, durationMs: 34000,
			sessionId: "sess-1", summary: "日报已生成",
		},
	];
	cleanup();
});

describe("ExecutionDetailView", () => {
	test("header 渲染任务名/状态/耗时；有 sessionId 时拉取消息并渲染 MessageList", async () => {
		apiGetMock.mockResolvedValueOnce({
			messages: [{ message: { role: "user", content: "指令" } }],
		});
		render(<ExecutionDetailView />);
		expect(screen.getByTestId(RECORD_DETAIL_VIEW)).toBeTruthy();
		expect(screen.getByText(/日报推送/)).toBeTruthy();
		expect(screen.getByText(/34s/)).toBeTruthy();
		await waitFor(() => {
			expect(apiGetMock).toHaveBeenCalledWith("/api/sessions/sess-1/messages");
		});
		await waitFor(() => {
			expect(setMessagesMock).toHaveBeenCalledWith("sess-1", [
				{ message: { role: "user", content: "指令" } },
			]);
		});
		await waitFor(() => {
			expect(screen.getByTestId("message-list-mock").textContent).toBe("sess-1");
		});
	});

	test("返回按钮触发 closeRecordDetail", () => {
		apiGetMock.mockResolvedValueOnce({ messages: [] });
		render(<ExecutionDetailView />);
		fireEvent.click(screen.getByTestId("execution-detail-back"));
		expect(closeRecordDetailMock).toHaveBeenCalledTimes(1);
	});

	test("无 sessionId（旧记录/会话创建前失败）：不拉接口，显示空态与错误摘要", async () => {
		schedulerState.records = [
			{
				id: "r1", taskId: "t1", taskName: "失败任务", status: "failed",
				startedAt: 1750000000000, error: "无可用的模型供应商",
			},
		];
		render(<ExecutionDetailView />);
		expect(screen.getByText(/该记录无执行过程/)).toBeTruthy();
		await new Promise((r) => setTimeout(r, 20));
		expect(apiGetMock).not.toHaveBeenCalled();
		expect(screen.getByText(/无可用的模型供应商/)).toBeTruthy();
	});

	test("API 失败：显示错误与重试按钮，重试成功后恢复", async () => {
		apiGetMock.mockRejectedValueOnce(new Error("network down"));
		render(<ExecutionDetailView />);
		await new Promise((r) => setTimeout(r, 0));
		expect(screen.getByText(/加载失败/)).toBeTruthy();
		apiGetMock.mockResolvedValueOnce({ messages: [] });
		fireEvent.click(screen.getByTestId("execution-detail-retry"));
		await new Promise((r) => setTimeout(r, 0));
		expect(apiGetMock).toHaveBeenCalledTimes(2);
		expect(screen.queryByText(/加载失败/)).toBeNull();
	});
});
