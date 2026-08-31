// 提问卡片失效判定 E2E（第四层）：真实浏览器 + 真实 kernel（/asks 双重核对走真后端）。
//
// 背景：AskDock 渲染提问卡片后立即向 /asks 核对后端 AskRegistry 状态。
// 旧实现单次核对 miss 即判「提问已失效」——而 assistant 消息（卡片渲染）可能先于
// bridge 注册到达 kernel，竞态下有效提问被误判失效、用户无法回复。
// 修复后：首次 miss 有 500ms 宽限并复查一次，仍 miss 才确认失效。
//
// 数据准备：projects.json 写入会话记录（复用 session-history.spec 模式）；
// /messages 响应用 page.route 注入「含未回答 ask toolCall 的 assistant 消息」，
// 绕过 kernel 侧 reconcileDanglingAsks（冷会话对账会注入取消结果，卡片不渲染）。
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_WA_PI_DIR } from "../playwright.config";
import { saveProvider } from "./helpers";

const SESSION_ID = "s-e2e-ask-stale-001";
const TOOLCALL_ID = "tc-e2e-ask-1";

const askParams = {
	questions: [
		{
			question: "选择存储方案？",
			header: "存储",
			options: [
				{ label: "SQLite", description: "轻量" },
				{ label: "PostgreSQL", description: "生产级" },
			],
		},
	],
};

function seedSession() {
	const projPath = join(E2E_WA_PI_DIR, "projects.json");
	const data = JSON.parse(readFileSync(projPath, "utf8"));
	if (!data.sessions.some((s: any) => s.id === SESSION_ID)) {
		data.sessions.push({
			id: SESSION_ID,
			projectId: "e2e-proj-1",
			primaryAgent: "dev",
			title: "E2E提问失效判定",
			createdAt: 1,
			lastActivity: 1,
			piSessionFile: join(E2E_WA_PI_DIR, "sessions", `${SESSION_ID}.jsonl`),
		});
		writeFileSync(projPath, JSON.stringify(data, null, 2), "utf8");
	}
	mkdirSync(join(E2E_WA_PI_DIR, "sessions"), { recursive: true });
	const file = join(E2E_WA_PI_DIR, "sessions", `${SESSION_ID}.jsonl`);
	writeFileSync(
		file,
		JSON.stringify({ type: "session", version: 3, id: "e2e-ask-stale-uuid" }) + "\n",
		"utf8",
	);
}

/** 拦截 /messages：注入一条含未回答 ask toolCall 的 assistant 消息 */
async function injectAskMessage(page: Page) {
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
									name: "ask_user_question",
									arguments: askParams,
								},
							],
							model: "m",
							stopReason: "tool_use",
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

async function openSession(page: Page) {
	await page.goto("/");
	const row = page.getByTestId(`session-${SESSION_ID}`);
	await expect(row).toBeVisible({ timeout: 10_000 });
	await row.click();
	await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 10_000 });
	// 提问卡片渲染（选项按钮可见）
	await expect(page.getByRole("button", { name: /PostgreSQL/ })).toBeVisible({ timeout: 10_000 });
}

test.describe.serial("提问卡片失效判定", () => {
	test.beforeAll(async () => {
		// 无供应商时 App 会自动弹出 onboarding 向导挡住点击，预置假 provider 规避
		await saveProvider({
			id: "e2e-ask-stale-provider",
			name: "E2E AskStale",
			slug: "e2e-ask-stale",
			baseUrl: "http://localhost:9999/v1",
			apiKey: "sk-e2e",
			api: "openai-completions",
			models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
		});
	});

	test("竞态宽限内注册完成 → 不误判失效，提交可用", async ({ page }) => {
		seedSession();
		await injectAskMessage(page);
		// 首次核对 miss（注册未到）、复查命中（注册完成）——模拟消息先于注册的竞态窗口
		let asksCalls = 0;
		await page.route(`**/api/sessions/${SESSION_ID}/asks`, (route) => {
			asksCalls++;
			route.fulfill({
				contentType: "application/json",
				body: JSON.stringify({
					type: "session:asks",
					sessionId: SESSION_ID,
					pending: asksCalls >= 2 ? [TOOLCALL_ID] : [],
				}),
			});
		});

		await openSession(page);
		// 等宽限复查发生（第二次 /asks）并留有余量
		await expect
			.poll(() => asksCalls, { timeout: 5_000 })
			.toBeGreaterThanOrEqual(2);
		// 复查命中注册 → 不显示失效
		await expect(page.getByText("提问已失效", { exact: false })).toHaveCount(0);
		// 选一个选项后提交按钮可用
		await page.getByRole("button", { name: /PostgreSQL/ }).click();
		await expect(page.getByRole("button", { name: "提交" })).toBeEnabled();
	});

	test("后端持续无注册 → 宽限复查后显示已失效且提交禁用", async ({ page }) => {
		seedSession();
		await injectAskMessage(page);
		// 不拦截 /asks：真实 kernel 的 AskRegistry 无此条目（模拟已取消/重启残留）

		await openSession(page);
		// 宽限（500ms）+ 复查后显示失效
		await expect(
			page.getByText("提问已失效", { exact: false }),
		).toBeVisible({ timeout: 5_000 });
		// 选选项后提交仍禁用
		await page.getByRole("button", { name: /PostgreSQL/ }).click();
		await expect(page.getByRole("button", { name: "提交" })).toBeDisabled();
	});
});
