// TaskEditForm.test.tsx — 定时任务模型选择「必须指定」回归：
// 「跟随默认」空选项已移除，模型必填（新建默认选中第一个可用模型；
// 编辑 model=null 的存量任务时自动归一为第一个模型，保存载荷不再出现 null）。
import { test, expect, beforeEach, describe } from "bun:test";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { TaskEditForm } from "../src/components/automation/TaskEditForm";
import { useSchedulerStore } from "../src/store/scheduler";
import { useAgentsStore } from "../src/store/agents";
import { useProjectsStore } from "../src/store/projects";
import { useProvidersStore } from "../src/store/providers";
import { useUiPrefsStore } from "../src/store/ui-prefs";

const PROVIDERS = [
	{
		id: "pid1",
		name: "DeepSeek",
		baseUrl: "https://api.deepseek.test",
		apiKey: "sk-test",
		api: "openai-completions",
		models: [
			{ id: "m-a", name: "M A", contextWindow: 1000, maxTokens: 100 },
			{ id: "m-b", name: "M B", contextWindow: 1000, maxTokens: 100 },
		],
	},
] as any;

function seedStores(overrides?: { editingTask?: any; providers?: any[] }) {
	useSchedulerStore.setState({
		editingTask: overrides?.editingTask ?? null,
		createTask: async () => {},
		updateTask: async () => {},
		setView: () => {},
	} as any);
	useAgentsStore.setState({ list: [{ displayName: "dev", model: null }] } as any);
	useProjectsStore.setState({
		projects: [{ id: "__system__", name: "默认工作区", cwd: "/w", createdAt: 1 }],
		sessions: [],
	} as any);
	useProvidersStore.setState({
		providers: overrides?.providers ?? PROVIDERS,
	} as any);
	useUiPrefsStore.setState({ defaultAgent: undefined } as any);
}

describe("定时任务模型选择：移除「跟随默认」，必须指定", () => {
	beforeEach(() => {
		cleanup();
	});

	test("新建表单：模型下拉不含「跟随默认」空选项，默认选中第一个可用模型", () => {
		seedStores();
		render(<TaskEditForm />);
		const select = screen.getByTestId("task-model-select") as HTMLSelectElement;
		expect(select.querySelector('option[value=""]')).toBeNull();
		// 首个 option 即第一个真实模型，且被选中
		expect(select.options.length).toBeGreaterThanOrEqual(2);
		expect(select.value).toBe(select.options[0].value);
		expect(select.options[0].textContent).not.toBe("跟随默认");
	});

	test("编辑 model=null 的存量任务：自动归一为第一个模型（不出现空选中）", () => {
		seedStores({
			editingTask: {
				id: "t1",
				name: "存量任务",
				schedule: { type: "daily", time: "09:00" },
				agentId: "dev",
				prompt: "p",
				model: null,
				enabled: true,
				createdAt: 1,
				updatedAt: 1,
			} as any,
		});
		render(<TaskEditForm />);
		const select = screen.getByTestId("task-model-select") as HTMLSelectElement;
		expect(select.querySelector('option[value=""]')).toBeNull();
		expect(select.value).toBe(select.options[0].value);
		expect(select.value).not.toBe("");
	});

	test("providers 为空导致无法指定模型时，其余必填齐全也禁用保存（model 必填）", () => {
		// 编辑模式：name/agentId/prompt 由存量任务回填齐全，唯一缺的是 model
		seedStores({
			providers: [],
			editingTask: {
				id: "t1",
				name: "存量任务",
				schedule: { type: "daily", time: "09:00" },
				agentId: "dev",
				prompt: "p",
				model: null,
				enabled: true,
				createdAt: 1,
				updatedAt: 1,
			} as any,
		});
		render(<TaskEditForm />);
		const save = screen.getByTestId("task-save-btn") as HTMLButtonElement;
		expect(save.disabled).toBe(true);
	});
});
