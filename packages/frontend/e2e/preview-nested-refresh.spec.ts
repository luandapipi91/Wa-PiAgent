// 嵌套子页自动刷新 E2E：预览 A.html（内含 <iframe src="./B.html">），
// 真实 LLM 会话用 edit 工具修改子文件 B.html → 任务完成 file_changes 上报的是
// B.html（非预览外层文件）→ 命中判定按「同目录嵌套子页 html」放宽 → 外层预览
// iframe 自动重挂，子页内容显示修改后的版本。全程不点刷新按钮。
//
// 流程对齐 preview-auto-refresh.spec.ts（真实 LLM 触发 file_changes 的唯一合法全链路）。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { E2E_WA_PI_DIR } from "../playwright.config";
import { createSessionViaPrompt, saveProvider } from "./helpers";

// 预置嵌套结构：A.html 引用同目录 B.html（子页内容即断言目标）
const DIST_DIR = join(E2E_WA_PI_DIR, "e2e-project", "dist");
const OUTER_HTML = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8" /><title>nested-outer</title></head>
<body><h1>外层固定内容</h1>
<iframe src="./nested-child.html" style="width:400px;height:160px;border:1px solid #ccc"></iframe>
</body>
</html>`;
const CHILD_HTML = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8" /><title>nested-child</title></head>
<body><h2 id="child-ver">子页版本一</h2></body>
</html>`;
mkdirSync(DIST_DIR, { recursive: true });
writeFileSync(join(DIST_DIR, "nested-outer.html"), OUTER_HTML, "utf8");
writeFileSync(join(DIST_DIR, "nested-child.html"), CHILD_HTML, "utf8");

/** 从本机 pi 凭证库读 deepseek apiKey（仅测试运行期内存使用） */
function readDeepseekKey(): string {
	const home = process.env.HOME || process.env.USERPROFILE || ".";
	const auth = JSON.parse(
		readFileSync(join(home, ".pi", "agent", "auth.json"), "utf-8"),
	);
	const key = auth?.deepseek?.key;
	if (!key)
		throw new Error("~/.pi/agent/auth.json 缺少 deepseek.key，无法执行 LLM E2E");
	return key;
}

async function openSession(page: Page): Promise<void> {
	await page.goto("/");
	await page.waitForTimeout(2000);
	const session = await createSessionViaPrompt("e2e-proj-1", {
		agentName: "研发",
		text: "请回复：好的",
		model: "deepseek/deepseek-v4-flash",
		sessionId: "s-nc-" + Math.random().toString(36).slice(2),
	});
	await page.getByText("E2E项目").first().click();
	await page.getByTestId(`session-${session.id}`).click();
	await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 8000 });
}

async function openHtmlPreview(page: Page): Promise<void> {
	await page.getByTestId("btn-explorer").click();
	await expect(page.getByTestId("explorer-aside")).toBeVisible({
		timeout: 5000,
	});
	const panel = page.locator('[data-testid="explorer-panel"]');
	const distNode = panel.getByText("dist", { exact: true });
	await expect(distNode).toBeVisible({ timeout: 15_000 });
	await distNode.click();
	const htmlNode = panel.getByText("nested-outer.html", { exact: true });
	await expect(htmlNode).toBeVisible({ timeout: 15_000 });
	await htmlNode.dblclick();
	await expect(page.getByTestId("browser-panel")).toBeVisible({ timeout: 5000 });
}

test("任务修改嵌套子文件 B.html → 完成后外层预览自动刷新显示子页最新内容", async ({
	page,
}) => {
	test.setTimeout(240_000);

	// 1. 注入 deepseek provider（真实 LLM 跑 edit 工具）
	await page.goto("/");
	await saveProvider({
		id: randomUUID(),
		name: "DeepSeek",
		baseUrl: "https://api.deepseek.com",
		apiKey: readDeepseekKey(),
		api: "openai-completions",
		models: [
			{ id: "deepseek-v4-flash", contextWindow: 1000000, maxTokens: 384000 },
		],
	});
	await expect(page.getByTestId("new-session-pane")).toBeVisible({
		timeout: 10_000,
	});

	// 2. 进入会话并预览外层 A.html，确认子页初始内容「子页版本一」
	await openSession(page);
	await openHtmlPreview(page);
	const frame = page.frameLocator('[data-testid="html-preview-iframe"]');
	const childFrame = frame.frameLocator('iframe[src*="nested-child.html"]');
	await expect(childFrame.locator("#child-ver")).toHaveText("子页版本一", {
		timeout: 8000,
	});

	// 3. 发 prompt：用 edit 工具修改【子文件 nested-child.html】（外层预览文件不动）
	await page
		.locator('[data-testid="composer-input"] [role="textbox"]')
		.fill(
			"请使用 edit 工具（不要用 bash 或其他方式），把项目 dist/nested-child.html 文件里的「子页版本一」改为「子页版本二」。不要修改其他文件。改完后用一句话告诉我修改完成。",
		);
	await expect(
		page.locator('[data-testid="composer-input"] [role="textbox"]'),
	).toContainText("nested-child", { timeout: 5000 });
	await expect(page.getByTestId("composer-send")).toBeEnabled({ timeout: 5000 });
	await page.getByTestId("composer-send").click();
	await expect(page.getByText("nested-child.html").first()).toBeVisible({
		timeout: 15_000,
	});

	// 4. 等任务完成（文件修改清单出现 = agent_end + file_changes 已到前端）
	await expect(page.getByTestId("file-change-summary")).toBeVisible({
		timeout: 200_000,
	});

	// 5. 核心断言：不点刷新按钮，外层预览 iframe 重挂后子页内容已自动变为「子页版本二」
	await expect(childFrame.locator("#child-ver")).toHaveText("子页版本二", {
		timeout: 10_000,
	});
});
