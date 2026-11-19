// 「展开停在视口底部的那张卡片，内容必须看得见」E2E 回归。
//
// 用户反馈（图 1 → 图 2）：最后一轮的工具卡停在输入框上方（视口最底部），点开它，
// 卡身展开后整块长在视口外——只看得见卡片头部，看不到任何内容，必须手动再往下滚。
// 期望（图 3）：点开后内容立刻可见。
//
// 根因：toggleViewport 的视口补偿只保证「点的那一行不动」（restoreAfterToggle），
// 从不保证展开出来的新内容进入视口。展开发生在视口底部时，两者必然冲突。
//
// 修复：新增 revealExpandedContent——内容长在锚点下方且溢出视口时，把视口下移
// （上限 = 锚点到视口上沿的距离，不把用户点的那一行顶出屏幕）。
//
// 会话种子范式同 collapse-viewport.spec.ts：直接往 E2E_WA_PI_DIR/sessions 写 jsonl，
// 输出完全确定，不依赖真实模型。
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_WA_PI_DIR } from "../playwright.config";
import { ensureProvider, setUiPrefs } from "./helpers";

/** 一段够长的 bash 输出，保证展开后的 body 高度远超视口 */
const LONG_OUTPUT = Array.from(
	{ length: 60 },
	(_, i) => `第 ${i + 1} 行输出：验证展开后视口会把内容带进可见区域。`,
).join("\n");

function seedLongToolCallSession(sessionId: string, title: string) {
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
	let n = 1;
	let parentId: string | null = null;
	const push = (message: Record<string, unknown>) => {
		const mid = `m${n++}`;
		lines.push(
			JSON.stringify({
				type: "message",
				id: mid,
				parentId,
				message: { timestamp: n, ...message },
			}),
		);
		parentId = mid;
	};

	// 前面铺几轮普通问答，保证列表够长（能滚动）
	for (let i = 0; i < 4; i++) {
		push({ role: "user", content: [{ type: "text", text: `问题 ${i + 1}` }] });
		push({
			role: "assistant",
			content: [{ type: "text", text: `回答 ${i + 1}：普通长度的回复。` }],
		});
	}
	// 最后一轮：一次长输出的 bash 工具调用 —— 卡片折叠态只占一行，展开后极高
	push({ role: "user", content: [{ type: "text", text: "跑一下那个长输出" }] });
	push({
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "call_long_output",
				name: "bash",
				arguments: { command: "cat long-output.txt", timeout: 180 },
			},
		],
	});
	// 工具结果：TestResult 以独立 message 记录（role=toolResult）
	push({
		role: "toolResult",
		toolCallId: "call_long_output",
		toolName: "bash",
		content: [{ type: "text", text: LONG_OUTPUT }],
		details: { exitCode: 0 },
		isError: false,
	});

	writeFileSync(
		join(E2E_WA_PI_DIR, "sessions", `${sessionId}.jsonl`),
		lines.join("\n"),
		"utf8",
	);
}

/** 读取 message-list 的滚动容器几何 */
async function scrollerMetrics(page: Page) {
	return page.evaluate(() => {
		const el = document.querySelector(
			'[data-testid="message-list"]',
		) as HTMLElement | null;
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return {
			scrollTop: Math.round(el.scrollTop),
			scrollHeight: Math.round(el.scrollHeight),
			clientHeight: Math.round(el.clientHeight),
			top: Math.round(r.top),
			bottom: Math.round(r.bottom),
		};
	});
}

test.describe("展开停在视口底部的卡片", () => {
	test.beforeAll(async () => {
		await ensureProvider();
	});

	test.beforeEach(async ({ page }) => {
		await setUiPrefs(page, "zh");
	});

	test("点开最后一条工具卡 → 展开内容进入视口（不是只看见卡片头部）", async ({
		page,
	}) => {
		test.setTimeout(120_000);
		const sid = "s-e2e-expand-toolcard";
		seedLongToolCallSession(sid, "E2E展开工具卡视口");

		await page.goto("/");
		await page.getByTestId(`session-${sid}`).click();
		await expect(page.getByTestId("session-view")).toBeVisible({
			timeout: 10_000,
		});

		// 展开本轮过程，露出工具卡
		const summary = page.getByTestId("turn-summary").last();
		await expect(summary).toBeVisible({ timeout: 15_000 });
		await summary.click();

		const header = page.getByTestId("toolcall-call_long_output-header");
		await expect(header).toBeVisible({ timeout: 15_000 });

		// 把视口滚到最底部：卡片头部紧贴视口下沿（用户截图里的状态）
		await page.evaluate(() => {
			const el = document.querySelector(
				'[data-testid="message-list"]',
			) as HTMLElement;
			el.scrollTop = el.scrollHeight;
		});
		await page.waitForTimeout(600);
		const before = await scrollerMetrics(page);
		expect(before).not.toBeNull();

		// 点开卡片
		await header.click();
		const body = page.getByTestId("toolcall-call_long_output-body");
		await expect(body).toBeVisible({ timeout: 10_000 });
		// 等视口补偿（rAF + 重试窗口）收敛
		await page.waitForTimeout(1200);

		// 核心断言 1：展开出来的内容确实在视口内（旧实现下它整块落在视口外）
		const bodyRect = await body.evaluate((el) => {
			const r = el.getBoundingClientRect();
			const scroller = document.querySelector(
				'[data-testid="message-list"]',
			) as HTMLElement;
			const s = scroller.getBoundingClientRect();
			return {
				top: Math.round(r.top),
				bottom: Math.round(r.bottom),
				scrollerTop: Math.round(s.top),
				scrollerBottom: Math.round(s.bottom),
				visible:
					Math.round(Math.min(r.bottom, s.bottom) - Math.max(r.top, s.top)),
			};
		});
		expect(bodyRect.visible).toBeGreaterThan(20);
		expect(bodyRect.top).toBeLessThan(bodyRect.scrollerBottom);

		// 核心断言 2：视口确实往下走了（证明是为「让内容可见」而滚，而非原本就可见）
		const after = await scrollerMetrics(page);
		expect(after!.scrollTop).toBeGreaterThan(before!.scrollTop);

		// 核心断言 3：用户点的那一行没被顶出屏幕（卡片头部仍在视口内）
		const headerRect = await header.evaluate((el) => {
			const r = el.getBoundingClientRect();
			const scroller = document.querySelector(
				'[data-testid="message-list"]',
			) as HTMLElement;
			const s = scroller.getBoundingClientRect();
			return { top: Math.round(r.top), scrollerTop: Math.round(s.top) };
		});
		expect(headerRect.top).toBeGreaterThanOrEqual(headerRect.scrollerTop - 1);
	});
});
