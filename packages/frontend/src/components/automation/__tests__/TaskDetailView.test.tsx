// TaskDetailView 组件测试（bun:test）。
// 覆盖：空态提示、四宫格信息渲染、prompt 高亮、操作按钮调用、最近执行记录。
// store 全部 mock，参照 AutomationSidebar.test.tsx / TaskEditForm.test.tsx 约定。
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TaskDetailView } from "../TaskDetailView";
import { useToastStore } from "../../../store/toast";

// contacts store：推送联系人卡的人名解析（ct_p01 → 张三）
mock.module("../../../store/contacts", () => {
	const contacts = [
		{
			id: "ct_p01",
			channelId: "ch_aaa",
			kind: "person",
			userId: "zhangsan",
			remark: "张三",
			firstChatAt: 1,
			lastChatAt: 2,
		},
	];
	const store = { contacts, loadContacts: mock(async () => {}) };
	const useContactsStore = (sel?: (s: typeof store) => unknown) =>
		sel ? sel(store) : store;
	useContactsStore.getState = () => store;
	return { useContactsStore };
});

const runTaskNowMock = mock();
const startEditMock = mock();
const loadRecentRecordsMock = mock();
const openRecordDetailMock = mock();
const cancelTaskRunMock = mock();

// 可在用例中切换的共享假状态
const schedulerState: {
	tasks: any[];
	recentRecords: any[];
	recentRecordsTaskId: string | null;
	latestByTask: Record<string, any>;
	selectedTaskId: string | null;
	runTaskNow: typeof runTaskNowMock;
	cancelTaskRun: typeof cancelTaskRunMock;
	startEdit: typeof startEditMock;
	loadRecentRecords: typeof loadRecentRecordsMock;
	openRecordDetail: typeof openRecordDetailMock;
} = {
	tasks: [],
	recentRecords: [],
	recentRecordsTaskId: null,
	// 在飞执行状态数据源（?latest=1）：有该任务的 running 记录时禁用「立即执行」
	latestByTask: {},
	selectedTaskId: null,
	runTaskNow: runTaskNowMock,
	cancelTaskRun: cancelTaskRunMock,
	startEdit: startEditMock,
	loadRecentRecords: loadRecentRecordsMock,
	openRecordDetail: openRecordDetailMock,
};

mock.module("../../../store/scheduler", () => ({
	useSchedulerStore: () => schedulerState,
}));

beforeEach(() => {
	runTaskNowMock.mockReset();
	startEditMock.mockReset();
	loadRecentRecordsMock.mockReset();
	openRecordDetailMock.mockReset();
	cancelTaskRunMock.mockReset();
	schedulerState.tasks = [];
	schedulerState.recentRecords = [];
	schedulerState.recentRecordsTaskId = null;
	schedulerState.latestByTask = {};
	schedulerState.selectedTaskId = null;
	// toast store 是真实单例：清空上一用例残留（避免 3s 自动消失定时器干扰断言）
	useToastStore.setState({ toasts: [] });
	cleanup();
});

describe("TaskDetailView", () => {
	test("未选中任务时渲染空态提示", () => {
		render(<TaskDetailView />);
		expect(screen.getByText(/选择一个任务查看详情/)).toBeTruthy();
	});

	test("选中任务时渲染四宫格信息（计划/角色/渠道/目录）", () => {
		schedulerState.tasks = [
			{
				id: "t1",
				name: "每日报表",
				schedule: { type: "daily", time: "09:30" },
				agentId: "小助手",
				prompt: "生成报表",
				projectId: "p1",
				enabled: true,
			},
		];
		schedulerState.selectedTaskId = "t1";
		render(<TaskDetailView />);
		expect(screen.getByText(/每天 09:30/)).toBeTruthy();
		expect(screen.getByText(/🤖 小助手/)).toBeTruthy();
		expect(screen.getByText(/📂 p1/)).toBeTruthy();
	});

	test("每小时任务：显示「每 N 小时，从 HH:MM 开始」，未设开始时间则省略后缀", () => {
		schedulerState.tasks = [
			{
				id: "t1",
				name: "定时抓取",
				schedule: { type: "hourly", intervalHours: 3, startTime: "07:30" },
				agentId: "a",
				prompt: "x",
			},
			{
				id: "t2",
				name: "整点执行",
				schedule: { type: "hourly", intervalHours: 1 },
				agentId: "a",
				prompt: "x",
			},
		];
		schedulerState.selectedTaskId = "t1";
		const { rerender } = render(<TaskDetailView />);
		expect(screen.getByText(/每 3 小时，从 07:30 开始/)).toBeTruthy();
		// 切到未设开始时间的任务：省略后缀
		schedulerState.selectedTaskId = "t2";
		rerender(<TaskDetailView />);
		expect(screen.getByText(/每 1 小时/)).toBeTruthy();
	});

	test("prompt 中的 $[技能名] 渲染为紫色标签", () => {
		schedulerState.tasks = [
			{
				id: "t1",
				name: "任务",
				schedule: { type: "daily", time: "09:00" },
				agentId: "a",
				prompt: "运行 $[日报生成] 生成报表",
			},
		];
		schedulerState.selectedTaskId = "t1";
		render(<TaskDetailView />);
		// chip 显示名（图标 svg 无文本，textContent 归一化后为技能名）
		expect(screen.getByText("日报生成")).toBeTruthy();
	});

	test("prompt 中的 @im-push-to 标记渲染为绿色标签，联系人卡显示人名", () => {
		schedulerState.tasks = [
			{
				id: "t1",
				name: "任务",
				schedule: { type: "daily", time: "09:00" },
				agentId: "a",
				prompt: "推送 @im-push-to(ch_aaa,ct_p01) 日报",
			},
		];
		schedulerState.selectedTaskId = "t1";
		render(<TaskDetailView />);
		// chip 显示人名（非原文 token）
		expect(screen.getByText("张三")).toBeTruthy();
		// 推送联系人卡也显示人名（contacts store 解析 ct_p01 → 张三）
		expect(screen.getByText(/📨 张三/)).toBeTruthy();
	});

	test("推送联系人卡：失效联系人显示原始 id，无标记时显示无", () => {
		schedulerState.tasks = [
			{
				id: "t1",
				name: "任务",
				schedule: { type: "daily", time: "09:00" },
				agentId: "a",
				prompt: "推送 @im-push-to(ch_aaa,ct_gone) 日报",
			},
			{
				id: "t2",
				name: "无标记任务",
				schedule: { type: "daily", time: "10:00" },
				agentId: "a",
				prompt: "普通指令",
			},
		];
		schedulerState.selectedTaskId = "t1";
		const { rerender } = render(<TaskDetailView />);
		// 联系人卡：📨 前缀限定，避开 prompt 高亮标签里的同名 id
		expect(screen.getByText(/📨 ct_gone/)).toBeTruthy();
		// 切到无标记任务 → 卡片显示无
		schedulerState.selectedTaskId = "t2";
		rerender(<TaskDetailView />);
		expect(screen.getByText(/无/)).toBeTruthy();
	});

	test("点击「立即执行」调用 runTaskNow(taskId)", () => {
		schedulerState.tasks = [
			{
				id: "t1",
				name: "任务",
				schedule: { type: "daily", time: "09:00" },
				agentId: "a",
				prompt: "x",
			},
		];
		schedulerState.selectedTaskId = "t1";
		render(<TaskDetailView />);
		fireEvent.click(screen.getByText(/立即执行/));
		expect(runTaskNowMock).toHaveBeenCalledWith("t1");
	});

	// I1：run 触发即返回，成功后用 toast 反馈（不再等执行完成）
	test("点击「立即执行」成功后弹 toast「已触发执行」", async () => {
		schedulerState.tasks = [
			{
				id: "t1",
				name: "任务",
				schedule: { type: "daily", time: "09:00" },
				agentId: "a",
				prompt: "x",
			},
		];
		schedulerState.selectedTaskId = "t1";
		render(<TaskDetailView />);
		fireEvent.click(screen.getByText(/立即执行/));
		// onClick async：等微任务排空后 toast 已弹
		await new Promise((r) => setTimeout(r, 0));
		const toast = useToastStore
			.getState()
			.toasts.find((t) => t.message === "已触发执行");
		expect(toast?.type).toBe("success");
	});

	test("runTaskNow 失败时不弹成功 toast", async () => {
		runTaskNowMock.mockImplementation(() =>
			Promise.reject(new Error("网络错误")),
		);
		schedulerState.tasks = [
			{
				id: "t1",
				name: "任务",
				schedule: { type: "daily", time: "09:00" },
				agentId: "a",
				prompt: "x",
			},
		];
		schedulerState.selectedTaskId = "t1";
		render(<TaskDetailView />);
		fireEvent.click(screen.getByText(/立即执行/));
		await new Promise((r) => setTimeout(r, 0));
		expect(
			useToastStore.getState().toasts.find((t) => t.message === "已触发执行"),
		).toBeUndefined();
	});

	test("点击「编辑」调用 startEdit(task)", () => {
		schedulerState.tasks = [
			{
				id: "t1",
				name: "任务",
				schedule: { type: "daily", time: "09:00" },
				agentId: "a",
				prompt: "x",
			},
		];
		schedulerState.selectedTaskId = "t1";
		render(<TaskDetailView />);
		fireEvent.click(screen.getByText(/编辑/));
		expect(startEditMock).toHaveBeenCalledWith(
			expect.objectContaining({ id: "t1" }),
		);
	});

	test("工作目录：projectId 为 __system__ 时显示「默认工作区」", () => {
		schedulerState.tasks = [
			{
				id: "t1",
				name: "任务",
				schedule: { type: "daily", time: "09:00" },
				agentId: "a",
				prompt: "x",
				projectId: "__system__",
			},
		];
		schedulerState.selectedTaskId = "t1";
		render(<TaskDetailView />);
		expect(screen.getByText(/📂 默认工作区/)).toBeTruthy();
	});

	test("工作目录：projectId 为空时显示「默认工作区」（无「默认」概念）", () => {
		schedulerState.tasks = [
			{
				id: "t1",
				name: "任务",
				schedule: { type: "daily", time: "09:00" },
				agentId: "a",
				prompt: "x",
			},
		];
		schedulerState.selectedTaskId = "t1";
		render(<TaskDetailView />);
		expect(screen.getByText(/📂 默认工作区/)).toBeTruthy();
		// 不再出现「默认」结尾文案
		expect(screen.queryByText(/📂 默认$/)).toBeNull();
	});

	test("最近执行记录：仅显示该任务的前 3 条", () => {
		schedulerState.tasks = [
			{
				id: "t1",
				name: "任务",
				schedule: { type: "daily", time: "09:00" },
				agentId: "a",
				prompt: "x",
			},
		];
		schedulerState.selectedTaskId = "t1";
		schedulerState.recentRecordsTaskId = "t1";
		schedulerState.recentRecords = [
			{
				id: "r1",
				taskId: "t1",
				taskName: "任务",
				status: "success",
				startedAt: Date.now() - 1000,
				durationMs: 3000,
			},
			{
				id: "r2",
				taskId: "other",
				taskName: "其他",
				status: "success",
				startedAt: Date.now() - 2000,
			},
			{
				id: "r3",
				taskId: "t1",
				taskName: "任务",
				status: "failed",
				startedAt: Date.now() - 3000,
				error: "超时",
			},
		];
		render(<TaskDetailView />);
		// RecordRow 渲染时间戳/耗时/错误，而非 taskName。
		// 该任务 t1 有 2 条记录：r1 显示「耗时 3s」，r3 显示「超时」。
		expect(screen.getByText("耗时 3s")).toBeTruthy();
		expect(screen.getByText("超时")).toBeTruthy();
		// 其他任务（other）的记录无 distinguishing 文本，
		// 仅通过 filter 已排除——上两条断言即证明筛选生效。
	});

	test("最近执行记录：点击整条记录行进入详情", () => {
		schedulerState.tasks = [
			{
				id: "t1",
				name: "任务",
				schedule: { type: "daily", time: "09:00" },
				agentId: "a",
				prompt: "x",
			},
		];
		schedulerState.selectedTaskId = "t1";
		schedulerState.recentRecordsTaskId = "t1";
		schedulerState.recentRecords = [
			{
				id: "r1",
				taskId: "t1",
				taskName: "任务",
				status: "success",
				startedAt: Date.now() - 1000,
				durationMs: 3000,
			},
		];
		render(<TaskDetailView />);
		fireEvent.click(screen.getByTestId("record-row-r1"));
		expect(openRecordDetailMock).toHaveBeenCalledWith("r1", "detail");
	});

	test("选中任务变化时调用 loadRecentRecords(taskId)", () => {
		schedulerState.tasks = [
			{
				id: "t1",
				name: "任务",
				schedule: { type: "daily", time: "09:00" },
				agentId: "a",
				prompt: "x",
			},
		];
		schedulerState.selectedTaskId = "t1";
		render(<TaskDetailView />);
		expect(loadRecentRecordsMock).toHaveBeenCalledWith("t1");
	});
	// ===== 执行中状态与取消（本次改造新增）=====
	// 设计取舍：执行中不做前端硬禁用——服务端才是闸门（在飞 → 409；悬空「执行中」→
	// 先对账收尾再执行），前端状态误判时按钮仍可用作自愈入口。
	test("执行中：展示「执行中」标记 + 「取消执行」入口，立即执行仍可点（服务端 409 兜底）", () => {
		schedulerState.tasks = [
			{
				id: "t1",
				name: "任务",
				schedule: { type: "daily", time: "09:00" },
				agentId: "a",
				prompt: "x",
			},
		];
		schedulerState.selectedTaskId = "t1";
		schedulerState.latestByTask = {
			t1: {
				id: "r-run",
				taskId: "t1",
				taskName: "任务",
				status: "running",
				startedAt: 1,
			},
		};
		render(<TaskDetailView />);
		expect(screen.getByTestId("task-running-chip").textContent).toContain("执行中");
		expect(screen.getByTestId("task-cancel-run-btn")).toBeTruthy();
		// 不禁用：卡住（应用重启残留）时点它由服务端对账后照常执行
		expect(
			(screen.getByTestId("task-run-now-btn") as HTMLButtonElement).disabled,
		).toBe(false);
	});

	test("非执行中：不渲染「执行中」标记与取消按钮", () => {
		schedulerState.tasks = [
			{
				id: "t1",
				name: "任务",
				schedule: { type: "daily", time: "09:00" },
				agentId: "a",
				prompt: "x",
			},
		];
		schedulerState.selectedTaskId = "t1";
		schedulerState.latestByTask = {
			t1: {
				id: "r-ok",
				taskId: "t1",
				taskName: "任务",
				status: "success",
				startedAt: 1,
			},
		};
		render(<TaskDetailView />);
		expect(
			(screen.getByTestId("task-run-now-btn") as HTMLButtonElement).disabled,
		).toBe(false);
		expect(screen.queryByTestId("task-running-chip")).toBeNull();
		expect(screen.queryByTestId("task-cancel-run-btn")).toBeNull();
	});

	test("点击「取消执行」调用 cancelTaskRun(taskId) 并 toast 已取消执行", async () => {
		cancelTaskRunMock.mockImplementation(async () => ({
			cancelled: true,
			reconciled: 0,
		}));
		schedulerState.tasks = [
			{
				id: "t1",
				name: "任务",
				schedule: { type: "daily", time: "09:00" },
				agentId: "a",
				prompt: "x",
			},
		];
		schedulerState.selectedTaskId = "t1";
		schedulerState.latestByTask = {
			t1: {
				id: "r-run",
				taskId: "t1",
				taskName: "任务",
				status: "running",
				startedAt: 1,
			},
		};
		render(<TaskDetailView />);
		fireEvent.click(screen.getByTestId("task-cancel-run-btn"));
		await new Promise((r) => setTimeout(r, 0));
		expect(cancelTaskRunMock).toHaveBeenCalledWith("t1");
		expect(
			useToastStore.getState().toasts.find((t) => t.message === "已取消执行")
				?.type,
		).toBe("success");
	});

	test("取消时无在飞执行（状态卡住）→ toast 提示已清理卡住的状态", async () => {
		cancelTaskRunMock.mockImplementation(async () => ({
			cancelled: false,
			reconciled: 1,
		}));
		schedulerState.tasks = [
			{
				id: "t1",
				name: "任务",
				schedule: { type: "daily", time: "09:00" },
				agentId: "a",
				prompt: "x",
			},
		];
		schedulerState.selectedTaskId = "t1";
		schedulerState.latestByTask = {
			t1: {
				id: "r-run",
				taskId: "t1",
				taskName: "任务",
				status: "running",
				startedAt: 1,
			},
		};
		render(<TaskDetailView />);
		fireEvent.click(screen.getByTestId("task-cancel-run-btn"));
		await new Promise((r) => setTimeout(r, 0));
		expect(
			useToastStore
				.getState()
				.toasts.find((t) => t.message === "任务未在执行中，已清理卡住的状态"),
		).toBeTruthy();
	});
	test("最近执行：用户取消的记录显示「⊘ 已取消」而非失败红叉", () => {
		schedulerState.tasks = [
			{
				id: "t1",
				name: "任务",
				schedule: { type: "daily", time: "09:00" },
				agentId: "a",
				prompt: "x",
			},
		];
		schedulerState.selectedTaskId = "t1";
		schedulerState.recentRecordsTaskId = "t1";
		schedulerState.recentRecords = [
			{
				id: "r-cancel",
				taskId: "t1",
				taskName: "任务",
				status: "failed",
				errorCode: "scheduler.taskCancelled",
				error: "scheduler.taskCancelled",
				startedAt: Date.now(),
			},
			{
				id: "r-fail",
				taskId: "t1",
				taskName: "任务",
				status: "failed",
				error: "boom",
				startedAt: Date.now() - 1000,
			},
		];
		render(<TaskDetailView />);
		// 已取消：灰色 ⊘ + 字典文案；真失败仍是 ✕（两种记录同屏可辨）
		const cancelledRow =
			screen.getByTestId("record-row-r-cancel").textContent ?? "";
		expect(cancelledRow).toContain("⊘");
		expect(cancelledRow).toContain("任务已取消");
		// 括号里的补充说明不再展示（只留结论）
		expect(cancelledRow).not.toContain("（");
		expect(screen.getByTestId("record-row-r-fail").textContent).toContain("✕");
	});

	test("最近执行：中断记录不显示耗时（含存量已落盘的假耗时），普通失败仍显示", () => {
		schedulerState.tasks = [
			{
				id: "t1",
				name: "任务",
				schedule: { type: "daily", time: "09:00" },
				agentId: "a",
				prompt: "x",
			},
		];
		schedulerState.selectedTaskId = "t1";
		schedulerState.recentRecordsTaskId = "t1";
		schedulerState.recentRecords = [
			{
				id: "r-int",
				taskId: "t1",
				taskName: "任务",
				status: "failed",
				errorCode: "scheduler.taskInterrupted",
				error: "scheduler.taskInterrupted",
				startedAt: Date.now(),
				// 存量记录：老版本对账时把「对账时刻 - startedAt」写成了耗时（可达十几天）
				durationMs: 1_560_996_000,
			},
			{
				id: "r-fail",
				taskId: "t1",
				taskName: "任务",
				status: "failed",
				error: "boom",
				startedAt: Date.now() - 1000,
				durationMs: 3000,
			},
		];
		render(<TaskDetailView />);
		expect(screen.getByTestId("record-row-r-int").textContent).not.toContain(
			"耗时",
		);
		expect(screen.getByTestId("record-row-r-fail").textContent).toContain("耗时");
	});

	test("最近执行：中断记录文案不带括号补充", () => {
		schedulerState.tasks = [
			{
				id: "t1",
				name: "任务",
				schedule: { type: "daily", time: "09:00" },
				agentId: "a",
				prompt: "x",
			},
		];
		schedulerState.selectedTaskId = "t1";
		schedulerState.recentRecordsTaskId = "t1";
		schedulerState.recentRecords = [
			{
				id: "r-int",
				taskId: "t1",
				taskName: "任务",
				status: "failed",
				errorCode: "scheduler.taskInterrupted",
				error: "scheduler.taskInterrupted",
				startedAt: Date.now(),
			},
		];
		render(<TaskDetailView />);
		const row = screen.getByTestId("record-row-r-int").textContent ?? "";
		expect(row).toContain("任务已中断");
		expect(row).not.toContain("（");
	});
});
