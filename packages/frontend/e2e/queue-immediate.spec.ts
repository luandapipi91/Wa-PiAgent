// 队列「立即」E2E：运行中的排队消息可以直接点「立即」——真实浏览器 + 真实前端链路。
//
// 用户报告的缺陷（2026-11-18）：
//   运行中排队消息行里没有「立即」按钮，提示写着「停止当前后可点击立即」；可「停止」
//   当时的语义是「中断 + 丢弃全部排队」，停完队列连要立即执行的那条一起没了，
//   界面上写的那条操作路径根本走不通。
//
// 期望（用户拍板）：
//   ★ 运行中点「立即」可用 → 发出「立即执行」请求（该条马上跑）；
//   ★ 「停止」不再丢队列：只中断当前轮，排队消息仍可操作；
//   ★ 提示不再教用户「先停止」。
//
// 状态构造：SSE 帧注入（window.__PI_E2E_EVENT__，与真实 SSE 同一条 dispatch 主路径）
// 把前端置于「运行中 + 有排队消息」。不用挂住的假 provider 造运行态——pi 侧会自动
// 超时重试，状态不稳定、用例 flaky。kernel 侧「中断后其余排队继续按序发出 / 停止不丢
// 队列 / 清空才丢队列」的真实语义由 tests/queue-immediate.test.ts 与路由测试覆盖。
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createProject, saveProvider, setUiPrefs, selectModel } from "./helpers";

const INPUT = '[data-testid="composer-input"] [role="textbox"]';

/** 注入一帧 SSE 事件（与 kernel 广播同构） */
async function emit(page: Page, event: Record<string, unknown>) {
	await page.evaluate((e) => {
		const fn = (window as any).__PI_E2E_EVENT__;
		if (!fn) throw new Error("__PI_E2E_EVENT__ 未挂载（非 dev 环境？）");
		fn(e);
	}, event);
}

/** 建项目 → 建会话（真实 REST）→ 打开该会话，返回 sessionId */
async function openSession(page: Page, projectName: string): Promise<string> {
	const project = await createProject(projectName, `/tmp/${projectName}`);
	await setUiPrefs(page, "zh");
	await page.goto("/");
	await expect(page.getByTestId("new-session-pane")).toBeVisible({
		timeout: 10_000,
	});
	await page.getByTestId("project-select").selectOption(project.id);
	await selectModel(page, { label: "E2E Queue/model-a" });

	// 用一条消息建出会话（provider 指向不可达端口 → 立刻失败结束，不会长跑）
	const first = `建会话-${randomUUID().slice(0, 8)}`;
	await page.locator(INPUT).fill(first);
	await page.getByTestId("composer-send").click();
	await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 15_000 });

	const sessionId = await page
		.locator("[data-testid^='msg-']")
		.first()
		.getAttribute("data-testid")
		.then((v) => v!.replace(/^msg-/, "").replace(/-\d+$/, ""));
	if (!sessionId) throw new Error("未能解析当前会话 id");
	return sessionId;
}

/** 构造「运行中 + 两条排队消息」的确定状态 */
async function seedRunningWithQueue(
	page: Page,
	sessionId: string,
	items: string[],
) {
	await emit(page, {
		type: "sdk:event",
		sessionId,
		event: { type: "agent_start" },
	});
	await emit(page, {
		type: "sdk:event",
		sessionId,
		event: { type: "queue_update", steering: [], followUp: items },
	});
	await expect(page.getByTestId("queue-panel")).toContainText(items[0]!, {
		timeout: 10_000,
	});
}

test.describe.serial("队列「立即」", () => {
	test.beforeAll(async () => {
		// 预置 provider：规避首启 onboarding 向导拦截点击
		await saveProvider({
			id: "e2e-queue-provider",
			name: "E2E Queue",
			slug: "e2e_queue",
			baseUrl: "http://localhost:9999/v1",
			apiKey: "sk-e2e",
			api: "openai-completions",
			models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
		});
	});

	test("运行中：排队消息显示可点的「立即」，不再是「先停止」的死路", async ({
		page,
	}) => {
		test.setTimeout(120_000);
		const slug = randomUUID().slice(0, 8);
		const sessionId = await openSession(page, `e2e-queue-a-${slug}`);
		const queued = `排队消息-${slug}`;
		await seedRunningWithQueue(page, sessionId, [queued]);

		// ★ 运行中必须能看到「立即」按钮且可点（改动前该按钮被条件渲染隐藏）
		const immediate = page.getByTestId("btn-immediate").first();
		await expect(immediate).toBeVisible({ timeout: 10_000 });
		await expect(immediate).toBeEnabled();
		// 提示里不再教用户「先停止」（停止已不丢队列，这句话本身就是缺陷源头）
		await expect(page.getByTestId("queue-panel")).not.toContainText(
			"停止当前后可点击",
		);
	});

	test("运行中点「立即」：发出立即执行请求，该条从排队区消失", async ({
		page,
	}) => {
		test.setTimeout(120_000);
		const slug = randomUUID().slice(0, 8);
		const sessionId = await openSession(page, `e2e-queue-b-${slug}`);
		const keep = `保留项-${slug}`;
		const go = `立即项-${slug}`;

		// 拦截「立即执行」请求：断言前端真的发起了该动作（不依赖真实 LLM 跑起来）
		let immediateBody: any = null;
		await page.route("**/api/sessions/*/steer/immediate", async (route) => {
			immediateBody = JSON.parse(route.request().postData() || "{}");
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ ok: true }),
			});
		});

		await seedRunningWithQueue(page, sessionId, [keep, go]);
		await expect(page.getByTestId("queue-panel")).toContainText(go);

		// 点第二条（立即项）的「立即」
		await page.getByTestId("btn-immediate").nth(1).click();

		// ★ 前端发出了「立即执行」请求，且带的是被点的那条
		await expect
			.poll(() => immediateBody, { timeout: 10_000 })
			.toEqual({ text: go });
		// ★ 该条已从排队区移出（要马上去跑了）；其余排队消息仍在
		await expect(page.getByTestId("queue-panel")).not.toContainText(go, {
			timeout: 10_000,
		});
		await expect(page.getByTestId("queue-panel")).toContainText(keep);
	});

	test("点「停止」只中断当前轮，排队消息保留在面板里", async ({ page }) => {
		test.setTimeout(120_000);
		const slug = randomUUID().slice(0, 8);
		const sessionId = await openSession(page, `e2e-queue-c-${slug}`);
		const queued = `停止后应保留-${slug}`;

		let abortCalled = false;
		await page.route("**/api/agents/**/abort", async (route) => {
			abortCalled = true;
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ ok: true }),
			});
		});

		await seedRunningWithQueue(page, sessionId, [queued]);
		await page.getByTestId("btn-stop").click();

		// ★ 停止请求发出
		await expect.poll(() => abortCalled, { timeout: 10_000 }).toBe(true);

		// 模拟 kernel 的停止结算：思考态结束（agent_end + agent_settled），
		// 但队列保留（这是 kernel 侧新语义，真实行为由 kernel 单测覆盖）
		await emit(page, {
			type: "sdk:event",
			sessionId,
			event: { type: "agent_end", synthetic: true },
		});
		await emit(page, {
			type: "sdk:event",
			sessionId,
			event: { type: "agent_settled" },
		});

		// ★ 停止不再丢队列：消息仍在排队面板里，用户还能对它点「立即」
		await expect(page.getByTestId("queue-panel-content")).toContainText(
			queued,
			{ timeout: 10_000 },
		);
		await expect(page.getByTestId("btn-immediate").first()).toBeEnabled();
	});
});
