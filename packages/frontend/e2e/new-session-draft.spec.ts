// 新建会话草稿 id 消费 E2E（第四层）：删除会话后再「新建会话 → 发送」，
// 消息必须进入一个全新会话，而不是复用草稿 id 落进已删除的旧会话。
// 回归 bug：placeholder 会话首发消息时 kernel 不广播 session:created，
// 前端若只依赖该广播清除草稿 id，草稿 id 永久残留；会话被删除后前端守卫
// （existed 检查本地 sessions 列表）看不见它 → 复用草稿 id → 消息全落进
// 回收站里的同一个会话（「无论发什么都跑到同一个会话」的确定性复现路径）。
import { test, expect } from "@playwright/test";
import { saveProvider } from "./helpers";
import { E2E_WS_PORT } from "../playwright.config";

const BASE = `http://127.0.0.1:${E2E_WS_PORT}`;

async function api<T = any>(method: string, path: string): Promise<T> {
	const res = await fetch(`${BASE}${path}`, { method });
	const data: any = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`REST ${method} ${path} 失败(${res.status})`);
	return data as T;
}

async function pollUntil<T>(
	fn: () => Promise<T | undefined | null | false>,
	timeoutMs = 10_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > deadline) throw new Error("pollUntil 超时");
		await new Promise((r) => setTimeout(r, 200));
	}
}

test("删除会话后再新建发送 → 消息进入全新会话（草稿 id 不复用）", async ({
	page,
}) => {
	test.setTimeout(60_000);
	// 预置假 provider：避免首次启动向导弹窗遮挡 + 满足发送前置条件 isModelAvailable
	await saveProvider({
		id: "e2e-draft-provider",
		name: "E2E Draft",
		slug: "e2e-draft",
		baseUrl: "http://localhost:9999/v1",
		apiKey: "sk-e2e",
		api: "openai-completions",
		models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
	});

	await page.goto("/");
	const pane = page.getByTestId("new-session-pane");
	await expect(pane).toBeVisible({ timeout: 10_000 });

	// 第一次：新建会话页发送（kernel 侧 placeholder 转正，不广播 session:created）
	await page.getByRole("textbox").fill("第一条消息");
	await page.getByTestId("composer-send").click();
	await expect(page.getByTestId("session-view")).toBeVisible({
		timeout: 10_000,
	});

	// 等第一个会话落盘并拿到其 id
	const first = await pollUntil(async () => {
		const data = await api("GET", "/api/projects");
		return data.sessions?.find((s: any) => s.title === "第一条消息");
	});

	// 删除该会话（软删除进回收站）——此后前端 sessions 列表看不见它，
	// 但 kernel prompt 路径的 existing 查找仍能找到（load 不过滤 deletedAt）
	await api("DELETE", `/api/sessions/${first.id}`);

	// 第二次：再点新建会话 → 发送不同内容
	await page.getByTestId("new-session-btn").click();
	await expect(pane).toBeVisible({ timeout: 10_000 });
	await page.getByRole("textbox").fill("第二条消息");
	await page.getByTestId("composer-send").click();
	await expect(page.getByTestId("session-view")).toBeVisible({
		timeout: 10_000,
	});

	// 关键断言：出现一个标题为「第二条消息」的全新会话（id ≠ 已删除的第一个）。
	// 若草稿 id 被复用，消息会写进回收站里的旧会话，loadActive 永远查不到这条新会话 → 超时失败。
	const second = await pollUntil(async () => {
		const data = await api("GET", "/api/projects");
		return data.sessions?.find(
			(s: any) => s.title === "第二条消息" && s.id !== first.id,
		);
	});
	expect(second.id).not.toBe(first.id);
});
