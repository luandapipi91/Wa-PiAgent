// 用户气泡渲染回归 E2E：气泡内只应有消息原文。
// 事故（2026-09-10）：MessageList.tsx 里 `// pi-lens-ignore: dangerously-set-inner-html`
// 被写进了 JSX children 区（而非开标签属性区），React 把它当文本节点渲染 →
// **每一条**用户气泡顶部都多出一行注释文本，用户误以为「发出去的消息里多了东西」
// （实际落库的原文干净，见 kernel 侧 session jsonl）。
// 本用例在真实浏览器里断言：气泡文本 == 原文，聊天区不含该注释文本。
import { test, expect } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_WA_PI_DIR } from "../playwright.config";
import { saveProvider } from "./helpers";

function seedSession(sessionId: string, title: string) {
	const projPath = join(E2E_WA_PI_DIR, "projects.json");
	const data = JSON.parse(readFileSync(projPath, "utf8")) as {
		sessions: Array<{ id: string }>;
	};
	if (!data.sessions.some((s) => s.id === sessionId)) {
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
	writeFileSync(
		join(E2E_WA_PI_DIR, "sessions", `${sessionId}.jsonl`),
		JSON.stringify({ type: "session", version: 3, id: `uuid-${sessionId}` }),
		"utf8",
	);
}

test("用户气泡只渲染消息原文，不含 pi-lens 抑制指令", async ({ page }) => {
	test.setTimeout(90_000);
	const sid = "s-e2e-bubble-render";
	seedSession(sid, "E2E气泡渲染");
	await saveProvider({
		id: "e2e-bubble-provider",
		name: "E2E Bubble",
		slug: "e2e-bubble",
		baseUrl: "http://localhost:9999/v1",
		apiKey: "sk-e2e",
		api: "openai-completions",
		models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
	});
	await page.goto("/");
	await expect(page.getByTestId(`session-${sid}`)).toBeVisible({
		timeout: 15_000,
	});
	await page.getByTestId(`session-${sid}`).click();
	await expect(page.getByTestId("session-view")).toBeVisible({
		timeout: 10_000,
	});
	await page
		.getByTestId("model-selector")
		.selectOption({ label: "E2E Bubble/model-a" });

	const composerBox = page.locator(
		'[data-testid="composer-input"] [role="textbox"]',
	);
	await composerBox.fill("编辑一下");
	await page.getByTestId("composer-send").click();

	// 等用户消息上屏（乐观渲染，不依赖 LLM 响应）
	await expect
		.poll(
			async () =>
				await page.evaluate(
					() => document.querySelector('[data-testid^="msg-"] p')?.textContent ?? "",
				),
			{ timeout: 20_000 },
		)
		.toContain("编辑一下");

	const shot = await page.evaluate(() => {
		const bubbles = [...document.querySelectorAll('[data-testid^="msg-"] p')].map(
			(p) => (p.parentElement as HTMLElement).textContent ?? "",
		);
		return {
			bubbles,
			listText:
				document.querySelector('[data-testid="message-list"]')?.textContent ?? "",
		};
	});
	// 气泡文本 == 原文（气泡容器内不得出现任何附加文本节点）
	expect(shot.bubbles.some((t) => t.trim() === "编辑一下")).toBe(true);
	expect(shot.listText).not.toContain("pi-lens-ignore");
	expect(shot.listText).not.toContain("dangerously-set-inner-html");
});
