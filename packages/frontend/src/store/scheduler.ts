import { create } from "zustand";
import { api } from "../api-client";
import type { ScheduledTask, ExecutionRecord } from "@wa-pi/shared";

type AutoView = "detail" | "edit" | "records" | "record-detail";

interface SchedulerState {
	tasks: ScheduledTask[];
	records: ExecutionRecord[];
	selectedTaskId: string | null;
	view: AutoView;
	editingTask: ScheduledTask | null; // null = 新建
	selectedRecordId: string | null; // record-detail 视图当前查看的执行记录
	recordDetailBackTo: "records" | "detail"; // 打开时快照：返回目标视图

	// Actions
	loadTasks: () => Promise<void>;
	loadRecords: (taskId?: string) => Promise<void>;
	createTask: (data: Partial<ScheduledTask>) => Promise<void>;
	updateTask: (id: string, data: Partial<ScheduledTask>) => Promise<void>;
	deleteTask: (id: string) => Promise<void>;
	runTaskNow: (id: string) => Promise<void>;
	selectTask: (id: string | null) => void;
	setView: (view: AutoView) => void;
	startCreate: () => void;
	startEdit: (task: ScheduledTask) => void;
	openRecordDetail: (recordId: string, from: "records" | "detail") => void;
	closeRecordDetail: () => void;
}

export const useSchedulerStore = create<SchedulerState>((set, get) => ({
	tasks: [],
	records: [],
	selectedTaskId: null,
	view: "detail",
	editingTask: null,
	selectedRecordId: null,
	recordDetailBackTo: "records",

	loadTasks: async () => {
		const res = (await api.get("/api/scheduled-tasks")) as any;
		set({ tasks: res?.tasks ?? [] });
	},

	loadRecords: async (taskId) => {
		const url = taskId
			? `/api/execution-records?taskId=${taskId}`
			: "/api/execution-records";
		const res = (await api.get(url)) as any;
		set({ records: res?.records ?? [] });
	},

	createTask: async (data) => {
		const res = (await api.post("/api/scheduled-tasks", data)) as any;
		// 新建后选中新任务（列表按 createdAt 倒序也会排最前），避免用户误以为没创建成功
		const taskId = res?.task?.id ?? null;
		await get().loadTasks();
		set({ view: "detail", selectedTaskId: taskId });
	},

	updateTask: async (id, data) => {
		await api.put(`/api/scheduled-tasks/${id}`, data);
		await get().loadTasks();
		set({ view: "detail" });
	},

	deleteTask: async (id) => {
		await api.del(`/api/scheduled-tasks/${id}`);
		await get().loadTasks();
		if (get().selectedTaskId === id) {
			set({ selectedTaskId: null, view: "detail" });
		}
	},

	runTaskNow: async (id) => {
		await api.post(`/api/scheduled-tasks/${id}/run`, {});
	},

	// 再点同一张卡片取消选中；点不同卡片切换选中
	selectTask: (id) =>
		set((s) => ({
			selectedTaskId: s.selectedTaskId === id ? null : id,
			view: "detail",
			selectedRecordId: null,
		})),

	setView: (view) => set({ view }),

	startCreate: () =>
		set({
			view: "edit",
			editingTask: null,
			selectedTaskId: null,
			selectedRecordId: null,
		}),

	startEdit: (task) =>
		set({
			view: "edit",
			editingTask: task,
			selectedTaskId: task.id,
			selectedRecordId: null,
		}),

	// 打开执行记录详情：from 快照来源视图，返回时回退
	openRecordDetail: (recordId, from) =>
		set({
			view: "record-detail",
			selectedRecordId: recordId,
			recordDetailBackTo: from,
		}),

	closeRecordDetail: () =>
		set((s) => ({
			view: s.recordDetailBackTo,
			selectedRecordId: null,
		})),
}));
