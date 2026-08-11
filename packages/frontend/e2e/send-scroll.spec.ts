// 发送消息自动滚动 E2E（回归验证：发送消息不自动滚到底）
// 场景 A：进入会话后立即发送 → 用户消息可见且贴底（曾 1/3 偶发失败）
// 场景 B：用户上翻（离开底部）后发送 → 恢复贴底、新消息可见
// 场景 C：发送 + 流式回复过程持续跟随到底
import { test, expect } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_WA_PI_DIR } from "../playwright.config";
import { saveProvider } from "./helpers";

function seedLongSession(sessionId: string, title: string) {
	const projPath = join(E2E_WA_PI_DIR, "projects.json");
	const data = JSON.parse(readFileSync(projPath, "utf8"));
	if (!data.sessions.some((s: any) => s.id === sessionId)) {
		data.sessions.push({
			id: sessionId,
			projectId: "e2e-proj-1",
			primaryAgent: "dev",
			title,
			createdAt: 1,
			lastActivity: 1,
			piSessionFile: join(E2E_WA_PI_DIR, "sessions", `${sessionId}.jsonl`),
		});
		writeFileSync(projPath, JSON.stringify(data, null, 2), "utf8");
	}
	mkdirSync(join(E2E_WA_PI_DIR, "sessions"), { recursive: true });
	const line = (id: string, parentId: string | null, role: string, text: string, ts: number) =>
		JSON.stringify({
			type: "message",
			id,
			parentId,
			message: { role, content: [{ type: "text", text }], timestamp: ts },
		});
	const lines: string[] = [JSON.stringify({ type: "session", version: 3, id: `uuid-${sessionId}` })];
	let id = 1;
	let parentId: string | null = null;
	for (let i = 0; i < 60; i++) {
		const uId = `m${id++}`;
		lines.push(line(uId, parentId, "user", `这是第 ${i + 1} 个用户问题，用于测试发送消息后的自动滚动定位。`, i * 2 + 1));
		parentId = uId;
		const aId = `m${id++}`;
		lines.push(line(aId, parentId, "assistant", `回答 ${i + 1}：这是一段较长的助手回复正文，确保整体内容高度显著超过浏览器视口。当前是第 ${i + 1} 轮。`, i * 2 + 2));
		parentId = aId;
	}
	writeFileSync(join(E2E_WA_PI_DIR, "sessions", `${sessionId}.jsonl`), lines.join("\n"), "utf8");
}

async function scrollMetrics(page: import("@playwright/test").Page) {
	return page.evaluate(() => {
		const el = document.querySelector('[data-testid="message-list"]') as HTMLElement | null;
		if (!el) return null;
		return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, dist: Math.round(el.scrollHeight - el.clientHeight - el.scrollTop) };
	});
}
async function scrollTo(page: import("@playwright/test").Page, top: number) {
	await page.locator('[data-testid="message-list"]').evaluate((el, t) => {
		el.scrollTop = t;
		el.dispatchEvent(new Event("scroll", { bubbles: true }));
	}, top);
}

test.describe("发送消息自动滚动", () => {
	test.beforeEach(async () => {
		await saveProvider({
			id: "e2e-send-scroll-provider",
			name: "E2E SendScroll",
			slug: "e2e-send-scroll",
			baseUrl: "http://localhost:9999/v1",
			apiKey: "sk-e2e",
			api: "openai-completions",
			models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
		});
	});

	test("A: 进入会话后立即发送 → 用户消息可见且贴底", async ({ page }) => {
		test.setTimeout(90_000);
		const sid = "s-e2e-sendscroll-a";
		seedLongSession(sid, "E2E发送滚动A");
		await page.goto("/");
		await page.getByTestId(`session-${sid}`).click();
		await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 10_000 });
		// 不等历史渲染，尽快发送（复刻进入定位竞态）
		await page.getByTestId("model-selector").selectOption({ label: "E2E SendScroll/model-a" });
		await page.locator('[data-testid="composer-input"] [role="textbox"]').fill("立即发送测试");
		await page.getByTestId("composer-send").click();
		await expect(page.getByText("立即发送测试").first()).toBeVisible({ timeout: 8000 });
		await expect.poll(async () => (await scrollMetrics(page))?.dist ?? 9999, { timeout: 8000 }).toBeLessThanOrEqual(40);
	});

	test("B: 用户上翻（离开底部）后发送 → 恢复贴底、新消息可见", async ({ page }) => {
		test.setTimeout(90_000);
		const sid = "s-e2e-sendscroll-b";
		seedLongSession(sid, "E2E发送滚动B");
		await page.goto("/");
		await page.getByTestId(`session-${sid}`).click();
		await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 10_000 });
		await expect(page.getByText("回答 60：")).toBeVisible({ timeout: 15_000 });
		await expect.poll(async () => (await scrollMetrics(page))?.dist ?? 9999, { timeout: 15_000 }).toBeLessThanOrEqual(40);

		// 上翻到顶部（stickBottom=false，浮钮出现）
		await scrollTo(page, 0);
		const floatBtn = page.getByTestId(`scroll-bottom-${sid}`);
		await expect(floatBtn).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("这是第 1 个用户问题")).toBeVisible({ timeout: 5000 });

		// 上翻状态发送 → 应恢复贴底、新消息可见、浮钮消失
		await page.getByTestId("model-selector").selectOption({ label: "E2E SendScroll/model-a" });
		await page.locator('[data-testid="composer-input"] [role="textbox"]').fill("上翻后发送测试");
		await page.getByTestId("composer-send").click();
		await expect(page.getByText("上翻后发送测试").first()).toBeVisible({ timeout: 8000 });
		await expect.poll(async () => (await scrollMetrics(page))?.dist ?? 9999, { timeout: 8000 }).toBeLessThanOrEqual(40);
		await expect(floatBtn).toBeHidden({ timeout: 5000 });
	});

	test("C: 发送 + 流式回复过程持续跟随到底", async ({ page }) => {
		test.setTimeout(120_000);
		const sid = "s-e2e-sendscroll-c";
		seedLongSession(sid, "E2E发送滚动C");
		await page.goto("/");
		await page.getByTestId(`session-${sid}`).click();
		await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 10_000 });
		await expect(page.getByText("回答 60：")).toBeVisible({ timeout: 15_000 });
		await expect.poll(async () => (await scrollMetrics(page))?.dist ?? 9999, { timeout: 15_000 }).toBeLessThanOrEqual(40);

		await page.getByTestId("model-selector").selectOption({ label: "E2E SendScroll/model-a" });
		await page.locator('[data-testid="composer-input"] [role="textbox"]').fill("流式跟随测试");
		await page.getByTestId("composer-send").click();
		await expect(page.getByText("流式跟随测试").first()).toBeVisible({ timeout: 8000 });

		// 注入流式回复
		await page.evaluate(async (sid) => {
			// @ts-expect-error — vite 运行时解析 /src/* 别名
			const { useSessionStore } = await import("/src/store/session.ts");
			const h = useSessionStore.getState().handleSDKEvent;
			h(sid, { event: { type: "agent_start" }, agentName: "dev" } as any);
			const now = Date.now();
			h(sid, { event: { type: "message_start", message: { role: "assistant", content: [], model: "m", timestamp: now } }, agentName: "dev" } as any);
			for (let i = 0; i < 30; i++) {
				h(sid, { event: { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `流式回复第 ${i + 1} 段，用于撑高内容验证滚动跟随。` } }, agentName: "dev" } as any);
				await new Promise((r) => setTimeout(r, 40));
			}
			h(sid, { event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "完整流式回复内容".repeat(8) }], model: "m", stopReason: "end_turn", timestamp: Date.now() } }, agentName: "dev" } as any);
			h(sid, { event: { type: "agent_end", willRetry: false }, agentName: "dev" } as any);
		}, sid);

		await expect(page.getByText("完整流式回复内容").first()).toBeVisible({ timeout: 8000 });
		await expect.poll(async () => (await scrollMetrics(page))?.dist ?? 9999, { timeout: 8000 }).toBeLessThanOrEqual(40);
	});
});
