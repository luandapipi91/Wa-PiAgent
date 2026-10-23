// 思考过程 Markdown 渲染 E2E（第四层）：真实浏览器 + 真实 kernel（隔离 WA_PI_DIR）。
//
// 背景：ThinkingCard 此前用纯文本 + Linkify 渲染，模型思考内容里的 markdown（**粗体**、
// 反引号代码、列表）原样显示为标记。契约：思考过程正文与聊天正文一致走 Markdown 渲染，
// 原始标记不泄漏到可见文本。
//
// 数据准备：projects.json 写入会话记录；/messages 响应用 page.route 注入含 markdown 的
// thinking 块（isActive: true → 进行中的轮，思考卡默认展开，无需先展开轮级摘要）。
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_WA_PI_DIR } from "../playwright.config";
import { saveProvider } from "./helpers";

const SESSION_ID = "s-e2e-thinking-markdown-001";

const THINKING_MD = [
	"**关键矛盾**：`root/inst/vnode` 都是 true",
	"",
	"**如果 4 份页面全部保留**，heap 应该 +50MB。",
	"",
	"说明：",
	"",
	"- 第一点",
	"",
	"- 第二点",
].join("\n");

// 聊天正文对照素材：正文的段间距是既有排版，本次改动不得波及（两段正文）
const TEXT_MD = "正文第一段。\n\n正文第二段。";

function seedSession() {
	const projPath = join(E2E_WA_PI_DIR, "projects.json");
	const data = JSON.parse(readFileSync(projPath, "utf8"));
	if (!data.sessions.some((s: any) => s.id === SESSION_ID)) {
		data.sessions.push({
			id: SESSION_ID,
			projectId: "e2e-proj-1",
			primaryAgent: "dev",
			title: "E2E思考Markdown",
			createdAt: 1,
			lastActivity: 1,
			piSessionFile: join(E2E_WA_PI_DIR, "sessions", `${SESSION_ID}.jsonl`),
		});
		writeFileSync(projPath, JSON.stringify(data, null, 2), "utf8");
	}
	mkdirSync(join(E2E_WA_PI_DIR, "sessions"), { recursive: true });
	writeFileSync(
		join(E2E_WA_PI_DIR, "sessions", `${SESSION_ID}.jsonl`),
		JSON.stringify({ type: "session", version: 3, id: "e2e-thinking-md" }) + "\n",
		"utf8",
	);
}

async function injectMessages(page: Page) {
	await page.route(`**/api/sessions/${SESSION_ID}/messages`, (route) =>
		route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({
				type: "session:messages",
				sessionId: SESSION_ID,
				messages: [
					{
						message: {
							role: "assistant",
							content: [
								{ type: "thinking", thinking: THINKING_MD },
								{ type: "text", text: TEXT_MD },
							],
							model: "m",
							stopReason: "stop",
							timestamp: 1,
						},
						agentName: "dev",
					},
				],
				isActive: true,
				thinkingSince: null,
			}),
		}),
	);
}

test.beforeAll(async () => {
	// 无供应商时 App 会自动弹出 onboarding 向导挡住点击，预置假 provider 规避
	await saveProvider({
		id: "e2e-thinking-md-provider",
		name: "E2E ThinkingMarkdown",
		slug: "e2e-thinking-md",
		baseUrl: "http://localhost:9999/v1",
		apiKey: "sk-e2e",
		api: "openai-completions",
		models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
	});
});

test("思考过程按 Markdown 渲染：粗体 / 行内代码 / 列表，原始标记不泄漏", async ({
	page,
}) => {
	seedSession();
	await injectMessages(page);

	await page.goto("/");
	const row = page.getByTestId(`session-${SESSION_ID}`);
	await expect(row).toBeVisible({ timeout: 10_000 });
	await row.click();
	await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 10_000 });

	// 正文上屏（证明消息已渲染，不是整体空白）
	await expect(page.getByText("正文第一段。")).toBeVisible({ timeout: 10_000 });

	// 「回复过程默认折叠」开启时 thinking body 不渲染，先展开卡片
	await page.getByTestId("thinking-panel-header").first().click();
	const body = page.getByTestId("thinking-panel-body").first();
	await expect(body).toBeVisible({ timeout: 10_000 });
	// 加粗 → <strong>，行内代码 → <code>，列表 → <li>
	await expect(body.locator("strong").first()).toHaveText("关键矛盾");
	await expect(body.locator("code")).toHaveText("root/inst/vnode");
	await expect(body.locator("li")).toHaveCount(2);
	// 原始标记不得出现在可见文本里
	const text = (await body.textContent()) ?? "";
	expect(text).not.toContain("**");
	expect(text).not.toContain("`");
});

test("思考过程排版紧凑：段间距与列表项高度贴紧（不出现大段空白）", async ({
	page,
}) => {
	seedSession();
	await injectMessages(page);

	await page.goto("/");
	await page.getByTestId(`session-${SESSION_ID}`).click();
	await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 10_000 });
	await page.getByTestId("thinking-panel-header").first().click();
	const body = page.getByTestId("thinking-panel-body").first();
	await expect(body).toBeVisible({ timeout: 10_000 });
	await page.waitForTimeout(300);

	const metrics = await body.evaluate((el) => {
		const ps = Array.from(el.querySelectorAll("p")).map((p) =>
			p.getBoundingClientRect(),
		);
		const lis = Array.from(el.querySelectorAll("li")).map((li) => {
			const r = li.getBoundingClientRect();
			return { top: Math.round(r.top), height: Math.round(r.height) };
		});
		return {
			paragraphGap: ps.length > 1 ? Math.round(ps[1].top - ps[0].bottom) : null,
			liGap: lis.length > 1 ? lis[1].top - (lis[0].top + lis[0].height) : null,
			liHeights: lis.map((l) => l.height),
		};
	});

	// 段与段之间只允许留一行以内的呼吸空间（修复前 typography 上下各 16px）
	expect(metrics.paragraphGap).not.toBeNull();
	expect(metrics.paragraphGap!).toBeLessThanOrEqual(10);
	// 列表项之间同样贴紧
	if (metrics.liGap != null) expect(metrics.liGap).toBeLessThanOrEqual(10);
	// 每个列表项高度 ≈ 单行（修复前 loose list 内源码换行被 pre-wrap 保留，撑到 ~50px+）
	for (const h of metrics.liHeights) expect(h).toBeLessThanOrEqual(28);

	// 反向对照：聊天正文的段间距仍是既有排版（实测 16px，改动不得波及全局 markdown）
	const textGap = await page.getByTestId("text-block").first().evaluate((el) => {
		const ps = Array.from(el.querySelectorAll("p"));
		return ps.length > 1
			? Math.round(
					ps[1].getBoundingClientRect().top -
						ps[0].getBoundingClientRect().bottom,
				)
			: null;
	});
	expect(textGap).not.toBeNull();
	expect(textGap!).toBeGreaterThanOrEqual(14);
});
