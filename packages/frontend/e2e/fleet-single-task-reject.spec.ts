import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
	createProject,
	saveProvider,
	createSessionViaPrompt,
	setUiPrefs,
} from "./helpers";

// E2E（Layer 4）：fleet 单任务拒绝结果（kernel 前置校验新增）在真实浏览器中的渲染
//
// 结果形状：content 只有一段引导文案（指向 delegate 单任务工具）、
// details={error:"fleet_requires_multiple_tasks"}、tasks 只含 1 个 agent。
// 验证点：真实浏览器里不崩、引导文案可见、不冒出子任务统计行/空「回复：」块。
//
// 本 spec 不依赖真实 LLM：createSessionViaPrompt 建会话壳，浏览器侧 store 注入
// fleet toolCall + toolResult（与 fleet-reply-degrade.spec.ts 同款）。
// 截图清理：本 spec 不落盘任何截图/临时文件。

const REJECT_TEXT =
	'错误：fleet 用于并行委派，至少需要 2 个任务（当前只有 1 个）。只委派单个任务时请改用 delegate 单任务工具，例如 delegate(agent="代码审查", task="评审改动")。';

test.describe.serial("fleet 单任务拒绝结果的渲染", () => {
	let projectId = "";
	let projectName = "";

	test.beforeEach(async () => {
		projectName = `e2e-fleet-reject-${randomUUID().slice(0, 8)}`;
		const project = await createProject(projectName, `/tmp/${projectName}`);
		projectId = project.id;

		// 预置假 provider（localhost 不实际连接，仅用于建会话壳）
		await saveProvider({
			id: "e2e-fleet-reject-provider",
			name: "E2E Fleet Reject",
			slug: "e2e-fleet-reject",
			baseUrl: "http://localhost:9999/v1",
			apiKey: "sk-e2e",
			api: "openai-completions",
			models: [{ id: "fleet-model", contextWindow: 128000, maxTokens: 4096 }],
		});
	});

	// 进入会话视图（REST 建会话 → 侧栏点项目名 → 点会话行）
	async function enterSession(
		page: import("@playwright/test").Page,
		text: string,
	): Promise<string> {
		// 需要中文界面断言：显式预置 zh（headless 默认 navigator=en-US 会渲染英文）
		await setUiPrefs(page, "zh");
		await page.goto("/");
		await page.waitForTimeout(500);
		const sessionId = "s-e2e-fleetrej-" + randomUUID().slice(0, 8);
		await createSessionViaPrompt(projectId, {
			agentName: "dev",
			text,
			model: "e2e-fleet-reject/fleet-model",
			sessionId,
		});
		await page.getByText(projectName).first().click();
		await page.getByTestId(`session-${sessionId}`).click();
		return sessionId;
	}

	// 浏览器侧注入 fleet toolCall + toolResult（等历史加载完成，避免 setMessages 覆盖注入）
	async function injectFleet(
		page: import("@playwright/test").Page,
		sessionId: string,
		payload: {
			toolCallId: string;
			tasks: Array<{ agent: string; task: string }>;
			text: string;
			isError: boolean;
			details?: unknown;
		},
	) {
		await page.evaluate(
			async ({ sessionId, payload }) => {
				const { useSessionStore } = await import("/src/store/session.ts");

				// 等历史加载完成（避免 setMessages 覆盖注入）
				const deadline = Date.now() + 8000;
				while (useSessionStore.getState().historyLoadingBySession[sessionId]) {
					if (Date.now() > deadline) break;
					await new Promise((r) => setTimeout(r, 100));
				}

				const now = Date.now();
				useSessionStore.getState().append(sessionId, {
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: payload.toolCallId,
								name: "fleet",
								arguments: { tasks: payload.tasks },
							},
						],
						model: "e2e-mock",
						stopReason: "tool_use",
						timestamp: now,
					},
					agentName: "dev",
					sessionId,
				} as any);
				useSessionStore.getState().append(sessionId, {
					message: {
						role: "toolResult",
						toolCallId: payload.toolCallId,
						toolName: "fleet",
						content: [{ type: "text", text: payload.text }],
						isError: payload.isError,
						timestamp: now + 1,
						details: payload.details,
					},
					agentName: "dev",
					sessionId,
				} as any);
			},
			{ sessionId, payload },
		);
	}

	test("isError=true 的拒绝结果：渲染引导文案 + 失败态，无统计行/空回复块", async ({
		page,
	}) => {
		test.setTimeout(30_000);
		const sessionId = await enterSession(page, "fleet 单任务拒绝");
		const toolCallId = "fleet-e2e-reject-1";
		await injectFleet(page, sessionId, {
			toolCallId,
			tasks: [{ agent: "代码审查", task: "评审改动" }],
			text: REJECT_TEXT,
			isError: true,
			details: { error: "fleet_requires_multiple_tasks" },
		});

		await expect(page.getByTestId(`fleet-${toolCallId}`)).toBeVisible({
			timeout: 8000,
		});
		// 失败态（isError 被透传时的形态）
		await expect(page.getByTestId(`fleet-${toolCallId}-header`)).toContainText(
			"失败",
		);
		await page.getByTestId(`fleet-${toolCallId}-header`).click();

		// 引导文案渲染出来（拆不出逐任务回复 → 走降级聚合区）
		await expect(page.getByText(/至少需要 2 个任务/)).toBeVisible();
		await expect(page.getByText(/改用 delegate 单任务工具/)).toBeVisible();
		// 参数回显的任务清单行只有 1 条（真实 params，不是伪造任务行）
		await expect(page.getByText(/委派【代码审查】评审改动/)).toHaveCount(1);
		// 无子任务统计行容器（拒绝路径没有任何子任务）
		await expect(page.getByTestId(`fleet-progress-${toolCallId}`)).toHaveCount(
			0,
		);
		// 「回复：」只有聚合区 1 处：没有空回复块
		await expect(page.getByText("回复：")).toHaveCount(1);
	});

	test("isError=false 的拒绝结果（当前 SDK 透传形态）：引导文案照常渲染、无统计行/空回复块", async ({
		page,
	}) => {
		test.setTimeout(30_000);
		const sessionId = await enterSession(page, "fleet 单任务拒绝-现状");
		const toolCallId = "fleet-e2e-reject-2";
		// 现状：pi SDK 不把 execute 返回的 result.isError 透传到 ToolResultMessage
		// （成功路径恒 isError:false），真实会话里该结果的 isError 是 false。
		// 本用例证明此形态下引导文案照常可见、不崩、无伪造行（失败态断言缺席属预期）。
		await injectFleet(page, sessionId, {
			toolCallId,
			tasks: [{ agent: "代码审查", task: "评审改动" }],
			text: REJECT_TEXT,
			isError: false,
			details: { error: "fleet_requires_multiple_tasks" },
		});

		await expect(page.getByTestId(`fleet-${toolCallId}`)).toBeVisible({
			timeout: 8000,
		});
		await page.getByTestId(`fleet-${toolCallId}-header`).click();

		await expect(page.getByText(/至少需要 2 个任务/)).toBeVisible();
		await expect(page.getByTestId(`fleet-progress-${toolCallId}`)).toHaveCount(
			0,
		);
		await expect(page.getByText("回复：")).toHaveCount(1);
	});
});
