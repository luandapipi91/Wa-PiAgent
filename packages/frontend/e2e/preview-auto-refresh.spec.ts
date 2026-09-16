// 预览自动刷新 E2E：真实 LLM 完整会话，edit 工具修改「正在预览的 html」→ 任务完成
// （agent_end → bridge 上报 file_changes → SSE → store 命中当前会话预览文件）→
// 预览 iframe 自动重挂并显示修改后内容，全程不点刷新按钮。
//
// 流程对齐 file-change-summary.spec.ts（真实 LLM 触发 file_changes 的唯一合法全链路——
// bridge token 只存在于 kernel 与被 spawn 的 pi 子进程之间，E2E 无法直接伪造 POST）与
// html-preview.spec.ts（文件树双击打开预览 iframe）：
// - 测试数据经 API/写盘创建：provider 从本机 ~/.pi/agent/auth.json 读 deepseek 凭证
// - 用户流程在浏览器执行：开会话 → 开预览 → 发消息 → 断言 iframe 内容自动更新
// - 数据清理：E2E_WA_PI_DIR 由 global-teardown 整体清除
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { E2E_WA_PI_DIR } from "../playwright.config";
import { createSessionViaPrompt, saveProvider } from "./helpers";

// 预置被预览+被修改的 html（dist/ 惯例：/preview allowlist 项目内任意路径）
const DIST_DIR = join(E2E_WA_PI_DIR, "e2e-project", "dist");
const REFRESH_HTML = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8" /><title>auto-refresh</title></head>
<body><h1 id="ar-title">自动刷新前</h1></body>
</html>`;
mkdirSync(DIST_DIR, { recursive: true });
writeFileSync(join(DIST_DIR, "auto-refresh.html"), REFRESH_HTML, "utf8");

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

// 进入会话页：API 预创建会话（有效模型，首轮回复「请回复：好的」占位）
// → 侧栏选 E2E项目 → 点会话行。必须显式进入项目：首页直接发消息的会话挂在
// 默认工作区（workspaceDir 为空），explorer 文件树无目录可列。
// agentName 必须传 displayName「研发」（agent 文件迁移后 getAgent 按 displayName 查，
// 传内部 name「dev」会导致第二条消息起 agent_missing、队列卡死）
async function openSession(page: Page): Promise<void> {
	await page.goto("/");
	await page.waitForTimeout(2000);
	const session = await createSessionViaPrompt("e2e-proj-1", {
		agentName: "研发",
		text: "请回复：好的",
		model: "deepseek/deepseek-v4-flash",
		sessionId: "s-ar-" + Math.random().toString(36).slice(2),
	});
	await page.getByText("E2E项目").first().click();
	await page.getByTestId(`session-${session.id}`).click();
	await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 8000 });
}

// 文件树展开 dist → 双击 auto-refresh.html 打开预览（html-preview.spec 同款）
async function openHtmlPreview(page: Page): Promise<void> {
	await page.getByTestId("btn-explorer").click();
	await expect(page.getByTestId("explorer-aside")).toBeVisible({
		timeout: 5000,
	});
	const panel = page.locator('[data-testid="explorer-panel"]');
	// 文件树靠轮询加载（explorer 5s 轮询），会话刚建时首帧可能还在 loading，放宽等待
	const distNode = panel.getByText("dist", { exact: true });
	await expect(distNode).toBeVisible({ timeout: 15_000 });
	await distNode.click();
	const htmlNode = panel.getByText("auto-refresh.html", { exact: true });
	await expect(htmlNode).toBeVisible({ timeout: 15_000 });
	await htmlNode.dblclick();
	await expect(page.getByTestId("browser-panel")).toBeVisible({ timeout: 5000 });
}

test("任务修改预览中的文件 → 完成后预览自动刷新显示最新内容", async ({
	page,
}) => {
	test.setTimeout(240_000);

	// 1. 注入 deepseek provider（真实 LLM 跑 edit 工具，file-change-summary.spec 同款）
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

	// 2. API 创建会话（归属 e2e-project）并进入，再打开预览确认初始内容；
	// 首条占位消息仍在跑没关系，第二条消息经队列排队，file_changes 按轮独立上报
	await openSession(page);
	await openHtmlPreview(page);
	const frame = page.frameLocator('[data-testid="html-preview-iframe"]');
	await expect(frame.locator("#ar-title")).toHaveText("自动刷新前", {
		timeout: 8000,
	});

	// 3. 发 prompt：要求 edit 工具（dev 智能体白名单含 edit）修改正在预览的文件
	// 预览面板开着时页面有两个 textbox（composer + 预览地址栏），须定位 composer 容器内那个
	await page
		.locator('[data-testid="composer-input"] [role="textbox"]')
		.fill(
			"请使用 edit 工具（不要用 bash 或其他方式），把项目 dist/auto-refresh.html 文件里的「自动刷新前」改为「自动刷新后」。改完后用一句话告诉我修改完成。",
		);
	// 调试断言 1：文本确实进入 composer（contenteditable div，无 value 属性，断言 textContent）
	await expect(
		page.locator('[data-testid="composer-input"] [role="textbox"]'),
	).toContainText("edit 工具", { timeout: 5000 });
	// 调试断言 2：发送按钮可点击（canSend 四条件全满足）
	await expect(page.getByTestId("composer-send")).toBeEnabled({ timeout: 5000 });
	await page.getByTestId("composer-send").click();
	// 调试断言 3：点击后 Me 消息段落出现在聊天流（发送确实发生）
	await expect(page.getByText("请使用 edit 工具").first()).toBeVisible({
		timeout: 15_000,
	});

	// 4. 等任务完成：回复底部出现文件修改清单（= agent_end + file_changes 已到前端）
	await expect(page.getByTestId("file-change-summary")).toBeVisible({
		timeout: 200_000,
	});

	// 5. 核心断言：不点刷新按钮，预览 iframe 已自动显示修改后的内容
	await expect(frame.locator("#ar-title")).toHaveText("自动刷新后", {
		timeout: 10_000,
	});
});
