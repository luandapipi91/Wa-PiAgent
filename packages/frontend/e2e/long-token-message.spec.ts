// 超长无空格字符串（base64 等）的用户消息折行 E2E 回归。
// 修复前：用户消息链路（行容器 → flex-col → 气泡 p）无 min-w-0 / overflow-wrap，
// 无空格长串不折行 → 内容宽度撑到几万 px，横向撑爆虚拟列表（窗口被撑爆）。
// 通过 UI 发送长串消息验证（乐观上屏，不依赖会话历史加载时序）。
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
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: `uuid-${sessionId}` }),
	];
	writeFileSync(
		join(E2E_WA_PI_DIR, "sessions", `${sessionId}.jsonl`),
		lines.join("\n"),
		"utf8",
	);
}

test("超长无空格字符串的用户消息 → 正常折行，不撑爆窗口", async ({ page }) => {
	test.setTimeout(90_000);
	const sid = "s-e2e-long-token-msg";
	seedSession(sid, "E2E长串消息折行");
	await saveProvider({
		id: "e2e-send-scroll-provider",
		name: "E2E SendScroll",
		slug: "e2e-send-scroll",
		baseUrl: "http://localhost:9999/v1",
		apiKey: "sk-e2e",
		api: "openai-completions",
		models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
	});
	await page.goto("/");
	// seed 运行时追加进 projects.json，kernel 靠文件 watcher 感知——等侧栏出现再点击
	await expect(page.getByTestId(`session-${sid}`)).toBeVisible({
		timeout: 15_000,
	});
	await page.getByTestId(`session-${sid}`).click();
	await expect(page.getByTestId("session-view")).toBeVisible({
		timeout: 10_000,
	});
	await page
		.getByTestId("model-selector")
		.selectOption({ label: "E2E SendScroll/model-a" });

	// 8000+ 字符的无空格 base64 串（模拟用户贴的长 token/编码内容）
	// 规模取 2000+ 字符：足以触发「无空格串不折行撑爆」（不折行时 ~1.4 万 px 宽），
	// 且避开 10 万级超长文本在前端处理链上的性能问题（那是独立问题）
	const longToken = Buffer.from(
		Array.from({ length: 300 }, (_, i) => `段${i}内容`).join(""),
	).toString("base64");
	const composerBox = page.locator(
		'[data-testid="composer-input"] [role="textbox"]',
	);
	await composerBox.fill(longToken);
	await page.getByTestId("composer-send").click();

	// 等待用户消息上屏（乐观渲染，不依赖 LLM 响应）
	await expect
		.poll(
			async () =>
				await page.evaluate(() => {
					const ps = [
						...document.querySelectorAll('[data-testid^="msg-"] p'),
					] as HTMLElement[];
					return ps.some((p) => (p.textContent ?? "").length > 1000);
				}),
			{ timeout: 20_000 },
		)
		.toBe(true);

	// 核心几何断言：气泡宽度被约束在列表视口内 + 列表无横向溢出。
	// 修复前气泡宽度 = 文本自然宽度（80 万 px），横向撑爆窗口。
	const layout = await page.evaluate(() => {
		const scroller = document.querySelector(
			'[data-testid="message-list"]',
		) as HTMLElement;
		const bubbles = [
			...scroller.querySelectorAll('[data-testid^="msg-"] p'),
		] as HTMLElement[];
		const longBubble = bubbles.find((b) => (b.textContent ?? "").length > 1000);
		return {
			horizontalOverflow: scroller.scrollWidth - scroller.clientWidth,
			bubbleWidth: longBubble
				? Math.round(longBubble.getBoundingClientRect().width)
				: null,
			listWidth: Math.round(scroller.clientWidth),
		};
	});
	expect(layout.bubbleWidth).not.toBeNull();
	expect(layout.horizontalOverflow).toBeLessThanOrEqual(1);
	expect(layout.bubbleWidth!).toBeLessThanOrEqual(layout.listWidth);
});
