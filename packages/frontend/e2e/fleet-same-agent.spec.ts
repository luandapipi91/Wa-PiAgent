import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createProject, saveProvider, createSessionViaPrompt } from "./helpers";

// E2E（Layer 4）：fleet 同名 agent 并行委托状态隔离
//
// 复现根因：LLM 把多个任务派给同一智能体（同名 agent），进度按 agent 名做 key
// 互相覆盖，前端显示「完成/进行中/失败一模一样」。修复后按 taskIndex 区分。
//
// 本 spec 不依赖真实 LLM：用 createSessionViaPrompt 建会话壳，再通过浏览器侧
// store 注入 fleet toolCall + progress 事件（与 plugin-command-toggles.spec.ts 同款），
// 在真实 Chromium 里断言 FleetCard 各任务行显示各自独立的工具统计。
//
// 截图清理：本 spec 不落盘任何截图/临时文件。

test.describe
	.serial("fleet 同名 agent 状态隔离", () => {
		let projectId = "";
		let projectName = "";

		test.beforeEach(async () => {
			projectName = `e2e-fleet-dup-${randomUUID().slice(0, 8)}`;
			const project = await createProject(projectName, `/tmp/${projectName}`);
			projectId = project.id;

			// 预置假 provider（localhost 不实际连接，仅用于建会话壳）
			await saveProvider({
				id: "e2e-fleet-dup-provider",
				name: "E2E Fleet Dup",
				slug: "e2e-fleet-dup",
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
			await page.goto("/");
			await page.waitForTimeout(500);
			const sessionId = "s-e2e-fleetdup-" + randomUUID().slice(0, 8);
			await createSessionViaPrompt(projectId, {
				agentName: "dev",
				text,
				model: "e2e-fleet-dup/fleet-model",
				sessionId,
			});
			await page.getByText(projectName).first().click();
			await page.getByTestId(`session-${sessionId}`).click();
			return sessionId;
		}

		test("同名 agent 多任务各显示独立工具统计（不一模一样）", async ({
			page,
		}) => {
			test.setTimeout(30_000);
			const sessionId = await enterSession(page, "fleet 同名 agent 测试");

			// 注入 fleet toolCall 消息 + 两个同名 agent 任务的 progress（各自不同工具统计）
			// 任务 0：2 个工具全部成功；任务 1：1 个工具失败
			await page.evaluate(
				async ({ sessionId }) => {
					const { useSessionStore } = await import("/src/store/session.ts");

					// 等历史加载完成（避免 setMessages 覆盖注入）
					const deadline = Date.now() + 8000;
					while (
						useSessionStore.getState().historyLoadingBySession[sessionId]
					) {
						if (Date.now() > deadline) break;
						await new Promise((r) => setTimeout(r, 100));
					}

					const toolCallId = "fleet-e2e-dup-1";
					const now = Date.now();

					// 注入 assistant 消息含 fleet toolCall（两个同名 Explore 任务）
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
											{ agent: "Explore", task: "搜 A" },
											{ agent: "Explore", task: "搜 B" },
										],
									},
								},
							],
							model: "e2e-mock",
							stopReason: "tool_use",
							timestamp: now,
						},
						agentName: "dev",
						sessionId,
					} as any);

					// 注入 progress：任务 0 = 2 工具全成功，任务 1 = 1 工具失败
					useSessionStore
						.getState()
						.handleSubagentProgress(sessionId, toolCallId, {
							agent: "Explore",
							taskIndex: 0,
							status: "running",
							output: "",
							elapsedMs: 1000,
							tools: [
								{ id: "t1", name: "read", status: "done" },
								{ id: "t2", name: "read", status: "done" },
							],
						});
					useSessionStore
						.getState()
						.handleSubagentProgress(sessionId, toolCallId, {
							agent: "Explore",
							taskIndex: 1,
							status: "running",
							output: "",
							elapsedMs: 2000,
							tools: [{ id: "t3", name: "grep", status: "error" }],
						});
				},
				{ sessionId },
			);

			// FleetCard 卡片可见
			await expect(page.getByTestId("fleet-fleet-e2e-dup-1")).toBeVisible({
				timeout: 8000,
			});

			// 运行态 hasProgress=true 卡片默认展开，两个任务行统计各自独立：
			// 任务 0 显示「调用了 2 个工具」，任务 1 显示「调用了 1 个工具」——不一模一样
			await expect(page.getByText(/调用了 2 个工具/)).toBeVisible({
				timeout: 5000,
			});
			await expect(page.getByText(/调用了 1 个工具/)).toBeVisible({
				timeout: 5000,
			});
		});
	});
