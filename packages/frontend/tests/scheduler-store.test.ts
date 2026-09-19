// scheduler store selectTask 行为测试：点选/切换/再点取消选中。
// api-client mock 后直接驱动 store（与 explorer-store.test 同风格）。
import { test, expect, describe, beforeEach, mock } from "bun:test";

mock.module("../src/api-client", () => ({
	api: {
		get: async () => ({ tasks: [] }),
		post: async () => ({}),
		put: async () => ({}),
		del: async () => ({}),
	},
	ApiError: class extends Error {},
}));

const { useSchedulerStore } = await import("../src/store/scheduler");

beforeEach(() => {
	useSchedulerStore.setState({
		tasks: [
			{ id: "t1", name: "任务一" },
			{ id: "t2", name: "任务二" },
		] as never,
		selectedTaskId: null,
		view: "detail",
	});
});

test("selectTask 选中任务并切到 detail 视图", () => {
	useSchedulerStore.getState().selectTask("t1");
	expect(useSchedulerStore.getState().selectedTaskId).toBe("t1");
	expect(useSchedulerStore.getState().view).toBe("detail");
});

test("再点同一任务取消选中（selectedTaskId 回 null）", () => {
	useSchedulerStore.getState().selectTask("t1");
	useSchedulerStore.getState().selectTask("t1");
	expect(useSchedulerStore.getState().selectedTaskId).toBeNull();
});

test("点不同任务切换选中", () => {
	useSchedulerStore.getState().selectTask("t1");
	useSchedulerStore.getState().selectTask("t2");
	expect(useSchedulerStore.getState().selectedTaskId).toBe("t2");
});

test("createTask 成功后选中新任务（selectedTaskId = 新任务 id）", async () => {
	const { api } = await import("../src/api-client");
	api.post = async () => ({ task: { id: "new-1" } });
	await useSchedulerStore.getState().createTask({ name: "新任务" });
	expect(useSchedulerStore.getState().selectedTaskId).toBe("new-1");
	expect(useSchedulerStore.getState().view).toBe("detail");
});

// ===== 立即执行 / 取消执行的 store 行为（本次改造新增）=====
// kernel 侧「先落盘 running 记录再响应」保证 runTaskNow 返回时数据已就绪，
// 因此 store 响应后立即刷新，「最近执行」不必等 SSE 回推即可见。
describe("runTaskNow / cancelTaskRun / refreshFromEvents", () => {
	const runningRecord = {
		id: "r-run",
		taskId: "t1",
		taskName: "任务一",
		status: "running",
		startedAt: 100,
	};

	beforeEach(() => {
		useSchedulerStore.setState({
			tasks: [],
			taskErrors: [],
			records: [],
			recentRecords: [],
			recentRecordsTaskId: null,
			latestByTask: {},
			selectedTaskId: "t1",
			view: "detail",
		});
	});

	test("runTaskNow：POST 后立即刷新「最近执行」+ 状态点（不等 SSE）", async () => {
		const { api } = await import("../src/api-client");
		const paths: string[] = [];
		api.get = async (path: string) => {
			paths.push(path);
			if (path.startsWith("/api/scheduled-tasks")) return { tasks: [] };
			return { records: [runningRecord] };
		};
		api.post = async (path: string) => {
			paths.push(path);
			return { ok: true };
		};

		await useSchedulerStore.getState().runTaskNow("t1");
		const s = useSchedulerStore.getState();
		expect(paths).toContain("/api/scheduled-tasks/t1/run");
		expect(s.recentRecords.map((r) => r.id)).toEqual(["r-run"]);
		expect(s.recentRecordsTaskId).toBe("t1");
		expect(s.latestByTask.t1?.status).toBe("running");
	});

	test("runTaskNow：taskId 编码后进 path（中文/保留字符任务 id）", async () => {
		const { api } = await import("../src/api-client");
		const paths: string[] = [];
		api.get = async () => ({ records: [] });
		api.post = async (path: string) => {
			paths.push(path);
			return { ok: true };
		};
		const id = "云效站会报告&x";
		await useSchedulerStore.getState().runTaskNow(id);
		expect(paths).toContain(
			`/api/scheduled-tasks/${encodeURIComponent(id)}/run`,
		);
	});

	test("runTaskNow：非 2xx（409 已在执行中）向上抛出，由 UI 按字典提示", async () => {
		const { api } = await import("../src/api-client");
		api.post = async () => {
			throw new Error("already running");
		};
		await expect(
			useSchedulerStore.getState().runTaskNow("t1"),
		).rejects.toThrow("already running");
	});

	test("cancelTaskRun：转发取消请求并返回 cancelled/reconciled，随后刷新", async () => {
		const { api } = await import("../src/api-client");
		const paths: string[] = [];
		api.get = async (path: string) => {
			paths.push(path);
			return { records: [] };
		};
		api.post = async (path: string) => {
			paths.push(path);
			return { ok: true, cancelled: true, reconciled: 0 };
		};
		const res = await useSchedulerStore.getState().cancelTaskRun("t1");
		expect(paths).toContain("/api/scheduled-tasks/t1/cancel");
		expect(res).toEqual({ cancelled: true, reconciled: 0 });
		// 取消后状态点/执行记录一起刷新（终态由 SSE 兜底再刷一次）
		expect(paths.some((p) => p.includes("latest=1"))).toBe(true);
	});

	test("runTaskNow：POST 成功但刷新失败 → 不得 reject（刷新是副作用，不能误报操作失败）", async () => {
		const { api } = await import("../src/api-client");
		api.post = async () => ({ ok: true });
		api.get = async () => {
			throw new Error("刷新挂了");
		};
		// 执行已触发（POST 已 200）：刷新失败只应静默，不能把它当成「触发失败」
		await expect(
			useSchedulerStore.getState().runTaskNow("t1"),
		).resolves.toBeUndefined();
	});

	test("cancelTaskRun：刷新失败 → 仍回传取消回执（cancelled/reconciled 不丢）", async () => {
		const { api } = await import("../src/api-client");
		api.post = async () => ({ ok: true, cancelled: true, reconciled: 2 });
		api.get = async () => {
			throw new Error("刷新挂了");
		};
		await expect(
			useSchedulerStore.getState().cancelTaskRun("t1"),
		).resolves.toEqual({ cancelled: true, reconciled: 2 });
	});

	test("refreshFromEvents：单个请求失败不影响其它刷新（不整体 reject）", async () => {
		const { api } = await import("../src/api-client");
		api.get = async (path: string) => {
			if (path.includes("latest=1")) throw new Error("latest 挂了");
			return { records: [], tasks: [] };
		};
		await expect(
			useSchedulerStore.getState().refreshFromEvents(),
		).resolves.toBeUndefined();
	});

	test("refreshFromEvents：选中任务时补刷「最近执行」", async () => {
		const { api } = await import("../src/api-client");
		const paths: string[] = [];
		api.get = async (path: string) => {
			paths.push(path);
			return { records: [], tasks: [] };
		};
		await useSchedulerStore.getState().refreshFromEvents();
		expect(
			paths.some((p) => p.startsWith("/api/execution-records?taskId=t1")),
		).toBe(true);
	});

	test("refreshFromEvents：未选中任务时不刷「最近执行」（不覆盖已选任务数据）", async () => {
		const { api } = await import("../src/api-client");
		const paths: string[] = [];
		api.get = async (path: string) => {
			paths.push(path);
			return { records: [], tasks: [] };
		};
		useSchedulerStore.setState({ selectedTaskId: null });
		await useSchedulerStore.getState().refreshFromEvents();
		expect(
			paths.some((p) => p.startsWith("/api/execution-records?taskId=")),
		).toBe(false);
	});
});
