// 聊天导出 E2E：真实 LLM 一轮对话 → AI 回复上点导出 → 下载 PNG（断言魔数）/ 复制图片（断言剪贴板调用）。
// harness 复用 chat-blocks.spec.ts 范式：隔离 WA_PI_DIR 由 global-setup 提供，
// deepseek apiKey 运行时从本机凭证库读取（不落盘）。
// 本机 dev（5180）/真实 kernel（9776）在跑时必须带偏移端口：
//   WA_PI_E2E_WEB_PORT=5190 WA_PI_WEB_PORT=5190 WA_PI_E2E_WS_PORT=9786 bunx playwright test e2e/chat-export.spec.ts
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { saveProvider } from "./helpers";

/**
 * 运行时读 deepseek apiKey（仅测试运行期内存使用，不落盘）。
 * 从 ~/.pi/agent/auth.json 的 deepseek.key 读取（rpc-session 既有约定）。
 */
function readDeepseekKey(): string {
	const home = process.env.HOME || process.env.USERPROFILE || ".";
	try {
		const auth = JSON.parse(
			readFileSync(join(home, ".pi", "agent", "auth.json"), "utf8"),
		);
		const key = auth?.deepseek?.key;
		if (key) return key;
	} catch {}
	throw new Error(
		"未找到 deepseek apiKey（~/.pi/agent/auth.json 无 deepseek.key），无法执行 LLM E2E",
	);
}

// 真实模型偶发不按指令输出 → 允许一次重试（断言不放宽）
test.describe.configure({ retries: 1 });

test("导出为图片：下载 PNG 文件 + 复制图片到剪贴板", async ({ page }) => {
	test.setTimeout(300_000);

	// 剪贴板插桩（headless Chromium 无真实系统剪贴板，记录 write 调用）
	await page.addInitScript(() => {
		(window as any).__clipWrites = 0;
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				write: async () => {
					(window as any).__clipWrites++;
				},
				writeText: async () => {},
			},
		});
	});

	// 1. 注入 deepseek provider + 打开项目
	const apiKey = readDeepseekKey();
	await page.goto("/");
	await saveProvider({
		id: randomUUID(),
		name: "DeepSeek",
		baseUrl: "https://api.deepseek.com",
		apiKey,
		api: "openai-completions",
		models: [
			{ id: "deepseek-v4-flash", contextWindow: 1000000, maxTokens: 384000 },
		],
	});
	await expect(page.getByTestId("new-session-pane")).toBeVisible({
		timeout: 10_000,
	});
	await page
		.getByTestId("model-selector")
		.selectOption("deepseek/deepseek-v4-flash");

	// 2. 发一轮指令化 prompt（短回复，降低随机性）
	await page
		.getByRole("textbox")
		.fill("只回复「导出测试成功」这六个字，不要说任何其他内容。");
	await page.getByTestId("composer-send").click();
	await expect(page.getByTestId("session-view")).toBeVisible({
		timeout: 10_000,
	});

	// 3. 等 AI 回复落位（CopyButton 出现 = 最终文字段渲染完成）
	const copyBtn = page.locator('[data-testid^="copy-"]').last();
	await expect(copyBtn).toBeVisible({ timeout: 180_000 });

	// 4. 下载 PNG：捕获 download 事件，断言文件名与 PNG 魔数
	const exportBtn = page.locator('[data-testid^="export-"]').last();
	await exportBtn.click();
	const [download] = await Promise.all([
		page.waitForEvent("download", { timeout: 60_000 }),
		page.getByTestId("export-download").click(),
	]);
	expect(download.suggestedFilename()).toMatch(/^wa-pi-chat-.*\.png$/);
	const path = await download.path();
	const buf = readFileSync(path!);
	expect([...buf.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]); // \x89PNG
	expect(buf.length).toBeGreaterThan(1000); // 非空图片

	// 5. 复制图片：断言剪贴板 write 被调（插桩计数 +1）
	await exportBtn.click();
	await page.getByTestId("export-copy").click();
	await expect
		.poll(() => page.evaluate(() => (window as any).__clipWrites), {
			timeout: 60_000,
		})
		.toBe(1);

	// 数据清理：会话/项目在 E2E_WA_PI_DIR 隔离目录内，global-teardown 整体清除；
	// 本用例不产生截图（Playwright 失败产物 test-results/ 跑完删除）。
});
