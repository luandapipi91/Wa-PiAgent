// 折叠长过程卡（思考/工具调用）时的视口位置保持 E2E 回归。
//
// 场景：长思考卡展开后把虚拟列表撑到数万 px，用户滚动到卡片头部附近点击折叠。
// 行高阶跃式骤减 → 列表总高塌缩 → scrollTop 被浏览器 clamp 到贴底位置；Virtuoso
// 在内部布局数据收敛期间还会把视口直接重置到列表头（用户抱怨的「跳顶」）；若此时
// 流式内容继续增长，贴底跟随回拉会把视口拽到新底部——用户正在查看的内容彻底消失。
//
// 修复（toggleViewport.ts 三阶段 + MessageList 假贴底检测）后，视口应停在折叠发生
// 的位置附近，且后续流式内容增长不再拽走视口。
import { test, expect } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_WA_PI_DIR } from "../playwright.config";
import { saveProvider } from "./helpers";

function seedCollapseSession(sessionId: string, title: string) {
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
	// 5 轮普通消息（铺垫，保证折叠后剩余高度可控）
	for (let i = 0; i < 5; i++) {
		push("user", [{ type: "text", text: `问题 ${i + 1}` }], i * 2 + 1);
		push(
			"assistant",
			[{ type: "text", text: `回答 ${i + 1}：普通长度的回复内容。` }],
			i * 2 + 2,
		);
	}
	// 超长 thinking 的 assistant 消息（约 3 万 px），其后无尾随轮 → 折叠必然触发
	// scrollTop clamp（用户报告跳顶的场景）
	const longThinking = Array.from(
		{ length: 1500 },
		(_, i) =>
			`思考第 ${i + 1} 行：分析问题的第 ${i + 1} 个方面，逐步推理验证假设。`,
	).join("\n");
	push("user", [{ type: "text", text: "给我详细分析一下这个问题" }], 100);
	push(
		"assistant",
		[
			{ type: "thinking", thinking: longThinking },
			{ type: "text", text: "这是长思考之后的最终回答。" },
		],
		101,
	);
	writeFileSync(
		join(E2E_WA_PI_DIR, "sessions", `${sessionId}.jsonl`),
		lines.join("\n"),
		"utf8",
	);
}

async function metrics(page: import("@playwright/test").Page) {
	return page.evaluate(() => {
		const el = document.querySelector(
			'[data-testid="message-list"]',
		) as HTMLElement | null;
		if (!el) return null;
		return {
			scrollTop: Math.round(el.scrollTop),
			scrollHeight: Math.round(el.scrollHeight),
			clientHeight: Math.round(el.clientHeight),
		};
	});
}

test.describe("折叠长过程卡的视口位置保持", () => {
	test.beforeEach(async () => {
		await saveProvider({
			id: "e2e-send-scroll-provider",
			name: "E2E SendScroll",
			slug: "e2e-send-scroll",
			baseUrl: "http://localhost:9999/v1",
			apiKey: "sk-e2e",
			api: "openai-completions",
			models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
		});
	});

	test("非贴底折叠长思考卡 → 视口保持 + 流式增长不拽走", async ({ page }) => {
		test.setTimeout(120_000);
		const sid = "s-e2e-collapse-viewport";
		seedCollapseSession(sid, "E2E折叠视口保持");
		await page.goto("/");
		await page.getByTestId(`session-${sid}`).click();
		await expect(page.getByTestId("session-view")).toBeVisible({
			timeout: 10_000,
		});
		await expect(page.getByText("回答 5")).toBeVisible({ timeout: 15_000 });

		// 展开长思考轮摘要行 → 出现 ThinkingCard（默认折叠）→ 展开长思考卡
		const summary = page.getByTestId("turn-summary");
		await summary.waitFor({ state: "visible", timeout: 15_000 });
		await summary.click();
		const header = page.getByTestId("thinking-panel-header").first();
		await header.waitFor({ state: "visible", timeout: 10_000 });
		await header.click();
		await expect(page.getByTestId("thinking-panel-body").first()).toBeVisible();
		await page.waitForTimeout(500);

		// 模拟用户上翻（wheel 标记用户输入），滚到卡片头部视口 top≈100 的位置
		await page.evaluate(() => {
			const el = document.querySelector(
				'[data-testid="message-list"]',
			) as HTMLElement;
			el.dispatchEvent(new Event("wheel", { bubbles: true }));
		});
		await header.evaluate((el) => {
			const scroller = document.querySelector(
				'[data-testid="message-list"]',
			) as HTMLElement;
			scroller.scrollTop =
				el.getBoundingClientRect().top + scroller.scrollTop - 100;
			scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
		});
		await page.waitForTimeout(400);
		const before = await metrics(page);
		expect(before).not.toBeNull();
		expect(before!.scrollHeight).toBeGreaterThan(20_000);

		// 点折叠
		await header.click();
		// 等待三阶段补偿（同步恢复 + 250ms 锚点回位 + 500ms 贴底解除）收敛
		await page.waitForTimeout(1200);
		const after = await metrics(page);
		expect(after).not.toBeNull();
		expect(after!.scrollHeight).toBeLessThan(before!.scrollHeight - 10_000);

		// 核心断言 1：视口没有被重置到列表头（跳顶）。修复前 scrollTop 会被打到 0，
		// 用户正在查看的内容瞬间消失
		expect(after!.scrollTop).toBeGreaterThan(100);

		// 核心断言 2：恢复机制生效——折叠发生的长轮行（turn-summary）重新可见，
		// 用户没有迷失在陌生的列表位置
		await expect(page.getByTestId("turn-summary").first()).toBeVisible();

		// 核心断言 3：贴底解除生效——视口离开贴底阈值（否则 Virtuoso 内建
		// bottom-pinning 会在内容增长时拽走视口）
		const distAfterCollapse =
			after!.scrollHeight - after!.clientHeight - after!.scrollTop;
		expect(distAfterCollapse).toBeGreaterThanOrEqual(20);

		// 流式模拟：折叠后内容继续增长（真实场景为后续 text 流式 append）。
		// 若折叠 clamp 的假贴底未被纠正（stickBottom=true 残留），贴底回拉会把视口
		// 拽到新底部；修复后 stickBottom 保持 false，视口停在原地
		await page.evaluate(async (sid) => {
			// @ts-expect-error — vite 运行时解析 /src/* 别名
			const { useSessionStore } = await import("/src/store/session.ts");
			const s = useSessionStore.getState();
			const list = [...(s.messagesBySession[sid] ?? [])];
			const last = list[list.length - 1];
			const m = last.message as {
				content: Array<{ type: string; text?: string }>;
			};
			list[list.length - 1] = {
				...last,
				message: {
					...m,
					content: [
						...m.content,
						{
							type: "text",
							text: Array.from(
								{ length: 200 },
								(_, i) => `流式追加第 ${i + 1} 行内容，验证视口不被贴底回拉拽走。`,
							).join("\n"),
						},
					],
				},
			};
			useSessionStore.setState(
				(st: { messagesBySession: Record<string, typeof list> }) => ({
					messagesBySession: { ...st.messagesBySession, [sid]: list },
				}),
			);
		}, sid);
		await page.waitForTimeout(1000);
		const afterGrow = await metrics(page);
		expect(afterGrow).not.toBeNull();

		// 核心断言 4：视口没有被贴底回拉拽走。修复前链条：clamp 瞬间被动贴底 →
		// atBottomStateChange(true) 误置 stickBottom=true → 流式增长触发 scrollToEnd →
		// 视口飞到列表末尾。修复后假贴底检测把 stickBottom 压住，不回拉。
		const distAfterGrow =
			afterGrow!.scrollHeight - afterGrow!.clientHeight - afterGrow!.scrollTop;
		expect(distAfterGrow).toBeGreaterThan(300);
		// 长轮行（turn-summary）仍在视口内——用户查看的位置稳定
		await expect(page.getByTestId("turn-summary").first()).toBeVisible();
	});
});
