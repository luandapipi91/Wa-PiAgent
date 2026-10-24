// write 卡片（渐进摘要）E2E（第四层）：真实浏览器 + 真实 kernel。
//
// 验证方案 B：
// 1. 折叠态标题带动作词「写入」+ 文件名；
// 2. 展开后只给 6 行预览 + 「展开其余 N 行」；
// 3. 点击展开后全部行可见，按钮变「收起」；
// 4. 成功文案（Successfully wrote to ...）不再平铺。
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_WA_PI_DIR } from "../playwright.config";
import { saveProvider, setUiPrefs } from "./helpers";

const SESSION_ID = "s-e2e-write-card-001";
const TOOLCALL_ID = "tc-e2e-write-1";
const FILE_PATH = ".superpowers/sdd/2026-10-24-image-annotation/progress.md";
const CONTENT = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");

function seedSession() {
	const projPath = join(E2E_WA_PI_DIR, "projects.json");
	const data = JSON.parse(readFileSync(projPath, "utf8"));
	if (!data.sessions.some((s: any) => s.id === SESSION_ID)) {
		data.sessions.push({
			id: SESSION_ID,
			projectId: "e2e-proj-1",
			primaryAgent: "dev",
			title: "E2E write 卡片",
			createdAt: 1,
			lastActivity: 1,
			piSessionFile: join(E2E_WA_PI_DIR, "sessions", `${SESSION_ID}.jsonl`),
		});
		writeFileSync(projPath, JSON.stringify(data, null, 2), "utf8");
	}
	mkdirSync(join(E2E_WA_PI_DIR, "sessions"), { recursive: true });
	writeFileSync(
		join(E2E_WA_PI_DIR, "sessions", `${SESSION_ID}.jsonl`),
		JSON.stringify({ type: "session", version: 3, id: "e2e-write-card-uuid" }) + "\n",
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
									name: "write",
									arguments: { path: FILE_PATH, content: CONTENT },
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
							toolName: "write",
							content: [{ type: "text", text: `Successfully wrote to ${FILE_PATH}` }],
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

test.describe.serial("write 卡片渐进摘要", () => {
	test.beforeAll(async () => {
		await saveProvider({
			id: "e2e-write-card-provider",
			name: "E2E WriteCard",
			slug: "e2e-write-card",
			baseUrl: "http://localhost:9999/v1",
			apiKey: "sk-e2e",
			api: "openai-completions",
			models: [{ id: "e2e-model", contextWindow: 8000, maxTokens: 1000 }],
		});
	});

	test("标题/6 行预览/展开全部/成功文案隐藏", async ({ page }) => {
		seedSession();
		await injectMessages(page);
		await setUiPrefs(page, "zh", { collapseProcessByDefault: false });

		await page.goto("/");
		const row = page.getByTestId(`session-${SESSION_ID}`);
		await expect(row).toBeVisible({ timeout: 10_000 });
		await row.click();
		await expect(page.getByTestId("session-view")).toBeVisible({
			timeout: 10_000,
		});

		// 回合结束后「本轮过程」默认折叠 → 先展开
		await page.getByTestId("turn-summary").click();
		const card = page.getByTestId(`toolcall-${TOOLCALL_ID}`);
		await expect(card).toBeVisible({ timeout: 10_000 });

		// 1. 标题
		await expect(card).toContainText(/写入|Write/);
		await expect(card).toContainText("progress.md");

		// 2. 展开：6 行预览 + 展开按钮
		await page.getByTestId(`toolcall-${TOOLCALL_ID}-header`).click();
		const body = page.getByTestId(`toolcall-${TOOLCALL_ID}-body`);
		await expect(body).toBeVisible();
		await expect(body.getByTestId("read-line")).toHaveCount(6);
		const toggle = page.getByTestId(`toolcall-${TOOLCALL_ID}-write-toggle`);
		await expect(toggle).toContainText("4");

		// 3. 展开全部
		await toggle.click();
		await expect(body.getByTestId("read-line")).toHaveCount(10);
		await expect(toggle).toContainText(/收起|Collapse/);

		// 4. 成功文案不平铺
		await expect(body).not.toContainText("Successfully wrote");
	});
});
