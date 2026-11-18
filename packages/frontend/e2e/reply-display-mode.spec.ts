// 回复显示模式 E2E（第四层）：真实浏览器 + 隔离 kernel，确定性种子会话（无 LLM）。
//
// 覆盖：
// 1. 完整输出：本轮所有正式输出合并进一张 outputs-card，无过程输出入口、不出现思考卡；
// 2. 精简输出：只显示最后一条，过程输出入口展开后只出现正式文本、不出现思考卡；
// 3. 精简模式下先展开过程输出、再展开本轮过程 → 同一段正文只出现一次（不重复渲染）；
// 4. 外观设置里「回复显示」下拉默认精简，切换后写入 localStorage。
//
// 会话种子范式同 e2e/collapse-viewport.spec.ts：直接往 E2E_WA_PI_DIR/sessions 写 jsonl，
// 输出完全确定，不依赖真实模型。
import { test, expect } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_WA_PI_DIR } from "../playwright.config";
import { ensureProvider, setUiPrefs } from "./helpers";

function seedReplyDisplaySession(sessionId: string, title: string) {
	const projPath = join(E2E_WA_PI_DIR, "projects.json");
	const data = JSON.parse(readFileSync(projPath, "utf8")) as {
		sessions: Array<{
			id: string;
			projectId: string;
			primaryAgent: string;
			title: string;
			createdAt: number;
			lastActivity: number;
			piSessionFile: string;
		}>;
	};
	if (!data.sessions.some((s: { id: string }) => s.id === sessionId)) {
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
	const lines: string[] = [
		JSON.stringify({ type: "session", version: 3, id: `uuid-${sessionId}` }),
	];
	let id = 1;
	let parentId: string | null = null;
	const push = (
		role: string,
		content: Array<{ type: string; text?: string; thinking?: string }>,
		ts: number,
	) => {
		const mid = `m${id++}`;
		lines.push(
			JSON.stringify({
				type: "message",
				id: mid,
				parentId,
				message: { role, content, timestamp: ts },
			}),
		);
		parentId = mid;
	};
	// 两段正式输出之间用 thinking 隔开（连续 text 会被 segmentBlocks 合并成一段）
	push("user", [{ type: "text", text: "打包以后更新失败了" }], 1);
	push(
		"assistant",
		[
			{ type: "thinking", thinking: "先看构建日志与产物 mtime。" },
			{ type: "text", text: "中间过渡：commit 说 nothing to commit，核实 HEAD 状态。" },
			{ type: "thinking", thinking: "确认 HEAD 与远端是否一致。" },
			{ type: "text", text: "最终回复：v0.10.7 已全通道上线。" },
		],
		2,
	);
	writeFileSync(
		join(E2E_WA_PI_DIR, "sessions", `${sessionId}.jsonl`),
		lines.join("\n"),
		"utf8",
	);
}

test.beforeAll(async () => {
	await ensureProvider();
});

test("回复显示模式：完整输出合并成卡片，精简输出入口只展开正式文本", async ({
	page,
}) => {
	test.setTimeout(120_000);
	const sid = "s-e2e-reply-display";
	seedReplyDisplaySession(sid, "E2E回复显示模式");

	// ---- 完整输出：全部正式输出合并进一张卡片 ----
	await setUiPrefs(page, "zh", { replyDisplayMode: "full" });
	await page.goto("/");
	await page.getByTestId(`session-${sid}`).click();
	await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 10_000 });

	const card = page.getByTestId("outputs-card");
	await expect(card).toBeVisible({ timeout: 15_000 });
	await expect(card).toContainText("中间过渡");
	await expect(card).toContainText("最终回复");
	await expect(page.getByTestId("outputs-tab")).toHaveCount(0);
	// 思考卡不应出现在合并卡片里（默认折叠，只有点开本轮过程才出现）
	await expect(page.getByTestId("thinking-panel")).toHaveCount(0);

	// ---- 精简输出：入口展开只出现正式文本 ----
	await setUiPrefs(page, "zh", { replyDisplayMode: "concise" });
	await page.reload();
	// reload 回到首页，重新选中种子会话
	await page.getByTestId(`session-${sid}`).click();
	await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 10_000 });
	await expect(page.getByText("最终回复")).toBeVisible({ timeout: 15_000 });
	await expect(page.getByText("中间过渡")).toHaveCount(0);

	const entry = page.getByTestId("outputs-tab");
	await expect(entry).toBeVisible();
	await entry.click();
	await expect(page.getByText("中间过渡")).toBeVisible();
	await expect(page.getByTestId("outputs-card")).toBeVisible();
	await expect(page.getByTestId("thinking-panel")).toHaveCount(0);

	// ---- 精简模式两个折叠互斥：再展开本轮过程，正文仍只出现一次 ----
	await page.getByTestId("turn-summary").click();
	await expect(page.getByTestId("outputs-card")).toHaveCount(0);
	await expect(page.getByTestId("outputs-tab")).toHaveCount(0);
	await expect(page.getByText("中间过渡")).toHaveCount(1);
	await expect(page.getByText("最终回复")).toHaveCount(1);
});

test("外观设置：回复显示默认精简，切换完整后写入持久化", async ({ page }) => {
	await setUiPrefs(page, "zh");
	await page.goto("/");

	await page.getByTestId("settings-btn").click();
	await expect(page.getByTestId("settings-nav-appearance")).toBeVisible();
	await page.getByTestId("settings-nav-appearance").click();

	const select = page.getByTestId("reply-display-select");
	await expect(select).toBeVisible();
	await expect(select).toHaveValue("concise");

	await select.selectOption("full");
	await expect(select).toHaveValue("full");

	const stored = await page.evaluate(() => {
		const raw = localStorage.getItem("wa-pi-ui-prefs");
		return raw ? JSON.parse(raw).state.replyDisplayMode : null;
	});
	expect(stored).toBe("full");

	// 关闭并重开设置（组件重新挂载）后仍读到 full——值来自 persisted store 而非组件内部状态。
	// 注：此处不 reload，因为 setUiPrefs 的 addInitScript 会在每次导航时重写 localStorage。
	await page.getByRole("button", { name: "关闭" }).first().click();
	await page.getByTestId("settings-btn").click();
	await page.getByTestId("settings-nav-appearance").click();
	await expect(page.getByTestId("reply-display-select")).toHaveValue("full");

	await page.getByTestId("reply-display-select").selectOption("concise");
	await expect(page.getByTestId("reply-display-select")).toHaveValue("concise");
});

// 停止/中断轮：最后一块是工具调用（无收尾正文）时，精简模式仍以最后一条正文作为显示，
// 而不是整轮只剩一行摘要（用户反馈的核心问题）。
test("精简模式：中断轮（末尾是工具调用）仍显示最后一条正文并可展开其余输出", async ({
	page,
}) => {
	test.setTimeout(120_000);
	const sid = "s-e2e-reply-display-interrupted";
	seedInterruptedSession(sid, "E2E中断轮显示");

	await setUiPrefs(page, "zh", { replyDisplayMode: "concise" });
	await page.goto("/");
	await page.getByTestId(`session-${sid}`).click();
	await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 10_000 });

	// 最后一条正文外置可见（修复前此处为空，整轮只剩摘要行）
	await expect(page.getByText("现在开始重跑这批任务")).toBeVisible({ timeout: 15_000 });
	// 此前那条正文在折叠里，默认不可见
	await expect(page.getByText("先确认一下现状")).toHaveCount(0);

	// 凸起标签可展开此前的正文，且不带出思考卡
	const tab = page.getByTestId("outputs-tab");
	await expect(tab).toBeVisible();
	await tab.click();
	await expect(page.getByText("先确认一下现状")).toBeVisible();
	await expect(page.getByTestId("thinking-panel")).toHaveCount(0);
	// 正文不重复
	await expect(page.getByText("现在开始重跑这批任务")).toHaveCount(1);

	// 展开本轮过程：正文仍各只出现一次
	await page.getByTestId("turn-summary").click();
	await expect(page.getByText("现在开始重跑这批任务")).toHaveCount(1);
	await expect(page.getByText("先确认一下现状")).toHaveCount(1);
});

function seedInterruptedSession(sessionId: string, title: string) {
	const projPath = join(E2E_WA_PI_DIR, "projects.json");
	const data = JSON.parse(readFileSync(projPath, "utf8")) as {
		sessions: Array<Record<string, unknown>>;
	};
	if (!data.sessions.some((s: any) => s.id === sessionId)) {
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
	const lines: string[] = [
		JSON.stringify({ type: "session", version: 3, id: `uuid-${sessionId}` }),
	];
	let id = 1;
	let parentId: string | null = null;
	const push = (role: string, content: unknown[], ts: number) => {
		const mid = `m${id++}`;
		lines.push(
			JSON.stringify({
				type: "message",
				id: mid,
				parentId,
				message: { role, content, timestamp: ts },
			}),
		);
		parentId = mid;
	};
	push("user", [{ type: "text", text: "帮我重跑这批任务" }], 1);
	// 关键形状：最后一块是 toolCall（停止/中断时真实情形），正文不在末尾
	push(
		"assistant",
		[
			{ type: "thinking", thinking: "先看现状再重跑。" },
			{ type: "text", text: "先确认一下现状" },
			{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
			{ type: "text", text: "现在开始重跑这批任务" },
			{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "pwd" } },
		],
		2,
	);
	writeFileSync(
		join(E2E_WA_PI_DIR, "sessions", `${sessionId}.jsonl`),
		lines.join("\n"),
		"utf8",
	);
}
