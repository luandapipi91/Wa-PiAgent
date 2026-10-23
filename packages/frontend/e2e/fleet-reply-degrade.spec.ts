import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
	createProject,
	saveProvider,
	createSessionViaPrompt,
	setUiPrefs,
} from "./helpers";

// E2E（Layer 4）：fleet 卡片回复拆分与降级态「空回复」回归
//
// 复现根因：聚合正文里 agent 自带的【】小标题（如「## 【代理A·质数计算】任务结果」）会被
// 旧拆分器误当分段边界 → 拆分失败、整卡降级为聚合显示 → 任务行没有逐任务回复却仍渲染
// 空「回复：」块（用户反馈「有正式回复，但底部还有空的回复」）。
// 修复后：只有「行首 + 名称命中任务清单」的【】才算边界；降级态任务行不再承诺
// 「点击查看回复」、展开不出现空「回复：」。
//
// 本 spec 不依赖真实 LLM：createSessionViaPrompt 建会话壳，浏览器侧 store 注入
// fleet toolCall + toolResult（与 fleet-same-agent.spec.ts 同款）。
// 截图清理：本 spec 不落盘任何截图/临时文件。

test.describe.serial("fleet 回复拆分与降级态", () => {
	let projectId = "";
	let projectName = "";

	test.beforeEach(async () => {
		projectName = `e2e-fleet-degrade-${randomUUID().slice(0, 8)}`;
		const project = await createProject(projectName, `/tmp/${projectName}`);
		projectId = project.id;

		// 预置假 provider（localhost 不实际连接，仅用于建会话壳）
		await saveProvider({
			id: "e2e-fleet-degrade-provider",
			name: "E2E Fleet Degrade",
			slug: "e2e-fleet-degrade",
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
		const sessionId = "s-e2e-fleetdeg-" + randomUUID().slice(0, 8);
		await createSessionViaPrompt(projectId, {
			agentName: "dev",
			text,
			model: "e2e-fleet-degrade/fleet-model",
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
						isError: false,
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

	test("含正文【】小标题的聚合文本：按任务拆分成功，各任务行显示各自回复（无聚合块/无空回复）", async ({
		page,
	}) => {
		test.setTimeout(30_000);
		const sessionId = await enterSession(page, "fleet 拆分回归");
		const toolCallId = "fleet-e2e-split-1";
		await injectFleet(page, sessionId, {
			toolCallId,
			tasks: [
				{ agent: "general-purpose", task: "计算质数" },
				{ agent: "Explore", task: "盘点技能" },
			],
			text: [
				"【general-purpose】验证通过，交叉验证如下：",
				"",
				"## 【代理A·质数计算】任务结果",
				"",
				"表格片段",
				"",
				"【Explore】探索完成，共 49 个技能。",
			].join("\n"),
			details: {
				fleet: {
					"0": { total: 8, done: 6, error: 2, running: 0 },
					"1": { total: 6, done: 6, error: 0, running: 0 },
				},
			},
		});

		// 卡片可见（完成态默认折叠）→ 点头部展开
		await expect(page.getByTestId(`fleet-${toolCallId}`)).toBeVisible({
			timeout: 8000,
		});
		await page.getByTestId(`fleet-${toolCallId}-header`).click();

		// 拆分成功：不渲染聚合回复块；任务行承诺「点击查看回复」（有逐任务回复可看）
		await expect(page.getByTestId("text-block")).toHaveCount(0);
		await expect(
			page.getByText(
				/任务 1：已完成 调用了 8 个工具 成功 6 失败 2 执行中 0 · 点击查看回复/,
			),
		).toBeVisible();

		// 点开任务 1：正文完整保留（含自带【】小标题），且不含任务 2 的回复
		await page.locator("button", { hasText: "任务 1" }).click();
		await expect(page.getByText(/验证通过/)).toBeVisible();
		await expect(page.getByText(/代理A·质数计算/)).toBeVisible();
		await expect(page.getByText(/探索完成/)).toHaveCount(0);

		// 点开任务 2：显示自己的回复；任务 1 的回复仍可见（独立展开互不影响）
		await page.locator("button", { hasText: "任务 2" }).click();
		await expect(page.getByText(/探索完成/)).toBeVisible();
		await expect(page.getByText(/验证通过/)).toBeVisible();
		// 两行各一块非空「回复：」，没有多余的空回复块
		await expect(page.getByText("回复：")).toHaveCount(2);
	});

	test("降级聚合（无法拆分）：行不显示「点击查看回复」后缀，点击不出现空「回复：」块", async ({
		page,
	}) => {
		test.setTimeout(30_000);
		const sessionId = await enterSession(page, "fleet 降级回归");
		const toolCallId = "fleet-e2e-degrade-1";
		await injectFleet(page, sessionId, {
			toolCallId,
			tasks: [
				{ agent: "general-purpose", task: "汇总统计" },
				{ agent: "Explore", task: "环境盘点" },
			],
			// 正文无【】标记 → 无法拆分 → 降级聚合显示
			text: "并行任务完成：统计已汇总，环境盘点完毕。",
			details: {
				fleet: {
					"0": { total: 8, done: 6, error: 2, running: 0 },
					"1": { total: 6, done: 6, error: 0, running: 0 },
				},
			},
		});

		await expect(page.getByTestId(`fleet-${toolCallId}`)).toBeVisible({
			timeout: 8000,
		});
		await page.getByTestId(`fleet-${toolCallId}-header`).click();

		// 聚合回复区（正式回复）可见
		await expect(page.getByTestId("text-block")).toHaveCount(1);
		await expect(page.getByText(/统计已汇总/)).toBeVisible();
		// 统计行如实显示计数，但不承诺「点击查看回复」（逐任务回复不可用）
		await expect(
			page.getByText(/任务 1：已完成 调用了 8 个工具 成功 6 失败 2 执行中 0/),
		).toBeVisible();
		await expect(page.getByText(/点击查看回复/)).toHaveCount(0);
		// 「回复：」只有聚合区 1 处（任务行不渲染空的「回复：」块）
		await expect(page.getByText("回复：")).toHaveCount(1);
		// 点任务 1 行：无展开内容，不冒出第二个空「回复：」块（修复前会）
		await page.locator("button", { hasText: "任务 1" }).click();
		await expect(page.getByText("回复：")).toHaveCount(1);
	});
});
