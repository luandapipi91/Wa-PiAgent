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
	/** 执行记录列表（执行记录页数据源；App SSE 刷新兜底对齐） */
	records: ExecutionRecord[];
	/** 任务详情页「最近执行」：仅当前选中任务的少量记录（?taskId=&limit= 尾读，不污染 records） */
	recentRecords: ExecutionRecord[];
	recentRecordsTaskId: string | null; // 防切任务竞态：仅当与选中任务一致时才渲染
	/** 每任务最新一条执行记录（?latest=1 索引聚合；侧栏状态点数据源，免全量读日志） */
	latestByTask: Record<string, ExecutionRecord>;
	selectedTaskId: string | null;
	view: AutoView;
	editingTask: ScheduledTask | null; // null = 新建
	selectedRecordId: string | null; // record-detail 视图当前查看的执行记录
	recordDetailBackTo: "records" | "detail"; // 打开时快照：返回目标视图

	// Actions
	loadTasks: () => Promise<void>;
	/** 拉取执行记录列表。无参 = 全量（≤200，SSE 兜底用）；
	 *  since/limit = 时间范围窗口（列表页初始加载/窗口前扩）；append = 合并去重而非替换 */
	loadRecords: (opts?: {
		taskId?: string;
		since?: number;
		limit?: number;
		append?: boolean;
	}) => Promise<void>;
	/** 任务详情页最近 N 条（尾读），与 records 分开存避免覆盖列表数据 */
	loadRecentRecords: (taskId: string, limit?: number) => Promise<void>;
	/** 侧栏状态点：每任务最新一条（读后端 latest 索引，非全量日志解析） */
	loadLatestByTask: () => Promise<void>;
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
	recentRecords: [],
	recentRecordsTaskId: null,
	latestByTask: {},
	selectedTaskId: null,
	view: "detail",
	editingTask: null,
	selectedRecordId: null,
	recordDetailBackTo: "records",

	loadTasks: async () => {
		const res = (await api.get("/api/scheduled-tasks")) as any;
		set({ tasks: res?.tasks ?? [], taskErrors: res?.errors ?? [] });
	},

	loadRecords: async (opts) => {
		// URLSearchParams 自带 query 编码（含中文与 & = # 等保留字符），勿先 encodeURIComponent 再塞入（会双重编码）
		const p = new URLSearchParams();
		if (opts?.taskId) p.set("taskId", opts.taskId);
		if (opts?.since) p.set("since", String(opts.since));
		if (opts?.limit) p.set("limit", String(opts.limit));
		const qs = p.toString();
		const res = (await api.get(`/api/execution-records${qs ? `?${qs}` : ""}`)) as any;
		const incoming: ExecutionRecord[] = res?.records ?? [];
		if (opts?.append) {
			// 追加翻页：同 id 后写覆盖先写（与后端去重语义一致），按 startedAt 倒序合并
			const byId = new Map(get().records.map((r) => [r.id, r] as const));
			for (const r of incoming) byId.set(r.id, r);
			set({ records: [...byId.values()].sort((a, b) => b.startedAt - a.startedAt) });
		} else {
			set({ records: incoming });
		}
	},

	loadRecentRecords: async (taskId, limit = 3) => {
		const res = (await api.get(
			`/api/execution-records?taskId=${encodeTaskId(taskId)}&limit=${limit}`,
		)) as any;
		set({ recentRecords: res?.records ?? [], recentRecordsTaskId: taskId });
	},

	loadLatestByTask: async () => {
		const res = (await api.get("/api/execution-records?latest=1")) as any;
		const byTask: Record<string, ExecutionRecord> = {};
		for (const r of (res?.records ?? []) as ExecutionRecord[]) byTask[r.taskId] = r;
		set({ latestByTask: byTask });
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
