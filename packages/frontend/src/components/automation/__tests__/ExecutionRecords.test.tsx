// ExecutionRecords 组件测试（bun:test）。
// 覆盖：空态、记录渲染、时间筛选（按天/周/月）、任务筛选、状态筛选。
// store 全部 mock，参照 AutomationSidebar.test.tsx 约定。
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ExecutionRecords } from "../ExecutionRecords";

const loadRecordsMock = mock();

const schedulerState: {
	tasks: any[];
	records: any[];
	loadRecords: typeof loadRecordsMock;
} = {
	tasks: [],
	records: [],
	loadRecords: loadRecordsMock,
};

mock.module("../../../store/scheduler", () => ({
	useSchedulerStore: () => schedulerState,
}));

beforeEach(() => {
	loadRecordsMock.mockReset();
	schedulerState.tasks = [];
	schedulerState.records = [];
	cleanup();
});

describe("ExecutionRecords", () => {
	test("无记录时渲染空态", () => {
		render(<ExecutionRecords />);
		expect(screen.getByText("暂无执行记录")).toBeTruthy();
	});

	test("中断/取消记录：不显示假耗时，且已取消显示 ⊘ 灰色而非失败红叉", () => {
		schedulerState.tasks = [{ id: "t1", name: "每日报表" }];
		schedulerState.records = [
			{
				id: "r-int",
				taskId: "t1",
				taskName: "每日报表",
				status: "failed",
				errorCode: "scheduler.taskInterrupted",
				error: "scheduler.taskInterrupted",
				startedAt: Date.now() - 1000,
				// 存量记录里的假耗时（老版本对账写入）
				durationMs: 1_560_996_000,
			},
			{
				id: "r-cancel",
				taskId: "t1",
				taskName: "每日报表",
				status: "failed",
				errorCode: "scheduler.taskCancelled",
				error: "scheduler.taskCancelled",
				startedAt: Date.now() - 2000,
			},
		];
		render(<ExecutionRecords />);
		const intRow =
			screen.getByTestId("execution-record-row-r-int").textContent ?? "";
		expect(intRow).not.toContain("耗时");
		expect(intRow).toContain("任务已中断");
		// 用户主动取消：灰色 ⊘（不是失败 ✕）
		const cancelRow =
			screen.getByTestId("execution-record-row-r-cancel").textContent ?? "";
		expect(cancelRow).toContain("⊘");
		expect(cancelRow).toContain("任务已取消");
	});

	test("渲染记录列表（taskName + 状态图标）", () => {
		schedulerState.tasks = [{ id: "t1", name: "每日报表" }];
		schedulerState.records = [
			{
				id: "r1",
				taskId: "t1",
				taskName: "每日报表",
				status: "success",
				startedAt: Date.now() - 1000,
				durationMs: 5000,
			},
			{
				id: "r2",
				taskId: "t1",
				taskName: "每日报表",
				status: "failed",
				startedAt: Date.now() - 2000,
				error: "网络错误",
			},
		];
		render(<ExecutionRecords />);
		// 下拉框 option 也含「每日报表」，故用记录卡片独有内容断言：
		// r1 success 显示「耗时 5s」，r2 failed 显示「网络错误」。
		expect(screen.getByText("耗时 5s")).toBeTruthy();
		expect(screen.getByText("网络错误")).toBeTruthy();
	});

	test("按天筛选：仅显示 24 小时内的记录", () => {
		schedulerState.records = [
			{
				id: "r1",
				taskId: "t1",
				taskName: "新记录",
				status: "success",
				startedAt: Date.now() - 1000, // 1 秒前
			},
			{
				id: "r2",
				taskId: "t1",
				taskName: "旧记录",
				status: "success",
				startedAt: Date.now() - 86400000 * 2, // 2 天前
			},
		];
		render(<ExecutionRecords />);
		expect(screen.getByText("新记录")).toBeTruthy();
		expect(screen.queryByText("旧记录")).toBeNull();
	});

	test("按周筛选：显示 7 天内的记录", () => {
		schedulerState.records = [
			{
				id: "r1",
				taskId: "t1",
				taskName: "三天前",
				status: "success",
				startedAt: Date.now() - 86400000 * 3, // 3 天前
			},
			{
				id: "r2",
				taskId: "t1",
				taskName: "十天前",
				status: "success",
				startedAt: Date.now() - 86400000 * 10, // 10 天前
			},
		];
		render(<ExecutionRecords />);
		// 切到「按周」
		fireEvent.click(screen.getByText("按周"));
		expect(screen.getByText("三天前")).toBeTruthy();
		expect(screen.queryByText("十天前")).toBeNull();
	});

	test("任务筛选下拉框包含全部任务选项", () => {
		schedulerState.tasks = [
			{ id: "t1", name: "每日报表" },
			{ id: "t2", name: "周报" },
		];
		render(<ExecutionRecords />);
		fireEvent.change(screen.getByDisplayValue("全部任务"), {
			target: { value: "t2" },
		});
		// 筛选条件变化后，空态依然显示（无匹配记录）
		expect(screen.getByText("暂无执行记录")).toBeTruthy();
	});

	test("状态筛选下拉框切换到「失败」", () => {
		schedulerState.records = [
			{
				id: "r1",
				taskId: "t1",
				taskName: "成功记录",
				status: "success",
				startedAt: Date.now() - 1000,
			},
			{
				id: "r2",
				taskId: "t1",
				taskName: "失败记录",
				status: "failed",
				startedAt: Date.now() - 2000,
			},
		];
		render(<ExecutionRecords />);
		// 默认两条都显示
		expect(screen.getByText("成功记录")).toBeTruthy();
		expect(screen.getByText("失败记录")).toBeTruthy();
		// 切到「失败」
		fireEvent.change(screen.getByDisplayValue("全部状态"), {
			target: { value: "failed" },
		});
		expect(screen.getByText("失败记录")).toBeTruthy();
		expect(screen.queryByText("成功记录")).toBeNull();
	});

	test("已推送记录显示「已推送」标记", () => {
		schedulerState.records = [
			{
				id: "r1",
				taskId: "t1",
				taskName: "报表",
				status: "success",
				startedAt: Date.now() - 1000,
				pushResults: [{ targetId: "ct_p01", targetName: "张三", success: true }],
			},
		];
		render(<ExecutionRecords />);
		expect(screen.getByText("已推送")).toBeTruthy();
	});

	test("挂载时按时间窗口调用 loadRecords（since = 24h 前，limit 200）", () => {
		const before = Date.now();
		render(<ExecutionRecords />);
		const call = loadRecordsMock.mock.calls[0]?.[0] as {
			since: number;
			limit: number;
		};
		expect(call.limit).toBe(200);
		// since 应约等于 now - 24h（允许毫秒级误差）
		expect(call.since).toBeGreaterThan(before - 86400000 - 5000);
		expect(call.since).toBeLessThanOrEqual(before - 86400000 + 5000);
	});

	test("窗口内打满 200 条时显示「加载更早」，点击向前扩一个窗口重拉", () => {
		const now = Date.now();
		schedulerState.records = Array.from({ length: 200 }, (_, i) => ({
			id: `r${i}`,
			taskId: "t1",
			taskName: "任务",
			status: "success",
			startedAt: now - i * 1000, // 全部落在 24h 窗口内
		}));
		render(<ExecutionRecords />);
		expect(screen.getByTestId("execution-records-load-earlier")).toBeTruthy();
		fireEvent.click(screen.getByTestId("execution-records-load-earlier"));
		// 第二次调用：since 前扩到约 48h 前
		const call = loadRecordsMock.mock.calls[1]?.[0] as {
			since: number;
			limit: number;
		};
		expect(call.since).toBeLessThanOrEqual(now - 2 * 86400000 + 5000);
		expect(call.since).toBeGreaterThan(now - 2 * 86400000 - 5000);
	});

	test("窗口内未打满时不显示「加载更早」", () => {
		schedulerState.records = [
			{ id: "r1", taskId: "t1", taskName: "任务", status: "success", startedAt: Date.now() - 1000 },
		];
		render(<ExecutionRecords />);
		expect(screen.queryByTestId("execution-records-load-earlier")).toBeNull();
	});
});
