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
// 媒体统一放项目下独立子目录：画廊改为「同目录」后缩略图条取当前文件所在目录的清单，
// 子目录能避开其它 spec 写入的文件，使目录内媒体固定为 4 项（3 图 + 1 视频）
const GALLERY_DIR = join(PROJ_CWD, "gallery");

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
	// 真实媒体落盘到 gallery/（/file 白名单内，且同目录画廊能列出）
	mkdirSync(GALLERY_DIR, { recursive: true });
	writeFileSync(join(GALLERY_DIR, "shot-a.png"), Buffer.from(PNG_B64, "base64"));
	writeFileSync(join(GALLERY_DIR, "shot-b.png"), Buffer.from(PNG_B64, "base64"));
	writeFileSync(join(GALLERY_DIR, "shot-c.png"), Buffer.from(PNG_B64, "base64"));
	// 视频必须真实落盘：画廊清单来自目录列举，只有消息里提到、磁盘上没有的文件不会进清单
	// （其 /file 请求仍被 stall，不会真的解码播放）
	writeFileSync(join(GALLERY_DIR, "clip.mp4"), Buffer.alloc(16));
}

/** 注入 assistant 消息：2 张连续图片（→ 网格）+ 独立成段的视频路径 */
async function injectMediaMessage(page: Page) {
	const imgA = toPosix(join(GALLERY_DIR, "shot-a.png"));
	const imgB = toPosix(join(GALLERY_DIR, "shot-b.png"));
	const imgC = join(GALLERY_DIR, "shot-c.png"); // 仅以反引号路径引用（芯片场景）；故意保留 Windows 反斜杠，覆盖归一化路径
	const video = toPosix(join(GALLERY_DIR, "clip.mp4")); // 请求被 stall，避免真实解码
	// 视频路径放 ```text 围栏块（模型常见输出习惯）；shot-c 仅以反引号行内代码引用（芯片场景）
	const text = `截图如下：\n\n![shot-a](${imgA})\n![shot-b](${imgB})\n\n\`\`\`text\n${video}\n\`\`\`\n\n补充路径 \`${imgC}\` 备用。`;
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

	// 2) 围栏块内视频路径 → 内联播放器（请求被 stall，元素稳定存在）
	await expect(page.getByTestId("inline-video").locator("video")).toBeVisible();

	// 3) 点击第 1 张图 → 画廊弹窗；缩略图条改为「同目录」（gallery/ 内 4 项：1 视频 + 3 图）
	await grid.getByTestId("md-image-card").first().click();
	await expect(page.getByTestId("media-preview-modal")).toBeVisible();
	await expect(page.getByTestId("media-thumbs")).toBeVisible();
	await expect(page.getByTestId("media-thumb")).toHaveCount(4);
	// 当前项定位到该图在目录清单中的位置（自然序：clip.mp4, shot-a, shot-b, shot-c）
	await expect(page.getByTestId("media-counter")).toHaveText("2 / 4");

	// 4) 右箭头在同一目录内切换（3/4、4/4 为图片），循环回 1/4 的视频项
	await page.getByTestId("media-next").click();
	await expect(page.getByTestId("media-counter")).toHaveText("3 / 4");
	await page.getByTestId("media-next").click();
	await expect(page.getByTestId("media-counter")).toHaveText("4 / 4");
	await page.getByTestId("media-next").click();
	await expect(page.getByTestId("media-counter")).toHaveText("1 / 4");
	await expect(page.getByTestId("media-video")).toBeVisible();

	// 5) 视频项「复制路径」→ 剪贴板读回绝对路径（clipboard 写入是异步的，轮询读回）
	await page.getByTestId("media-copy").click();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe(toPosix(join(GALLERY_DIR, "clip.mp4")));

	// 6) Esc 关闭
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("media-preview-modal")).toHaveCount(0);

	// 6.5) 拖标题栏移动窗口（位置持久化）：向右下拖 → 位置变化，Esc 关闭重开保持
	await grid.getByTestId("md-image-card").first().click();
	const mediaModal = page.getByTestId("media-preview-modal");
	await expect(mediaModal).toBeVisible();
	const beforePos = (await mediaModal.boundingBox())!;
	const mediaHandle = (await mediaModal
		.locator("[data-modal-drag-handle]")
		.first()
		.boundingBox())!;
	await page.mouse.move(mediaHandle.x + 60, mediaHandle.y + mediaHandle.height / 2);
	await page.mouse.down();
	await page.mouse.move(
		mediaHandle.x + 60 + 40,
		mediaHandle.y + mediaHandle.height / 2 + 30,
		{ steps: 5 },
	);
	await page.mouse.up();
	const afterPos = (await mediaModal.boundingBox())!;
	expect(afterPos.x).toBeGreaterThan(beforePos.x + 20);
	expect(afterPos.y).toBeGreaterThan(beforePos.y + 10);
	// 拖的是位置不是尺寸
	expect(Math.abs(afterPos.width - beforePos.width)).toBeLessThan(2);

	// 6.6) 拖右下角手柄改大小（尺寸持久化）
	const mediaResize = page.getByTestId("modal-resize-handle");
	const rb = (await mediaResize.boundingBox())!;
	await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
	await page.mouse.down();
	await page.mouse.move(rb.x + rb.width / 2 - 40, rb.y + rb.height / 2 - 30, {
		steps: 5,
	});
	await page.mouse.up();
	const afterResize = (await mediaModal.boundingBox())!;
	expect(afterResize.width).toBeLessThan(afterPos.width - 20);
	expect(afterResize.height).toBeLessThan(afterPos.height - 10);

	await page.keyboard.press("Escape");
	await expect(page.getByTestId("media-preview-modal")).toHaveCount(0);
	await grid.getByTestId("md-image-card").first().click();
	const reopened = (await page.getByTestId("media-preview-modal").boundingBox())!;
	expect(Math.abs(reopened.x - afterResize.x)).toBeLessThan(2);
	expect(Math.abs(reopened.y - afterResize.y)).toBeLessThan(2);
	expect(Math.abs(reopened.width - afterResize.width)).toBeLessThan(2);
	expect(Math.abs(reopened.height - afterResize.height)).toBeLessThan(2);
	await page.keyboard.press("Escape");

	// 7) 反引号路径芯片（行内 code 媒体路径）已渲染为图片卡片；点击 → 同目录清单定位到 shot-c（第 4 项）
	const cards = page.getByTestId("md-image-card");
	await expect(cards).toHaveCount(3); // 网格 2 张 + 芯片场景 1 张
	await cards.nth(2).click();
	await expect(page.getByTestId("media-preview-modal")).toBeVisible();
	await expect(page.getByTestId("media-counter")).toHaveText("4 / 4");
	await expect(page.getByTestId("zoomable-image")).toBeVisible();
	await page.keyboard.press("Escape");

	// 数据清理：E2E WA_PI_DIR 由 globalSetup 下轮整体清空重建；本用例不产截图文件
});
