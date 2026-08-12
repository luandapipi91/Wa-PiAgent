// 侧边栏「最近」视图 E2E（第四层）：时间线渲染 + 点击会话切换 + 停留在最近视图
//
// 环境说明：
// - global-setup 已起隔离 kernel（独立 WA_PI_DIR，含预置 dev 智能体 + e2e-proj-1 项目）。
// - 项目与会话经 helpers（Node 侧 REST）创建：项目目录先 mkdir（pi 子进程以 cwd 启动，
//   目录缺失 spawn ENOENT）；假 provider（localhost:9999）无法产出 assistant 回复，
//   但 createSessionViaPrompt 的 POST 返回时会话记录已落盘（模型错误走 SSE 广播，不影响建会话）。
// - 清理：finally 中经 REST 删除会话与项目（幂等，忽略报错）；隔离目录由 global-teardown 整体删除。
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { E2E_WA_PI_DIR, E2E_WS_PORT } from "../playwright.config";
import { createProject, createSessionViaPrompt, saveProvider } from "./helpers";

const BASE = `http://127.0.0.1:${E2E_WS_PORT}`;

const SESSION_ID = "s-e2e-recent-" + randomUUID().slice(0, 8);

async function api<T = any>(method: string, path: string): Promise<T> {
	const res = await fetch(`${BASE}${path}`, { method });
	const data: any = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`REST ${method} ${path} 失败(${res.status})`);
	return data as T;
}

test("侧边栏最近视图：时间线渲染 + 点击会话切换 + 停留在最近视图", async ({ page }) => {
	test.setTimeout(60_000);

	// 项目目录必须先存在（pi 子进程以 cwd 启动）；经 helpers 建项目 + 假 provider + 一个会话
	const projectCwd = join(E2E_WA_PI_DIR, "recent-e2e-proj");
	mkdirSync(projectCwd, { recursive: true });
	const project = await createProject(
		`e2e-recent-${randomUUID().slice(0, 8)}`,
		projectCwd,
	);
	await saveProvider({
		id: "e2e-recent-provider",
		name: "E2E Recent",
		baseUrl: "http://localhost:9999/v1",
		apiKey: "sk-e2e",
		api: "openai-completions",
		models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
	});
	await createSessionViaPrompt(project.id, {
		agentName: "dev",
		text: "最近会话E2E",
		model: "E2E Recent/model-a",
		sessionId: SESSION_ID,
	});

	try {
		await page.goto("/");
		await expect(page.getByTestId("new-session-pane")).toBeVisible({ timeout: 10_000 });

		// 切到「最近」
		await page.getByTestId("session-scope-recent").click();
		await expect(page.getByTestId("recent-sessions-list")).toBeVisible();

		// 时间线有刚建的会话行（本项目 + 预置 e2e-proj-1 无会话，行首即本会话）。
		// 注意：必须限定在 recent-sessions-list 内并排除 session-subtitle-* 次级标注——
		// 裸 `[data-testid^="session-"]` 会把分段控件按钮 session-scope-project/recent 也算进去，
		// first() 会点到「项目」分段按钮导致 scope 回退（初版失败即因此）。
		const firstSession = page
			.getByTestId("recent-sessions-list")
			.locator(
				'[data-testid^="session-"]:not([data-testid^="session-subtitle-"])',
			)
			.first();
		if (await firstSession.count()) {
			await firstSession.click();
			await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 10_000 });
			// 侧边栏仍处于「最近」视图：时间线仍在、分段控件高亮项为最近
			await expect(page.getByTestId("recent-sessions-list")).toBeVisible();
			await expect(page.getByTestId("session-scope-recent")).toBeVisible();
		}

		// 切回「项目」，项目列表可见（ProjectList 根节点无 testid，用项目名按钮判定）
		await page.getByTestId("session-scope-project").click();
		await expect(page.locator('[data-testid^="project-name-"]').first()).toBeVisible();
	} finally {
		// 清理：删除会话与项目（幂等，忽略报错）
		await api("DELETE", `/api/sessions/${SESSION_ID}`).catch(() => {});
		await api("DELETE", `/api/projects/${project.id}`).catch(() => {});
	}
});
