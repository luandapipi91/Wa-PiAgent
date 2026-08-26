import { create } from "zustand";
import { api } from "../api-client";
import type {
	ScheduledTask,
	ExecutionRecord,
	TaskFileError,
} from "@wa-pi/shared";

type AutoView = "detail" | "edit" | "records" | "record-detail";

// taskId 来自文件名（可能含中文或 URL 保留字符，如 & = # + %），
// 凡拼进 path 段或 query 值必须先编码，否则会被后端当分隔符解析而误删/查错。
const encodeTaskId = (id: string) => encodeURIComponent(id);

interface SchedulerState {
	tasks: ScheduledTask[];
	// 定时任务文件在解析/校验时发现的配置错误（Task 5 REST 响应 errors 字段）
	taskErrors: TaskFileError[];
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
	// 点击「配置错误」条目：用错误信息构造草稿（id 非空 → 编辑表单走 updateTask 修复坏文件）
	startFixError: (err: TaskFileError) => void;
	openRecordDetail: (recordId: string, from: "records" | "detail") => void;
	closeRecordDetail: () => void;
}

export const useSchedulerStore = create<SchedulerState>((set, get) => ({
	tasks: [],
	taskErrors: [],
	records: [],
	selectedTaskId: null,
	view: "detail",
	editingTask: null,
	selectedRecordId: null,
	recordDetailBackTo: "records",

	loadTasks: async () => {
		const res = (await api.get("/api/scheduled-tasks")) as any;
		set({ tasks: res?.tasks ?? [], taskErrors: res?.errors ?? [] });
	},

	loadRecords: async (taskId) => {
		const url = taskId
			? `/api/execution-records?taskId=${encodeTaskId(taskId)}`
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
		// taskId 来自文件名（可能含中文或保留字符），URL path 段编码后再拼接
		await api.put(`/api/scheduled-tasks/${encodeTaskId(id)}`, data);
		await get().loadTasks();
		set({ view: "detail" });
	},

	deleteTask: async (id) => {
		await api.del(`/api/scheduled-tasks/${encodeTaskId(id)}`);
		await get().loadTasks();
		if (get().selectedTaskId === id) {
			set({ selectedTaskId: null, view: "detail" });
		}
	},

	runTaskNow: async (id) => {
		await api.post(`/api/scheduled-tasks/${encodeTaskId(id)}/run`, {});
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

	// 配置错误条目 → 编辑表单：以错误信息构造草稿（id=taskId 非空，保存走 updateTask PUT upsert 修复）
	startFixError: (err) =>
		set({
			view: "edit",
			editingTask: {
				id: err.taskId,
				projectId: err.projectId,
				name: err.taskId,
				schedule: { type: "daily", time: "09:00" },
				agentId: "",
				prompt: "",
				enabled: true,
				createdAt: 0,
				updatedAt: 0,
			},
			selectedTaskId: err.taskId,
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
