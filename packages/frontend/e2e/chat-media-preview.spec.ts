// 对话媒体内联预览 E2E（第四层）：真实浏览器 + 真实 kernel /file。
// 数据准备（ask-stale.spec 模式）：projects.json 写会话记录 + page.route 注入 assistant 消息，
// 不依赖真实 LLM；真实 PNG 落盘到 e2e-proj-1 cwd（/file 白名单内，真实可加载）；
// 视频 /file 请求拦截后故意不应答，<video> 保持加载中不触发 onerror 降级。
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_WA_PI_DIR } from "../playwright.config";
import { saveProvider } from "./helpers";

const SESSION_ID = "s-e2e-media-001";
const PROJ_CWD = join(E2E_WA_PI_DIR, "e2e-project");

// 1×1 透明 PNG（真实可解码，浏览器能触发 img onLoad）
const PNG_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function toPosix(p: string): string {
	return p.replace(/\\/g, "/");
}

function seedSession() {
	const projPath = join(E2E_WA_PI_DIR, "projects.json");
	const data = JSON.parse(readFileSync(projPath, "utf8"));
	if (!data.sessions.some((s: any) => s.id === SESSION_ID)) {
		data.sessions.push({
			id: SESSION_ID,
			projectId: "e2e-proj-1",
			primaryAgent: "dev",
			title: "E2E媒体预览",
			createdAt: 1,
			lastActivity: 1,
			piSessionFile: join(E2E_WA_PI_DIR, "sessions", `${SESSION_ID}.jsonl`),
		});
		writeFileSync(projPath, JSON.stringify(data, null, 2), "utf8");
	}
	mkdirSync(join(E2E_WA_PI_DIR, "sessions"), { recursive: true });
	writeFileSync(
		join(E2E_WA_PI_DIR, "sessions", `${SESSION_ID}.jsonl`),
		JSON.stringify({ type: "session", version: 3, id: "e2e-media-uuid" }) + "\n",
		"utf8",
	);
	// 真实图片落盘到项目 cwd（/file 白名单内）
	writeFileSync(join(PROJ_CWD, "shot-a.png"), Buffer.from(PNG_B64, "base64"));
	writeFileSync(join(PROJ_CWD, "shot-b.png"), Buffer.from(PNG_B64, "base64"));
	writeFileSync(join(PROJ_CWD, "shot-c.png"), Buffer.from(PNG_B64, "base64"));
}

/** 注入 assistant 消息：2 张连续图片（→ 网格）+ 独立成段的视频路径 */
async function injectMediaMessage(page: Page) {
	const imgA = toPosix(join(PROJ_CWD, "shot-a.png"));
	const imgB = toPosix(join(PROJ_CWD, "shot-b.png"));
	const imgC = toPosix(join(PROJ_CWD, "shot-c.png")); // 仅以反引号路径引用（FilePill 场景）
	const video = toPosix(join(PROJ_CWD, "clip.mp4")); // 不落盘：请求被 stall
	const text = `截图如下：\n\n![shot-a](${imgA})\n![shot-b](${imgB})\n\n${video}\n\n补充路径 \`${imgC}\` 备用。`;
	await page.route(`**/api/sessions/${SESSION_ID}/messages`, (route) =>
		route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({
				type: "session:messages",
				sessionId: SESSION_ID,
				messages: [
					{
						message: {
							role: "assistant",
							content: [{ type: "text", text }],
							model: "m",
							stopReason: "end_turn",
							timestamp: 1,
						},
						agentName: "dev",
					},
				],
				isActive: false,
				thinkingSince: null,
			}),
		}),
	);
	// 视频 /file 请求故意不应答：保持 <video> 加载中，避免 onerror 降级为 FilePill
	await page.route(/\/file\?.*clip\.mp4/, () => {});
}

test("对话媒体：缩略图网格 + 内联视频 + 画廊切换 + 视频复制路径", async ({
	page,
	context,
}) => {
	test.setTimeout(120_000);
	await saveProvider({
		id: "e2e-media-provider",
		name: "E2E Media",
		slug: "e2e-media",
		baseUrl: "http://localhost:9999/v1",
		apiKey: "sk-e2e",
		api: "openai-completions",
		models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
	});
	seedSession();
	await injectMediaMessage(page);
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);

	await page.goto("/");
	const row = page.getByTestId(`session-${SESSION_ID}`);
	await expect(row).toBeVisible({ timeout: 10_000 });
	await row.click();
	await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 10_000 });

	// 1) 连续 2 图 → 2 列网格，缩略图真实加载（naturalWidth > 0）
	const grid = page.getByTestId("md-image-grid");
	await expect(grid).toBeVisible({ timeout: 10_000 });
	await expect(grid.getByTestId("md-image-card")).toHaveCount(2);
	await expect
		.poll(async () =>
			grid.locator("img").first().evaluate((el) => (el as HTMLImageElement).naturalWidth),
		)
		.toBeGreaterThan(0);
	// 尺寸行填充
	await expect(grid.getByTestId("md-image-dims").first()).toContainText("1×1");

	// 2) 视频段落 → 内联播放器（请求被 stall，元素稳定存在）
	await expect(page.getByTestId("inline-video").locator("video")).toBeVisible();

	// 3) 点击第 1 张图 → 画廊弹窗，计数 1 / 4（2 图 + 视频 + 反引号路径图片）
	await grid.getByTestId("md-image-card").first().click();
	await expect(page.getByTestId("media-preview-modal")).toBeVisible();
	await expect(page.getByTestId("media-counter")).toHaveText("1 / 4");

	// 4) 右箭头切到视频项（3 / 4），autoplay 视频可见
	await page.getByTestId("media-next").click();
	await expect(page.getByTestId("media-counter")).toHaveText("2 / 4");
	await page.getByTestId("media-next").click();
	await expect(page.getByTestId("media-counter")).toHaveText("3 / 4");
	await expect(page.getByTestId("media-video")).toBeVisible();

	// 5) 视频项「复制路径」→ 剪贴板读回绝对路径（clipboard 写入是异步的，轮询读回）
	await page.getByTestId("media-copy").click();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe(toPosix(join(PROJ_CWD, "clip.mp4")));

	// 6) Esc 关闭
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("media-preview-modal")).toHaveCount(0);

	// 7) 反引号路径芯片（FilePill）点击 → 同一画廊打开并定位到第 4 项（图片）
	await page.getByTestId("file-pill").click();
	await expect(page.getByTestId("media-preview-modal")).toBeVisible();
	await expect(page.getByTestId("media-counter")).toHaveText("4 / 4");
	await expect(page.getByTestId("zoomable-image")).toBeVisible();
	await page.keyboard.press("Escape");

	// 数据清理：E2E WA_PI_DIR 由 globalSetup 下轮整体清空重建；本用例不产截图文件
});
