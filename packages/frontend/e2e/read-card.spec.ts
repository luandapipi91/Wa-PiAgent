// read 工具卡片（渐进摘要）E2E（第四层）：真实浏览器 + 真实 kernel。
//
// 验证方案 B：
// 1. 折叠态标题带动作词「读取」+ 文件名 + 行范围；
// 2. 展开后只给 6 行预览 + 「展开其余 N 行」；
// 3. 点击展开后显示全部行（限高滚动），按钮变「收起」；
// 4. 截断状态外显（10 / 1850），正文里的 [Showing lines ...] 不再重复渲染。
//
// 数据准备复用 ask-stale.spec 模式：projects.json 落一条会话记录，
// /messages 用 page.route 注入 assistant(toolCall read) + toolResult(截断提示 + details.truncation)。
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_WA_PI_DIR } from "../playwright.config";
import { saveProvider } from "./helpers";

const SESSION_ID = "s-e2e-read-card-001";
const TOOLCALL_ID = "tc-e2e-read-1";
const FILE_PATH = "logs/agent-crash.log";

const BODY_LINES = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
const RESULT_TEXT = `${BODY_LINES.join("\n")}\n\n[Showing lines 1-10 of 1850. Use offset=11 to continue.]`;

function seedSession() {
	const projPath = join(E2E_WA_PI_DIR, "projects.json");
	const data = JSON.parse(readFileSync(projPath, "utf8"));
	if (!data.sessions.some((s: any) => s.id === SESSION_ID)) {
		data.sessions.push({
			id: SESSION_ID,
			projectId: "e2e-proj-1",
			primaryAgent: "dev",
			title: "E2E read 卡片",
			createdAt: 1,
			lastActivity: 1,
			piSessionFile: join(E2E_WA_PI_DIR, "sessions", `${SESSION_ID}.jsonl`),
		});
		writeFileSync(projPath, JSON.stringify(data, null, 2), "utf8");
	}
	mkdirSync(join(E2E_WA_PI_DIR, "sessions"), { recursive: true });
	writeFileSync(
		join(E2E_WA_PI_DIR, "sessions", `${SESSION_ID}.jsonl`),
		JSON.stringify({ type: "session", version: 3, id: "e2e-read-card-uuid" }) + "\n",
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
								{
									type: "toolCall",
									id: TOOLCALL_ID,
									name: "read",
									arguments: {
										path: FILE_PATH,
										offset: 1,
										limit: 200,
									},
								},
							],
							model: "m",
							stopReason: "tool_use",
							timestamp: 1,
						},
						agentName: "dev",
					},
					{
						message: {
							role: "toolResult",
							toolCallId: TOOLCALL_ID,
							toolName: "read",
							content: [{ type: "text", text: RESULT_TEXT }],
							details: {
								truncation: {
									truncated: true,
									outputLines: 10,
									totalLines: 1850,
								},
							},
							isError: false,
							timestamp: 2,
						},
						agentName: "dev",
					},
				],
				isActive: false,
				thinkingSince: null,
			}),
		}),
	);
}

test.describe.serial("read 卡片渐进摘要", () => {
	test.beforeAll(async () => {
		await saveProvider({
			id: "e2e-read-card-provider",
			name: "E2E ReadCard",
			slug: "e2e-read-card",
			baseUrl: "http://localhost:9999/v1",
			apiKey: "sk-e2e",
			api: "openai-completions",
			models: [{ id: "e2e-model", contextWindow: 8000, maxTokens: 1000 }],
		});
	});

	test("标题/6 行预览/展开全部/截断提示", async ({ page }) => {
		seedSession();
		await injectMessages(page);

		await page.goto("/");
		const row = page.getByTestId(`session-${SESSION_ID}`);
		await expect(row).toBeVisible({ timeout: 10_000 });
		await row.click();
		await expect(page.getByTestId("session-view")).toBeVisible({
			timeout: 10_000,
		});

		// 回合结束后「本轮过程」默认折叠 → 先展开过程列表
		await page.getByTestId("turn-summary").click();
		const card = page.getByTestId(`toolcall-${TOOLCALL_ID}`);
		await expect(card).toBeVisible({ timeout: 10_000 });

		// 1. 标题：动作词 + 文件名 + 行范围
		await expect(card).toContainText(/读取|Read/);
		await expect(card).toContainText("agent-crash.log");
		await expect(card).toContainText("1");
		await expect(card).toContainText("200");

		// 2. 完成后默认折叠 → 展开
		await page.getByTestId(`toolcall-${TOOLCALL_ID}-header`).click();
		const body = page.getByTestId(`toolcall-${TOOLCALL_ID}-body`);
		await expect(body).toBeVisible();

		// 3. 默认 6 行预览 + 展开按钮
		await expect(body.getByTestId("read-line")).toHaveCount(6);
		const toggle = page.getByTestId(`toolcall-${TOOLCALL_ID}-read-toggle`);
		await expect(toggle).toContainText("4");

		// 4. 点击展开 → 全部 10 行，按钮变「收起」
		await toggle.click();
		await expect(body.getByTestId("read-line")).toHaveCount(10);
		await expect(toggle).toContainText(/收起|Collapse/);

		// 5. 截断状态外显；正文提示不重复渲染
		const truncated = page.getByTestId(`toolcall-${TOOLCALL_ID}-read-truncated`);
		await expect(truncated).toContainText("10");
		await expect(truncated).toContainText("1850");
		await expect(body).not.toContainText("Showing lines");

		await card.screenshot({
			path: join(process.env.TEMP || "/tmp", `read-card-${Date.now()}.png`),
		});
	});
});
