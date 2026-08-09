// 流式渲染性能优化 E2E（task-6 审查 Important-2）：react-virtuoso 虚拟化后的滚动行为
// 在真实浏览器中的覆盖。happy-dom 无真实滚动几何，无法测 followOutput/atBottomStateChange/
// scrollToIndex 的实际滚动效果——这些行为仅 E2E 可覆盖。
//
// 覆盖被删的 13 个滚动行为测试的核心子集：
//   1. 进入长会话 → 自动定位到最新回复（Important-1 回归点：异步历史加载后定位到末行）
//   2. 上滑离开底部 → 「滚动到底部」浮钮出现、跟随停止
//   3. 点击浮钮 → 回到底部、浮钮消失、恢复跟随
//
// 数据准备：向 E2E 隔离 WA_PI_DIR 写 projects.json 会话记录 + 足够长的 pi 会话 jsonl
// （内容高度显著超过视口），kernel 的 projectStore 每次请求重新 load，文件改动即生效。
import { test, expect } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_WA_PI_DIR } from "../playwright.config";
import { saveProvider } from "./helpers";

const SESSION_ID = "s-e2e-virt-scroll-001";

/** 预置一个长会话（60 轮 user+assistant，正文较长确保整体高度远超视口）。 */
function seedLongSession() {
	const projPath = join(E2E_WA_PI_DIR, "projects.json");
	const data = JSON.parse(readFileSync(projPath, "utf8"));
	if (!data.sessions.some((s: any) => s.id === SESSION_ID)) {
		data.sessions.push({
			id: SESSION_ID,
			projectId: "e2e-proj-1",
			primaryAgent: "dev",
			title: "E2E虚拟化滚动",
			createdAt: 1,
			lastActivity: 1,
			piSessionFile: join(E2E_WA_PI_DIR, "sessions", `${SESSION_ID}.jsonl`),
		});
		writeFileSync(projPath, JSON.stringify(data, null, 2), "utf8");
	}
	mkdirSync(join(E2E_WA_PI_DIR, "sessions"), { recursive: true });

	const line = (id: string, parentId: string | null, role: string, text: string, ts: number) =>
		JSON.stringify({
			type: "message",
			id,
			parentId,
			message: { role, content: [{ type: "text", text }], timestamp: ts },
		});

	const lines: string[] = [
		JSON.stringify({ type: "session", version: 3, id: "e2e-virt-scroll-uuid" }),
	];
	let id = 1;
	let parentId: string | null = null;
	for (let i = 0; i < 60; i++) {
		const uId = `m${id++}`;
		lines.push(
			line(
				uId,
				parentId,
				"user",
				`这是第 ${i + 1} 个用户问题，用于测试虚拟化列表进入会话的滚动定位与浮钮行为。`,
				i * 2 + 1,
			),
		);
		parentId = uId;
		const aId = `m${id++}`;
		lines.push(
			line(
				aId,
				parentId,
				"assistant",
				`回答 ${i + 1}：这是一段较长的助手回复正文，确保整体内容高度显著超过浏览器视口，从而可以观察到滚动条与「滚动到底部」浮钮。当前是第 ${i + 1} 轮。`,
				i * 2 + 2,
			),
		);
		parentId = aId;
	}
	writeFileSync(
		join(E2E_WA_PI_DIR, "sessions", `${SESSION_ID}.jsonl`),
		lines.join("\n"),
		"utf8",
	);
}

/** 读取 virtuoso 滚动容器的 scrollTop/scrollHeight/clientHeight。 */
async function scrollMetrics(page: import("@playwright/test").Page) {
	return page.evaluate(() => {
		const el = document.querySelector(
			'[data-testid="message-list"]',
		) as HTMLElement | null;
		if (!el) return null;
		return {
			scrollTop: el.scrollTop,
			scrollHeight: el.scrollHeight,
			clientHeight: el.clientHeight,
		};
	});
}

test("长会话虚拟化：进入即定位最新 → 上滑浮钮 → 点浮钮回底", async ({ page }) => {
	test.setTimeout(90_000);
	seedLongSession();
	// 预置模型供应商：隔离环境默认无 provider，App 首启会弹出 onboarding 向导
	// （modal-overlay）拦截点击。配一个 provider 让向导不弹（同 composer.spec.ts 模式）。
	await saveProvider({
		id: "e2e-virt-scroll-provider",
		name: "E2E VirtScroll",
		slug: "e2e-virt-scroll",
		baseUrl: "http://localhost:9999/v1",
		apiKey: "sk-e2e",
		api: "openai-completions",
		models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
	});

	await page.goto("/");
	const row = page.getByTestId(`session-${SESSION_ID}`);
	await expect(row).toBeVisible({ timeout: 10_000 });
	await row.click();

	await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 10_000 });
	// 末轮回复渲染（定位到底部后末行可见）
	await expect(page.getByText("回答 60：")).toBeVisible({ timeout: 15_000 });

	// 1) 进入即定位到底部：scrollTop 接近 scrollHeight - clientHeight（距底 ≤ 40px）
	await expect
		.poll(
			async () => {
				const m = await scrollMetrics(page);
				if (!m) return 9999;
				return Math.round(m.scrollHeight - m.clientHeight - m.scrollTop);
			},
			{ timeout: 15_000, message: "进入会话应定位到最新回复（底部）" },
		)
		.toBeLessThanOrEqual(40);

	// 2) 上滑到顶部 → 浮钮出现、跟随停止
	await page.evaluate(() => {
		const el = document.querySelector(
			'[data-testid="message-list"]',
		) as HTMLElement;
		el.scrollTop = 0;
		// 派发原生 scroll 事件触发 Virtuoso 的 atBottomStateChange（→ stickBottom=false）
		el.dispatchEvent(new Event("scroll", { bubbles: true }));
	});
	const floatBtn = page.getByTestId(`scroll-bottom-${SESSION_ID}`);
	await expect(floatBtn).toBeVisible({ timeout: 8_000 });
	// 上滑后 scrollTop 应在顶部附近（确认确实离开了底部）
	const afterUp = await scrollMetrics(page);
	expect(afterUp!.scrollTop).toBeLessThan(80);
	// 首轮用户问题在顶部可见（虚拟化在顶部窗口渲染）
	await expect(page.getByText("这是第 1 个用户问题")).toBeVisible({ timeout: 8_000 });

	// 3) 点浮钮 → 回到底部、浮钮消失
	await floatBtn.click();
	await expect
		.poll(
			async () => {
				const m = await scrollMetrics(page);
				if (!m) return 9999;
				return Math.round(m.scrollHeight - m.clientHeight - m.scrollTop);
			},
			{ timeout: 10_000, message: "点击浮钮后应回到底部" },
		)
		.toBeLessThanOrEqual(40);
	await expect(floatBtn).toBeHidden({ timeout: 5_000 });
	// 回底后末轮回复再次可见
	await expect(page.getByText("回答 60：")).toBeVisible({ timeout: 5_000 });
});
