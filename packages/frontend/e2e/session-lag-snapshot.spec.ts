// 回归 E2E：新建会话首次发送后，kernel projects:list 快照滞后（不含新会话）不应挤掉乐观会话。
//
// 背景 bug：快速「新建会话→发送消息」时，kernel 广播的 projects:list 快照可能滞后
//（新会话乐观 addSession 后 placeholder 尚未转正、快照里还没它）。前端 setAll 曾把
// sessions 整表替换为滞后快照，导致 SessionView.find(sessionId) 找不到该会话 → return null
// → 对话区空白/重置。修复：setAll/load 统一走 mergeSessions，仅把 currentSessionId 指向
// 但快照缺失的会话合并回列表。
//
// 注入方式：开发/测试环境（import.meta.env.DEV）下 events.ts 把 emitEventForTesting
// 挂到 window.__PI_E2E_EVENT__，E2E 用 page.evaluate 在「乐观 addSession + selectSession
// （session-view 已出现）」之后精确注入一帧不含新会话的滞后 projects:list，命中 SSE →
// onMessage → setAll 真实主路径。若修复被回退，该会话会被滞后快照挤掉、session-view 消失。
import { test, expect } from "@playwright/test";
import { saveProvider } from "./helpers";

test("新建会话发送后，滞后 projects:list 快照不挤掉当前会话（不空白/不重置）", async ({
	page,
}) => {
	test.setTimeout(60_000);
	await saveProvider({
		id: "e2e-lag-provider",
		name: "E2E Lag",
		slug: "e2e-lag",
		baseUrl: "http://localhost:9999/v1",
		apiKey: "sk-e2e",
		api: "openai-completions",
		models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
	});

	await page.goto("/");
	const pane = page.getByTestId("new-session-pane");
	await expect(pane).toBeVisible({ timeout: 10_000 });

	// 发送新会话消息（触发 addSession + selectSession，乐观创建并选中新会话）
	await page.getByRole("textbox").fill("滞后快照 E2E 测试");
	await page.getByTestId("composer-send").click();

	// 等 session-view 出现（乐观会话已建立、被选中），这是注入的目标窗口
	await expect(page.getByTestId("session-view")).toBeVisible({
		timeout: 10_000,
	});

	// 在乐观会话已建立后，注入一帧「不含任何会话」的滞后 projects:list（模拟 placeholder 未转正）。
	// 命中真实的 SSE → onMessage → setAll 主路径。
	await page.evaluate(() => {
		const emit = (window as any).__PI_E2E_EVENT__;
		if (!emit) throw new Error("__PI_E2E_EVENT__ 未挂载（非 dev 环境？）");
		emit({
			type: "projects:list",
			projects: [{ id: "p1", name: "P", cwd: "/p", createdAt: 0 }],
			sessions: [],
		});
	});

	// 给 setAll 处理留出微任务窗口
	await page.waitForTimeout(1_000);

	// 关键断言：session-view 仍在（不因滞后快照被挤掉而 return null / 空白）
	await expect(page.getByTestId("session-view")).toBeVisible({
		timeout: 10_000,
	});
	// 消息文本仍在（对话区未被重置为空）
	await expect(
		page
			.locator("[data-testid^='msg-']")
			.filter({ hasText: "滞后快照 E2E 测试" })
			.first(),
	).toBeVisible({ timeout: 10_000 });
});
