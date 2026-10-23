// edit/write 行数统计 meta（+N -M）E2E（第四层）：真实浏览器渲染合成会话。
// 数据准备（chat-media-preview.spec 模式）：projects.json 写会话记录 + page.route 注入
// 含 toolCall / toolResult(details.diff) 的消息，不依赖真实 LLM。
// 覆盖：edit 卡显示 +N -M（绿/红）、write 卡只显示 +N、bash 卡无统计、
//       回合结束后卡片折叠但 header 的统计仍可见（真实使用形态）。
import { test, expect } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_WA_PI_DIR } from "../playwright.config";
import { saveProvider } from "./helpers";

const SESSION_ID = "s-e2e-editstats-001";

function seedSession() {
	const projPath = join(E2E_WA_PI_DIR, "projects.json");
	const data = JSON.parse(readFileSync(projPath, "utf8"));
	if (!data.sessions.some((s: any) => s.id === SESSION_ID)) {
		data.sessions.push({
			id: SESSION_ID,
			projectId: "e2e-proj-1",
			primaryAgent: "dev",
			title: "E2E行数统计",
			createdAt: 1,
			lastActivity: 1,
			piSessionFile: join(E2E_WA_PI_DIR, "sessions", `${SESSION_ID}.jsonl`),
		});
		writeFileSync(projPath, JSON.stringify(data, null, 2), "utf8");
	}
	mkdirSync(join(E2E_WA_PI_DIR, "sessions"), { recursive: true });
	writeFileSync(
		join(E2E_WA_PI_DIR, "sessions", `${SESSION_ID}.jsonl`),
		JSON.stringify({ type: "session", version: 3, id: "e2e-editstats-uuid" }) +
			"\n",
		"utf8",
	);
}

async function injectMessages(page: import("@playwright/test").Page) {
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
								{ type: "thinking", thinking: "改一下配置" },
								{
									type: "toolCall",
									id: "tc-edit",
									name: "edit",
									arguments: {
										path: "src/App.tsx",
										edits: [{ oldText: "a\nb", newText: "c" }],
									},
								},
								{
									type: "toolCall",
									id: "tc-write",
									name: "write",
									arguments: { path: "docs/a.md", content: "l1\nl2\nl3" },
								},
								{
									type: "toolCall",
									id: "tc-bash",
									name: "bash",
									arguments: { command: "echo ok" },
								},
							],
							model: "m",
							stopReason: "end_turn",
							timestamp: 1,
						},
						agentName: "dev",
					},
					{
						message: {
							role: "toolResult",
							toolCallId: "tc-edit",
							toolName: "edit",
							content: [{ type: "text", text: "Successfully replaced 1 block(s)." }],
							isError: false,
							timestamp: 2,
							details: { diff: "+10 \t<div>\n-3 \t<a>\n-4 \t<b>" },
						},
						agentName: "dev",
					},
					{
						message: {
							role: "toolResult",
							toolCallId: "tc-write",
							toolName: "write",
							content: [{ type: "text", text: "Successfully wrote 12 bytes." }],
							isError: false,
							timestamp: 3,
						},
						agentName: "dev",
					},
					{
						message: {
							role: "toolResult",
							toolCallId: "tc-bash",
							toolName: "bash",
							content: [{ type: "text", text: "ok" }],
							isError: false,
							timestamp: 4,
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

test("edit/write 工具卡右侧显示 +N -M 行数统计", async ({ page }) => {
	test.setTimeout(120_000);
	await saveProvider({
		id: "e2e-editstats-provider",
		name: "E2E EditStats",
		slug: "e2e-editstats",
		baseUrl: "http://localhost:9999/v1",
		apiKey: "sk-e2e",
		api: "openai-completions",
		models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
	});
	seedSession();
	await injectMessages(page);

	await page.goto("/");
	const row = page.getByTestId(`session-${SESSION_ID}`);
	await expect(row).toBeVisible({ timeout: 10_000 });
	await row.click();
	await expect(page.getByTestId("session-view")).toBeVisible({
		timeout: 10_000,
	});

	// 回合结束后过程区折叠为「本轮过程」摘要（thinking + 工具调用 ≥ 2 步即折叠，
	// 产品既有行为）；真实用户路径就是点开摘要查看工具卡，再验证统计
	const turnSummary = page.getByRole("button", { name: /本轮过程/ });
	await expect(turnSummary).toBeVisible({ timeout: 15_000 });
	await turnSummary.click();

	// 单卡嵌在「N 个工具调用」组卡内（组卡随折叠开关默认收起），再展开组卡
	const groupCard = page.getByRole("button", { name: /个工具调用/ });
	await expect(groupCard).toBeVisible();
	await groupCard.click();

	// edit 卡：details.diff 计数 → +1 -2，绿/红分色
	const editStats = page.getByTestId("toolcall-tc-edit-stats");
	await expect(editStats).toBeVisible({ timeout: 15_000 });
	await expect(editStats.locator(".text-success")).toHaveText("+1");
	await expect(editStats.locator(".text-danger")).toHaveText("-2");

	// write 卡：只报新增行数（覆盖写前的旧行数不可知），不出现 -M
	const writeStats = page.getByTestId("toolcall-tc-write-stats");
	await expect(writeStats).toBeVisible();
	await expect(writeStats.locator(".text-success")).toHaveText("+3");
	await expect(writeStats.locator(".text-danger")).toHaveCount(0);

	// bash 卡：非 edit/write 不显示统计
	await expect(page.getByTestId("toolcall-tc-bash-stats")).toHaveCount(0);
});
