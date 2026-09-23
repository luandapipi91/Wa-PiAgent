import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
	createProject,
	saveProvider,
	createSessionViaPrompt,
	setUiPrefs,
} from "./helpers";

// E2E（Layer 4）：委派卡片终态以工具结果为权威（2026-09-23「已完成却显示已中断」回归）
//
// 现场：子代理跑了 79.6 分钟、结果完整回传（kernel 落盘 details.interrupted=false），
// 卡片却显示「已中断」。原因是浏览器 store 里该 toolCall 的进度仍停在 running
// （终态进度帧未送达：断流丢帧 / 旧数据），前端兜底把「进度没走到终态」当成「被中断」。
//
// 修复后：终态判定只信 kernel 落盘的 details.interrupted，进度停在 running 不再推翻它；
// 摘要行按结果定性（完成），不出现中断徽标。
//
// 本 spec 不依赖真实 LLM：建会话壳后在浏览器侧注入 toolCall + 残留进度帧 + toolResult。
// 截图清理：本 spec 不落盘任何截图/临时文件。

test.describe.serial("委派卡片终态以工具结果为权威", () => {
	let projectId = "";
	let projectName = "";

	test.beforeEach(async () => {
		projectName = `e2e-delegate-authority-${randomUUID().slice(0, 8)}`;
		const project = await createProject(projectName, `/tmp/${projectName}`);
		projectId = project.id;

		await saveProvider({
			id: "e2e-delegate-authority-provider",
			name: "E2E Delegate Authority",
			slug: "e2e-delegate-authority",
			baseUrl: "http://localhost:9999/v1",
			apiKey: "sk-e2e",
			api: "openai-completions",
			models: [{ id: "authority-model", contextWindow: 128000, maxTokens: 4096 }],
		});
	});

	test("details.interrupted=false 且进度停在 running：卡片显示「完成」，无中断徽标", async ({
		page,
	}) => {
		test.setTimeout(30_000);
		await setUiPrefs(page, "zh");
		await page.goto("/");
		await page.waitForTimeout(500);
		const sessionId = "s-e2e-delegate-auth-" + randomUUID().slice(0, 8);
		await createSessionViaPrompt(projectId, {
			agentName: "dev",
			text: "委派终态权威回归",
			model: "e2e-delegate-authority/authority-model",
			sessionId,
		});
		await page.getByText(projectName).first().click();
		await page.getByTestId(`session-${sessionId}`).click();

		const toolCallId = "call-e2e-delegate-auth-1";
		await page.evaluate(
			async ({ sessionId, toolCallId }) => {
				const { useSessionStore } = await import("/src/store/session.ts");

				// 等历史加载完成（避免 setMessages 覆盖注入）
				const deadline = Date.now() + 8000;
				while (useSessionStore.getState().historyLoadingBySession[sessionId]) {
					if (Date.now() > deadline) break;
					await new Promise((r) => setTimeout(r, 100));
				}

				// 1) 助手发起 delegate
				useSessionStore.getState().append(sessionId, {
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: toolCallId,
								name: "delegate",
								arguments: {
									agent: "general-purpose",
									task: "你是 fe-14 迁移计划的实现子智能体，负责任务 A4",
								},
							},
						],
						model: "e2e-mock",
						stopReason: "tool_use",
						timestamp: Date.now(),
					},
					agentName: "dev",
					sessionId,
				} as any);

				// 2) 终态帧丢失：store 里的进度停在 running（事故现场的真实形态）
				useSessionStore.getState().handleSubagentProgress(sessionId, toolCallId, {
					agent: "general-purpose",
					status: "running",
					output: "执行到一半…",
					elapsedMs: 4_775_000,
					tools: [
						{ id: "t1", name: "bash", status: "done" },
						{ id: "t2", name: "edit", status: "done" },
					],
				});

				// 3) 工具结果到达：kernel 落盘 interrupted=false（任务真的跑完了）
				useSessionStore.getState().append(sessionId, {
					message: {
						role: "toolResult",
						toolCallId,
						toolName: "delegate",
						content: [
							{
								type: "text",
								text: "任务 A4 全部完成。按报告契约回传：状态 DONE_WITH_CONCERNS",
							},
						],
						isError: false,
						timestamp: Date.now(),
						details: { interrupted: false },
					},
					agentName: "dev",
					sessionId,
				} as any);
			},
			{ sessionId, toolCallId },
		);

		const card = page.getByTestId(`delegate-${toolCallId}`);
		await expect(card).toBeVisible({ timeout: 8000 });

		// 关键断言：不得出现「已中断」徽标（修复前此处为 1）
		await expect(card.getByTestId("interrupted-badge")).toHaveCount(0);
		await expect(
			page.getByTestId(`delegate-${toolCallId}-header`),
		).toContainText("完成");

		// 「回复过程默认折叠」为默认偏好：体未渲染时点开（已是展开态则不点，避免反而收起）
		const body = page.getByTestId(`delegate-${toolCallId}-body`);
		await page.waitForTimeout(300);
		if (!(await body.isVisible())) {
			await page.getByTestId(`delegate-${toolCallId}-header`).click();
		}
		await expect(body).toBeVisible();

		// 摘要行按结果定性为「完成」，既不是「运行中」也不是「已中断」
		const summary = page.getByTestId(`delegate-progress-${toolCallId}`);
		await expect(summary).toContainText("完成");
		await expect(summary).not.toContainText("已中断");
		await expect(summary).not.toContainText("运行中");
	});
});
