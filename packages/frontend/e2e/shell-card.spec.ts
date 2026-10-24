// shell（bash / powershell）终端卡 E2E（第四层）：真实浏览器 + 真实 kernel。
//
// 验证方案 A（终端卡）：
// 1. 折叠态标题带动作词「执行」+ 命令 + shell 标签；
// 2. 展开后渲染终端块：提示符、命令、输出、退出码；
// 3. 失败时退出码从正文解析并外显，正文里的 Command exited 提示不重复渲染；
// 4. 明暗主题：终端块背景随主题切换（浅色 #f7f7f9 / 深色 #0f0f12）。
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_WA_PI_DIR } from "../playwright.config";
import { saveProvider, setUiPrefs } from "./helpers";

const SESSION_ID = "s-e2e-shell-card-001";
const TOOLCALL_ID = "tc-e2e-shell-1";

function seedSession() {
	const projPath = join(E2E_WA_PI_DIR, "projects.json");
	const data = JSON.parse(readFileSync(projPath, "utf8"));
	if (!data.sessions.some((s: any) => s.id === SESSION_ID)) {
		data.sessions.push({
			id: SESSION_ID,
			projectId: "e2e-proj-1",
			primaryAgent: "dev",
			title: "E2E shell 卡片",
			createdAt: 1,
			lastActivity: 1,
			piSessionFile: join(E2E_WA_PI_DIR, "sessions", `${SESSION_ID}.jsonl`),
		});
		writeFileSync(projPath, JSON.stringify(data, null, 2), "utf8");
	}
	mkdirSync(join(E2E_WA_PI_DIR, "sessions"), { recursive: true });
	writeFileSync(
		join(E2E_WA_PI_DIR, "sessions", `${SESSION_ID}.jsonl`),
		JSON.stringify({ type: "session", version: 3, id: "e2e-shell-card-uuid" }) + "\n",
		"utf8",
	);
}

async function injectMessages(page: Page, opts: { fail?: boolean } = {}) {
	const isError = !!opts.fail;
	const text = isError
		? "error TS2307: Cannot find module\n\nCommand exited with code 2"
		: "177 pass\n0 fail";
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
									name: "bash",
									arguments: {
										command: "bun test tests/a.test.ts",
										timeout: 300,
									},
								},
							],
							model: "m",
							stopReason: "tool_use",
							timestamp: 1000,
						},
						agentName: "dev",
					},
					{
						message: {
							role: "toolResult",
							toolCallId: TOOLCALL_ID,
							toolName: "bash",
							content: [{ type: "text", text }],
							isError,
							timestamp: 2600,
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

async function openCard(page: Page) {
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
	return card;
}

test.describe.serial("shell 终端卡", () => {
	test.beforeAll(async () => {
		await saveProvider({
			id: "e2e-shell-card-provider",
			name: "E2E ShellCard",
			slug: "e2e-shell-card",
			baseUrl: "http://localhost:9999/v1",
			apiKey: "sk-e2e",
			api: "openai-completions",
			models: [{ id: "e2e-model", contextWindow: 8000, maxTokens: 1000 }],
		});
	});

	test("浅色：标题/终端块/退出码", async ({ page }) => {
		seedSession();
		await injectMessages(page);
		await setUiPrefs(page, "zh", { collapseProcessByDefault: false });

		const card = await openCard(page);
		await expect(card).toContainText(/执行|Run/);
		await expect(card).toContainText("bun test");
		await expect(card).toContainText(/BASH/i);

		await page.getByTestId(`toolcall-${TOOLCALL_ID}-header`).click();
		const term = page.getByTestId(`toolcall-${TOOLCALL_ID}-shell`);
		await expect(term).toBeVisible();
		await expect(term).toContainText("$");
		await expect(term).toContainText("177 pass");
		await expect(page.getByTestId(`toolcall-${TOOLCALL_ID}-exit`)).toContainText("0");
		await expect(
			page.getByTestId(`toolcall-${TOOLCALL_ID}-shell-duration`),
		).toContainText("1.6s");

		// 浅色终端底：#f7f7f9 → rgb(247, 247, 249)
		const bg = await term.evaluate((el) => getComputedStyle(el).backgroundColor);
		expect(bg).toBe("rgb(247, 247, 249)");
		await card.screenshot({
			path: join(process.env.TEMP || "/tmp", `shell-card-light-${Date.now()}.png`),
		});
	});

	test("深色：终端块背景跟随主题", async ({ page }) => {
		seedSession();
		await injectMessages(page);
		await setUiPrefs(page, "zh", {
			themeMode: "dark",
			collapseProcessByDefault: false,
		});

		await openCard(page);
		await page.getByTestId(`toolcall-${TOOLCALL_ID}-header`).click();
		const term = page.getByTestId(`toolcall-${TOOLCALL_ID}-shell`);
		await expect(term).toBeVisible();
		const bg = await term.evaluate((el) => getComputedStyle(el).backgroundColor);
		expect(bg).toBe("rgb(15, 15, 18)");
		await page
			.getByTestId(`toolcall-${TOOLCALL_ID}`)
			.screenshot({
				path: join(process.env.TEMP || "/tmp", `shell-card-dark-${Date.now()}.png`),
			});
	});

	test("失败：退出码 2 外显，正文提示不重复渲染", async ({ page }) => {
		seedSession();
		await injectMessages(page, { fail: true });
		await setUiPrefs(page, "zh", { collapseProcessByDefault: false });

		await openCard(page);
		await page.getByTestId(`toolcall-${TOOLCALL_ID}-header`).click();
		const term = page.getByTestId(`toolcall-${TOOLCALL_ID}-shell`);
		await expect(term).toContainText("error TS2307");
		await expect(term).not.toContainText("Command exited");
		await expect(page.getByTestId(`toolcall-${TOOLCALL_ID}-exit`)).toContainText("2");
	});
});
