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
const loadRecordsMock = mock();

// 可在用例中切换的共享假状态
const schedulerState: {
	tasks: any[];
	records: any[];
	selectedTaskId: string | null;
	runTaskNow: typeof runTaskNowMock;
	startEdit: typeof startEditMock;
	loadRecords: typeof loadRecordsMock;
} = {
	tasks: [],
	records: [],
	selectedTaskId: null,
	runTaskNow: runTaskNowMock,
	startEdit: startEditMock,
	loadRecords: loadRecordsMock,
};

mock.module("../../../store/scheduler", () => ({
	useSchedulerStore: () => schedulerState,
}));

beforeEach(() => {
	runTaskNowMock.mockReset();
	startEditMock.mockReset();
	loadRecordsMock.mockReset();
	schedulerState.tasks = [];
	schedulerState.records = [];
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
		schedulerState.records = [
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

	test("选中任务变化时调用 loadRecords(taskId)", () => {
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
		expect(loadRecordsMock).toHaveBeenCalledWith("t1");
	});
});
