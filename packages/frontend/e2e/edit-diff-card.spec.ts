// edit 工具卡片新版 diff 渲染 E2E（第四层）：真实浏览器 + 真实 kernel。
//
// 验证方案 A（差异优先 · Unified）：
// 1. 卡片标题以文件名为主、目录为辅；
// 2. 完成后默认折叠，展开后渲染双列真实行号（来自 details.diff）；
// 3. 单行替换有词级高亮（mark），整行增删用底色区分；
// 4. 底部摘要显示修改处数与位置，原「Successfully replaced...」不再平铺；
// 5. 省略上下文渲染为 gap 行。
//
// 数据准备复用 ask-stale.spec 模式：projects.json 落一条会话记录，
// /messages 用 page.route 注入 assistant(toolCall edit) + toolResult(details.diff)。
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_WA_PI_DIR } from "../playwright.config";
import { saveProvider } from "./helpers";

const SESSION_ID = "s-e2e-edit-diff-001";
const TOOLCALL_ID = "tc-e2e-edit-1";
const FILE_PATH = "internal/support/push/consume_mall_order_push.go";

// pi edit-diff 的真实格式：+<新行号> / -<旧行号> / " <旧行号>" 上下文 / "  ..." 省略
const DIFF = [
	" 40 type mallOrderMsg struct {",
	"+41 \tLastUpdateUser json.RawMessage",
	" 41 \tMallOrder *struct {",
	"  ...",
	"-67 \t\tCreateUser: rawString(msg.MallOrder.LastUpdateUser),",
	"+68 \t\tCreateUser: rawString(pickRaw(msg.LastUpdateUser, msg.MallOrder.LastUpdateUser)),",
	" 68 \t})",
].join("\n");

function seedSession() {
	const projPath = join(E2E_WA_PI_DIR, "projects.json");
	const data = JSON.parse(readFileSync(projPath, "utf8"));
	if (!data.sessions.some((s: any) => s.id === SESSION_ID)) {
		data.sessions.push({
			id: SESSION_ID,
			projectId: "e2e-proj-1",
			primaryAgent: "dev",
			title: "E2E edit diff 卡片",
			createdAt: 1,
			lastActivity: 1,
			piSessionFile: join(E2E_WA_PI_DIR, "sessions", `${SESSION_ID}.jsonl`),
		});
		writeFileSync(projPath, JSON.stringify(data, null, 2), "utf8");
	}
	mkdirSync(join(E2E_WA_PI_DIR, "sessions"), { recursive: true });
	writeFileSync(
		join(E2E_WA_PI_DIR, "sessions", `${SESSION_ID}.jsonl`),
		JSON.stringify({ type: "session", version: 3, id: "e2e-edit-diff-uuid" }) + "\n",
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
									name: "edit",
									arguments: {
										path: FILE_PATH,
										edits: [
											{
												oldText:
													"type mallOrderMsg struct {\n\tMallOrder *struct {",
												newText:
													"type mallOrderMsg struct {\n\tLastUpdateUser json.RawMessage\n\tMallOrder *struct {",
											},
										],
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
							toolName: "edit",
							content: [
								{
									type: "text",
									text: `Successfully replaced 1 block(s) in ${FILE_PATH}.`,
								},
							],
							details: { diff: DIFF },
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

test.describe.serial("edit 卡片新版 diff 渲染", () => {
	test.beforeAll(async () => {
		// 无供应商时 App 会弹 onboarding 挡住点击，预置假 provider 规避
		await saveProvider({
			id: "e2e-edit-diff-provider",
			name: "E2E EditDiff",
			slug: "e2e-edit-diff",
			baseUrl: "http://localhost:9999/v1",
			apiKey: "sk-e2e",
			api: "openai-completions",
			models: [{ id: "e2e-model", contextWindow: 8000, maxTokens: 1000 }],
		});
	});

	test("标题/双列行号/词级高亮/摘要/成功文案隐藏", async ({ page }) => {
		seedSession();
		await injectMessages(page);

		await page.goto("/");
		const row = page.getByTestId(`session-${SESSION_ID}`);
		await expect(row).toBeVisible({ timeout: 10_000 });
		await row.click();
		await expect(page.getByTestId("session-view")).toBeVisible({
			timeout: 10_000,
		});

		// 回合结束后「本轮过程」默认折叠 → 先展开过程列表，工具卡才渲染
		await page.getByTestId("turn-summary").click();
		const card = page.getByTestId(`toolcall-${TOOLCALL_ID}`);
		await expect(card).toBeVisible({ timeout: 10_000 });
		// 1. 标题：动作词 + 文件名为主、目录为辅（不再是一整条绝对路径）
		await expect(card).toContainText(/编辑|Edit/);
		await expect(card).toContainText("consume_mall_order_push.go");
		await expect(card).toContainText("support/push");

		// 2. 完成后默认折叠 → 点击展开
		await expect(card).toHaveAttribute("data-muted", "true");
		await page.getByTestId(`toolcall-${TOOLCALL_ID}-header`).click();
		const body = page.getByTestId(`toolcall-${TOOLCALL_ID}-body`);
		await expect(body).toBeVisible();

		// 3. 双列真实行号：新增行旧列空、新列 41；上下文行 40/40
		const addRow = body.getByTestId("edit-diff-add").first();
		await expect(addRow).toBeVisible();
		const addSpans = addRow.locator("span");
		await expect(addSpans.nth(0)).toHaveText("");
		await expect(addSpans.nth(1)).toHaveText("41");
		const ctxRow = body.getByTestId("edit-diff-ctx").first();
		await expect(ctxRow.locator("span").nth(0)).toHaveText("40");
		await expect(ctxRow.locator("span").nth(1)).toHaveText("40");

		// 4. 省略行渲染为 gap，文案是跳过的行范围（42–66，不含前后上下文）
		const gap = body.getByTestId("edit-diff-gap");
		await expect(gap).toHaveCount(1);
		await expect(gap).toContainText("42");
		await expect(gap).toContainText("66");

		// 5. 词级高亮：单行替换只标出变化段
		const marks = body.locator("mark");
		await expect(marks).toHaveCount(2);
		await expect(marks.last()).toHaveText(
			"pickRaw(msg.LastUpdateUser, msg.MallOrder.LastUpdateUser)",
		);

		// 6. 摘要：处数 + 位置；成功文案不再平铺
		const summary = page.getByTestId(`toolcall-${TOOLCALL_ID}-diff-summary`);
		await expect(summary).toContainText("2");
		await expect(summary).toContainText("41");
		await expect(summary).toContainText("67");
		await expect(body).not.toContainText("Successfully replaced");

		// 7. 复制按钮存在（完成态）
		await expect(body.getByRole("button", { name: /diff/i })).toBeVisible();

		// 视觉证据：截图存到项目外临时目录，测试结束后不留在仓库
		await card.screenshot({
			path: join(
				process.env.TEMP || "/tmp",
				`edit-diff-card-${Date.now()}.png`,
			),
		});
	});
});
