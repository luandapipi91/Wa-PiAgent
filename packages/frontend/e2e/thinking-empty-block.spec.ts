// 空思考块渲染 E2E（第四层）：真实浏览器 + 真实 kernel（隔离 WA_PI_DIR）。
//
// 背景：pi 侧会产出 thinking 正文为空、但带 thinkingSignature 的 thinking 块
// （实测近期真实会话占比 9~15%）。用户报告「经常出现空的思考」——空块照常入场时
// 会渲染成一张标题「思考过程」、正文全空的卡片（截图现象）。
// 契约：空正文 thinking 块不进入渲染流（与空 text 块同规则），有正文的照常成卡。
//
// 数据准备：projects.json 写入会话记录（复用 ask-stale.spec 模式）；
// /messages 响应用 page.route 注入「含空正文 thinking 块 + 有正文 thinking 块」的
// assistant 消息（isActive: true → 进行中的轮，走非折叠渲染路径，卡片真实挂载）。
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_WA_PI_DIR } from "../playwright.config";
import { saveProvider } from "./helpers";

const SESSION_ID = "s-e2e-empty-thinking-001";

function seedSession() {
	const projPath = join(E2E_WA_PI_DIR, "projects.json");
	const data = JSON.parse(readFileSync(projPath, "utf8"));
	if (!data.sessions.some((s: any) => s.id === SESSION_ID)) {
		data.sessions.push({
			id: SESSION_ID,
			projectId: "e2e-proj-1",
			primaryAgent: "dev",
			title: "E2E空思考块",
			createdAt: 1,
			lastActivity: 1,
			piSessionFile: join(E2E_WA_PI_DIR, "sessions", `${SESSION_ID}.jsonl`),
		});
		writeFileSync(projPath, JSON.stringify(data, null, 2), "utf8");
	}
	mkdirSync(join(E2E_WA_PI_DIR, "sessions"), { recursive: true });
	writeFileSync(
		join(E2E_WA_PI_DIR, "sessions", `${SESSION_ID}.jsonl`),
		JSON.stringify({ type: "session", version: 3, id: "e2e-empty-thinking" }) +
			"\n",
		"utf8",
	);
}

/** 拦截 /messages：一条 assistant 消息 = 空正文 thinking 块 + 有正文 thinking 块 + 正文 */
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
								{ type: "thinking", thinking: "", thinkingSignature: "sig-empty" },
								{ type: "thinking", thinking: "先看代码结构再动手" },
								{ type: "text", text: "正文照常渲染" },
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
		id: "e2e-empty-thinking-provider",
		name: "E2E EmptyThinking",
		slug: "e2e-empty-thinking",
		baseUrl: "http://localhost:9999/v1",
		apiKey: "sk-e2e",
		api: "openai-completions",
		models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
	});
});

test("含空正文 thinking 块的消息：真实浏览器里只渲染有正文的那张思考卡", async ({
	page,
}) => {
	seedSession();
	await injectMessages(page);

	await page.goto("/");
	const row = page.getByTestId(`session-${SESSION_ID}`);
	await expect(row).toBeVisible({ timeout: 10_000 });
	await row.click();
	await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 10_000 });

	// 正文照常渲染（证明消息已上屏，不是整体没渲染）
	await expect(page.getByText("正文照常渲染")).toBeVisible({ timeout: 10_000 });

	// 思考卡只有 1 张（空正文块被过滤）；修复前为 2 张（含一张正文全空的卡）
	await expect(page.getByTestId("thinking-panel")).toHaveCount(1);

	// 展开有正文的那张卡：正文可见（证明确实是「有正文」那张，而不是碰巧留下的空块）
	await page.getByTestId("thinking-panel-header").click();
	await expect(page.getByTestId("thinking-panel-body")).toBeVisible();
	await expect(page.getByTestId("thinking-panel-body")).toContainText(
		"先看代码结构再动手",
	);
});
