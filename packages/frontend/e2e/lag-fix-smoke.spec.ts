// ============================================================================
// 卡顿修复冒烟测试（trace 实证三轮修复的真实浏览器验收）
//
// 背景：2026-09-17 三轮卡顿修复——
//   ① MarkdownBlock/ThinkingCard 流式停顿降级（阈值 50ms）
//   ② 侧边栏渲染范围（ProjectList 字段 selector + SessionRow/ProjectItem memo
//      + touchSession 无假引用变化）
//   ③ SessionView 拆字段 selector（touchSession 新 session 对象不再击穿整树）
//
// 本 spec 在真实 Chromium 中用 store 注入复现「工具循环 + 流式输出」负载，
// 验证：降级切换正常、touchSession 连坐消失（无秒级长任务）。
// 不依赖真实 LLM：createSessionViaPrompt 建会话壳 + page.evaluate 注入 SDK 事件。
// ============================================================================

import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createProject, saveProvider, createSessionViaPrompt } from "./helpers";

test.describe("卡顿修复冒烟", () => {
	let projectId = "";
	let projectName = "";

	test.beforeEach(async () => {
		projectName = `e2e-lag-smoke-${randomUUID().slice(0, 8)}`;
		const project = await createProject(projectName, `/tmp/${projectName}`);
		projectId = project.id;
		await saveProvider({
			id: "e2e-lag-smoke-provider",
			name: "E2E Lag Smoke",
			slug: "e2e-lag-smoke",
			baseUrl: "http://localhost:9999/v1",
			apiKey: "sk-e2e",
			api: "openai-completions",
			models: [{ id: "smoke-model", contextWindow: 128000, maxTokens: 4096 }],
		});
	});

	async function enterSession(page: import("@playwright/test").Page, text: string): Promise<string> {
		await page.goto("/");
		await page.waitForTimeout(500);
		const sessionId = "s-e2e-lag-" + randomUUID().slice(0, 8);
		await createSessionViaPrompt(projectId, {
			agentName: "dev",
			text,
			model: "e2e-lag-smoke/smoke-model",
			sessionId,
		});
		await page.getByText(projectName).first().click();
		await page.getByTestId(`session-${sessionId}`).click();
		return sessionId;
	}

	async function waitHistoryReady(page: import("@playwright/test").Page, sessionId: string) {
		await page.evaluate(async (sid) => {
			const { useSessionStore } = await import("/src/store/session.ts");
			const deadline = Date.now() + 8000;
			while (useSessionStore.getState().historyLoadingBySession[sid]) {
				if (Date.now() > deadline) break;
				await new Promise((r) => setTimeout(r, 100));
			}
		}, sessionId);
	}

	test("修复①：流式中纯文本预览，停顿 50ms 后切换 markdown（真实浏览器）", async ({ page }) => {
		test.setTimeout(30_000);
		const sessionId = await enterSession(page, "降级冒烟");
		await waitHistoryReady(page, sessionId);

		// 模拟快速流式：每 15ms 一个 delta，持续 ~600ms（间隔 < 50ms 阈值 → 保持纯文本）
		await page.evaluate(async (sid) => {
			const { useSessionStore } = await import("/src/store/session.ts");
			const h = useSessionStore.getState().handleSDKEvent;
			h(sid, { event: { type: "message_start", message: { role: "assistant", content: [], model: "m", timestamp: Date.now() } }, agentName: "dev" } as any);
			const deadline = Date.now() + 600;
			let i = 0;
			while (Date.now() < deadline) {
				h(sid, { event: { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `片段${i++} **加粗**` } }, agentName: "dev" } as any);
				await new Promise((r) => setTimeout(r, 15));
			}
		}, sessionId);

		// 持续流式中：纯文本预览（不解析 markdown）
		await expect(page.getByTestId("text-block-plain").first()).toBeVisible({ timeout: 3000 });

		// 停顿 >50ms：应切回 markdown（修复①阈值 50ms；旧 500ms 时 300ms 内仍是纯文本）
		await page.waitForTimeout(300);
		await expect(page.getByTestId("text-block").first()).toBeVisible({ timeout: 3000 });
		const md = page.getByTestId("text-block").first();
		await expect(md.locator("strong").first()).toBeVisible();
		expect(await page.getByTestId("text-block-plain").count()).toBe(0);
	});

	test("修复①：thinking 流式中不跑 Linkify，停顿后恢复链接", async ({ page }) => {
		test.setTimeout(30_000);
		const sessionId = await enterSession(page, "thinking 降级冒烟");
		await waitHistoryReady(page, sessionId);

		// 「回复过程默认折叠」开启时 thinking body 不渲染，先关掉
		await page.evaluate(() => {
			import("/src/store/ui-prefs.ts").then((m) =>
				m.useUiPrefsStore.setState({ collapseProcessByDefault: false }),
			);
		});
		await page.evaluate(async (sid) => {
			const { useSessionStore } = await import("/src/store/session.ts");
			const h = useSessionStore.getState().handleSDKEvent;
			h(sid, { event: { type: "message_start", message: { role: "assistant", content: [], model: "m", timestamp: Date.now() } }, agentName: "dev" } as any);
			const deadline = Date.now() + 500;
			let i = 0;
			while (Date.now() < deadline) {
				h(sid, { event: { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: `思考 see http://localhost:9${i}/ ok ` } }, agentName: "dev" } as any);
				await new Promise((r) => setTimeout(r, 15));
			}
		}, sessionId);

		// 流式中：thinking 卡片存在且无链接（跳过 Linkify）
		const body = page.getByTestId("thinking-panel-body").first();
		await expect(body).toBeVisible({ timeout: 3000 });
		await expect(body.locator("a")).toHaveCount(0);

		// 停顿后：Linkify 恢复
		await page.waitForTimeout(300);
		await expect(page.getByTestId("thinking-panel-body").first().locator("a").first()).toBeVisible({ timeout: 3000 });
	});

	test("修复②③：工具循环（连续 message_end+touchSession）无秒级主线程长任务", async ({ page }) => {
		test.setTimeout(30_000);
		const sessionId = await enterSession(page, "工具循环冒烟");
		await waitHistoryReady(page, sessionId);

		// 挂 longtask 观察器（>50ms 的主线程任务）
		await page.evaluate(() => {
			(window as any).__lagTasks = [];
			new PerformanceObserver((list: PerformanceObserverEntryList) => {
				for (const e of list.getEntries()) (window as any).__lagTasks.push(e.duration);
			}).observe({ entryTypes: ["longtask"] });
		});

		// 复现 trace 场景：15 轮工具循环（toolCall + 流式片段 + message_end 定稿 touchSession）
		// 修复前 trace 实测此负载产生 300-593ms 长任务、主线程连续 5 秒占满。
		await page.evaluate(async (sid) => {
			const { useSessionStore } = await import("/src/store/session.ts");
			const h = useSessionStore.getState().handleSDKEvent;
			for (let round = 0; round < 15; round++) {
				h(sid, { event: { type: "message_start", message: { role: "assistant", content: [], model: "m", timestamp: Date.now() } }, agentName: "dev" } as any);
				for (let i = 0; i < 8; i++) {
					h(sid, { event: { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `轮${round} 片段${i} ` } }, agentName: "dev" } as any);
					await new Promise((r) => setTimeout(r, 10));
				}
				h(sid, { event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `第 ${round} 轮回复完成` }] }, model: "m", stopReason: "end_turn", timestamp: Date.now() }, agentName: "dev" } as any);
				await new Promise((r) => setTimeout(r, 80));
			}
		}, sessionId);
		await page.waitForTimeout(500);

		const tasks = await page.evaluate(() => (window as any).__lagTasks as number[]);
		const worst = Math.max(0, ...tasks);
		console.log(`[smoke] longtasks=${tasks.length} worst=${worst.toFixed(0)}ms`);
		console.log();
		// 修复前：300-593ms（trace 实测）；修复后：dev 模式下也不应出现秒级/半秒级任务
		// 阈值 250ms：留足 dev 模式（jsx-dev-runtime 等开销）余量，同时能抓住「整树连坐」回归
		expect(worst, `最大长任务 ${worst.toFixed(0)}ms（全部: ${tasks.map((t) => t.toFixed(0)).join(",")}）`).toBeLessThan(250);
	});
});
