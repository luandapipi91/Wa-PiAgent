import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
	createProject,
	saveProvider,
	createSessionViaPrompt,
	setUiPrefs,
} from "./helpers";

// E2E（Layer 4）：fleet 运行期任务行完整性（「4 个委托显示不全」回归）
//
// 根因：任务行只在收到该任务的进度帧后才渲染，而子代理的首个进度帧要等它产生第一个业务
// 事件（工具调用/文本）——4 个并行任务在启动阶段会有若干行整行消失，等调用完成后由
// details.fleet 统计补齐（用户反馈：过程中显示不全、完成后才完整）。
// 修复：①内核任务启动即发首帧；②前端运行期渲染全部任务行，无进度帧的行显示「排队中」。
//
// 本 spec 不依赖真实 LLM：createSessionViaPrompt 建会话壳，浏览器侧 store 注入
// fleet toolCall + 仅前两个任务的进度帧。
// 截图清理：本 spec 不落盘任何截图/临时文件。

test.describe.serial("fleet 运行期任务行", () => {
	let projectId = "";
	let projectName = "";

	test.beforeEach(async () => {
		projectName = `e2e-fleet-rows-${randomUUID().slice(0, 8)}`;
		const project = await createProject(projectName, `/tmp/${projectName}`);
		projectId = project.id;

		await saveProvider({
			id: "e2e-fleet-rows-provider",
			name: "E2E Fleet Rows",
			slug: "e2e-fleet-rows",
			baseUrl: "http://localhost:9999/v1",
			apiKey: "sk-e2e",
			api: "openai-completions",
			models: [{ id: "fleet-model", contextWindow: 128000, maxTokens: 4096 }],
		});
	});

	test("4 任务并行、仅 2 个已发进度帧：4 行全部显示，未开始的显示「排队中」", async ({
		page,
	}) => {
		test.setTimeout(30_000);
		await setUiPrefs(page, "zh");
		await page.goto("/");
		await page.waitForTimeout(500);
		const sessionId = "s-e2e-fleetrows-" + randomUUID().slice(0, 8);
		await createSessionViaPrompt(projectId, {
			agentName: "dev",
			text: "fleet 运行期行回归",
			model: "e2e-fleet-rows/fleet-model",
			sessionId,
		});
		await page.getByText(projectName).first().click();
		await page.getByTestId(`session-${sessionId}`).click();

		await page.evaluate(
			async ({ sessionId }) => {
				const { useSessionStore } = await import("/src/store/session.ts");

				// 等历史加载完成（避免 setMessages 覆盖注入）
				const deadline = Date.now() + 8000;
				while (useSessionStore.getState().historyLoadingBySession[sessionId]) {
					if (Date.now() > deadline) break;
					await new Promise((r) => setTimeout(r, 100));
				}

				const toolCallId = "fleet-e2e-rows-1";
				useSessionStore.getState().append(sessionId, {
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: toolCallId,
								name: "fleet",
								arguments: {
									tasks: [
										{ agent: "general-purpose", task: "甲" },
										{ agent: "general-purpose", task: "乙" },
										{ agent: "Explore", task: "丙" },
										{ agent: "Plan", task: "丁" },
									],
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

				// 仅前两个任务已有进度帧（后两个刚派发、尚未产生首个业务事件 → 无帧）
				useSessionStore.getState().handleSubagentProgress(sessionId, toolCallId, {
					agent: "general-purpose",
					taskIndex: 0,
					status: "running",
					output: "",
					elapsedMs: 1500,
					tools: [
						{ id: "t1", name: "read", status: "done" },
						{ id: "t2", name: "read", status: "done" },
					],
				});
				useSessionStore.getState().handleSubagentProgress(sessionId, toolCallId, {
					agent: "general-purpose",
					taskIndex: 1,
					status: "running",
					output: "",
					elapsedMs: 1200,
					tools: [{ id: "t3", name: "grep", status: "error" }],
				});
			},
			{ sessionId },
		);

		await expect(page.getByTestId("fleet-fleet-e2e-rows-1")).toBeVisible({
			timeout: 8000,
		});
		await expect(page.getByText(/并行派发 4 个任务/)).toBeVisible();

		// 「回复过程默认折叠」为默认偏好：卡片头默认收起，按需点开（已是展开态则不点，避免反而收起）
		const body = page.getByTestId("fleet-fleet-e2e-rows-1-body");
		await page.waitForTimeout(300);
		if (!(await body.isVisible())) {
			await page.getByTestId("fleet-fleet-e2e-rows-1-header").click();
		}
		await expect(body).toBeVisible();

		// 4 个任务行全部可见：有帧的两行显示各自统计，无帧的两行显示「排队中」
		// （修复前无帧的行整行不渲染 → 看起来「显示不全」）
		await expect(
			page.getByText(/任务 1：调用了 2 个工具 成功 2 失败 0 执行中 0/),
		).toBeVisible();
		await expect(
			page.getByText(/任务 2：调用了 1 个工具 成功 0 失败 1 执行中 0/),
		).toBeVisible();
		await expect(page.getByText(/任务 3：排队中/)).toBeVisible();
		await expect(page.getByText(/任务 4：排队中/)).toBeVisible();
	});
});
