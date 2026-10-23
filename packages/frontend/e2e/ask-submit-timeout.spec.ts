// 提问卡片「提交挂住」自动重试 + 重试耗尽自动取消 E2E（第四层）：真实浏览器 + 真实 kernel。
//
// 背景：提交 answer 后按钮长期停在「提交中…」。两种成因——
//   ① 提交请求本身挂住不返回；
//   ② 请求已返回 200，但 toolResult 永不到达，父层永不卸载卡片。
// 修复后：单次请求超时 2s，最多尝试 3 次（首次 + 2 次重试）；重试耗尽则尽力 cancel-ask
// 后本地关闭卡片，绝不让 submitting 永久为 true。
//
// 数据准备复用 ask-stale.spec 模式：projects.json 写会话记录 + /messages 注入未回答的
// ask toolCall；/asks 拦截为「仍 pending」避免 double check 判失效。
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_WA_PI_DIR } from "../playwright.config";
import { saveProvider } from "./helpers";

const SESSION_ID = "s-e2e-ask-timeout-001";
const TOOLCALL_ID = "tc-e2e-ask-timeout-1";

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
			title: "E2E提交超时重试",
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
		JSON.stringify({ type: "session", version: 3, id: "e2e-ask-timeout-uuid" }) +
			"\n",
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

test.describe.serial("提问卡片提交挂住 → 自动重试 → 自动取消", () => {
	// 3 次尝试 × 2s 超时 = 6s，加页面加载与断言余量，放宽到 60s
	test.setTimeout(60_000);

	test.beforeAll(async () => {
		// 无供应商时 App 会自动弹出 onboarding 向导挡住点击，预置假 provider 规避
		await saveProvider({
			id: "e2e-ask-timeout-provider",
			name: "E2E AskTimeout",
			slug: "e2e-ask-timeout",
			baseUrl: "http://localhost:9999/v1",
			apiKey: "sk-e2e",
			api: "openai-completions",
			models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
		});
	});

	test("answer 一直不响应 → 首次保持提交中 → 自动重试至耗尽 → cancel-ask + 卡片自动关闭", async ({
		page,
	}) => {
		seedSession();
		await injectAskMessage(page);

		let answerAttempts = 0;
		let cancelRequests = 0;
		// /answer 永久挂起不响应（不 fulfill/continue）＝ 模拟「请求挂住不返回」
		await page.route(`**/api/sessions/${SESSION_ID}/answer`, () => {
			answerAttempts++;
		});
		await page.route(`**/api/sessions/${SESSION_ID}/cancel-ask`, (route) => {
			cancelRequests++;
			return route.fulfill({
				contentType: "application/json",
				body: JSON.stringify({ ok: true }),
			});
		});
		// double check 返回该 ask 仍 pending，避免卡片被判失效
		await page.route(`**/api/sessions/${SESSION_ID}/asks`, (route) =>
			route.fulfill({
				contentType: "application/json",
				body: JSON.stringify({
					type: "session:asks",
					sessionId: SESSION_ID,
					pending: [TOOLCALL_ID],
				}),
			}),
		);

		await page.goto("/");
		const row = page.getByTestId(`session-${SESSION_ID}`);
		await expect(row).toBeVisible({ timeout: 10_000 });
		await row.click();
		await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 10_000 });
		const card = page.getByTestId(`ask-card-${TOOLCALL_ID}`);
		await expect(card.getByRole("button", { name: /PostgreSQL/ })).toBeVisible({
			timeout: 10_000,
		});

		// 选一个选项后提交（按钮定位限定在卡片内，避免命中含「提交」的会话标题）
		await card.getByRole("button", { name: /PostgreSQL/ }).click();
		await card.getByRole("button", { name: "提交" }).click();

		// 首次请求挂起：按钮保持「提交中…」（旧实现从此永久卡住）
		await expect(card.getByRole("button", { name: "提交中…" })).toBeVisible();
		await expect(card).toBeVisible();

		// 首个 2s 超时后自动重试 → 第 2 次 /answer 发出
		await expect
			.poll(() => answerAttempts, { timeout: 10_000 })
			.toBeGreaterThanOrEqual(2);

		// 3 次尝试全部超时（约 6s）→ 自动 cancel-ask 一次
		await expect.poll(() => answerAttempts, { timeout: 12_000 }).toBe(3);
		await expect
			.poll(() => cancelRequests, { timeout: 10_000 })
			.toBeGreaterThanOrEqual(1);

		// 卡片本地关闭（不再永久阻塞输入框）
		await expect(page.getByTestId(`ask-card-${TOOLCALL_ID}`)).toHaveCount(0);
	});
});
