// scheduler store 导航状态机：record-detail 视图 + 来源快照回退
// （执行记录详情页：从记录列表或任务详情进入，返回时回到各自来源）
import { describe, test, expect, beforeEach } from "bun:test";
import { useSchedulerStore } from "../src/store/scheduler";

beforeEach(() => {
	useSchedulerStore.setState({
		tasks: [],
		records: [],
		selectedTaskId: null,
		view: "detail",
		editingTask: null,
		selectedRecordId: null,
		recordDetailBackTo: "records",
	});
});

describe("scheduler store record-detail 导航", () => {
	test("openRecordDetail：从记录列表进入 → 快照 backTo=records", () => {
		useSchedulerStore.getState().openRecordDetail("rec-1", "records");
		const s = useSchedulerStore.getState();
		expect(s.view).toBe("record-detail");
		expect(s.selectedRecordId).toBe("rec-1");
		expect(s.recordDetailBackTo).toBe("records");
	});

	test("openRecordDetail：从任务详情进入 → 快照 backTo=detail", () => {
		useSchedulerStore.getState().openRecordDetail("rec-2", "detail");
		const s = useSchedulerStore.getState();
		expect(s.view).toBe("record-detail");
		expect(s.recordDetailBackTo).toBe("detail");
	});

	test("closeRecordDetail：按快照回退到来源（records）", () => {
		useSchedulerStore.getState().openRecordDetail("rec-1", "records");
		useSchedulerStore.getState().closeRecordDetail();
		const s = useSchedulerStore.getState();
		expect(s.view).toBe("records");
		expect(s.selectedRecordId).toBe(null);
	});

	test("closeRecordDetail：按快照回退到来源（detail）", () => {
		useSchedulerStore.getState().openRecordDetail("rec-2", "detail");
		useSchedulerStore.getState().closeRecordDetail();
		const s = useSchedulerStore.getState();
		expect(s.view).toBe("detail");
		expect(s.selectedRecordId).toBe(null);
	});

	test("selectTask（切任务）退出 record-detail：回到 detail 视图", () => {
		useSchedulerStore.getState().openRecordDetail("rec-1", "records");
		useSchedulerStore.getState().selectTask("t1");
		const s = useSchedulerStore.getState();
		expect(s.view).toBe("detail");
		expect(s.selectedRecordId).toBe(null);
	});

	test("startCreate / startEdit 退出 record-detail", () => {
		useSchedulerStore.getState().openRecordDetail("rec-1", "records");
		useSchedulerStore.getState().startCreate();
		expect(useSchedulerStore.getState().view).toBe("edit");
		expect(useSchedulerStore.getState().selectedRecordId).toBe(null);
		useSchedulerStore.getState().openRecordDetail("rec-1", "records");
		useSchedulerStore.getState().startEdit({
			id: "t1",
			name: "x",
			schedule: { type: "daily", time: "09:00" },
			agentId: "dev",
			prompt: "",
			enabled: true,
			createdAt: 0,
			updatedAt: 0,
		});
		const s = useSchedulerStore.getState();
		expect(s.view).toBe("edit");
		expect(s.selectedRecordId).toBe(null);
	});
});
