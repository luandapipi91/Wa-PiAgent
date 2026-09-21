// 画廊缩略图破图回归：默认工作区会话的真实工作目录是 workdir/<createdAt>/ 子目录，
// agent 回复里的相对路径（image.png）此前被拼到项目 cwd（父目录）→ /file 404 → 缩略图破图。
// 修复后相对路径应拼会话子目录；绝对路径不受影响。
import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync, copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_WA_PI_DIR } from "../playwright.config";
import { saveProvider } from "./helpers";

const SESSION_ID = "s-e2e-thumb-086";
const CREATED_AT = 1789872144129;
const SUB_DIR = join(E2E_WA_PI_DIR, "workdir", String(CREATED_AT));

// 最小合法 PNG（1x1 红色像素）
const PNG_1PX = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

function seed() {
	const projPath = join(E2E_WA_PI_DIR, "projects.json");
	const data = JSON.parse(readFileSync(projPath, "utf8"));
	if (!data.sessions.some((s: any) => s.id === SESSION_ID)) {
		data.sessions.push({
			id: SESSION_ID,
			projectId: "__system__",
			primaryAgent: "dev",
			title: "缩略图破图回归",
			createdAt: CREATED_AT,
			lastActivity: CREATED_AT,
			piSessionFile: join(E2E_WA_PI_DIR, "sessions", `${SESSION_ID}.jsonl`),
		});
		writeFileSync(projPath, JSON.stringify(data, null, 2), "utf8");
	}
	// 真实图片放进会话子目录（默认工作区会话的真实工作目录）
	mkdirSync(SUB_DIR, { recursive: true });
	copyFileSync("e2e/fixtures/px-red.png", join(SUB_DIR, "image.png"));
	copyFileSync("e2e/fixtures/px-red.png", join(SUB_DIR, "image2.png"));
	mkdirSync(join(E2E_WA_PI_DIR, "sessions"), { recursive: true });
	const abs = join(SUB_DIR, "image2.png");
	const line = (id: string, parentId: string | null, role: string, text: string, ts: number) =>
		JSON.stringify({ type: "message", id, parentId, message: { role, content: [{ type: "text", text }], timestamp: ts } });
	writeFileSync(join(E2E_WA_PI_DIR, "sessions", `${SESSION_ID}.jsonl`), [
		JSON.stringify({ type: "session", version: 3, id: "e2e-thumb-uuid" }),
		line("m1", null, "user", "给我输出一个图片", 1),
		line(
			"m2",
			"m1",
			"assistant",
			`**产出文件**：\`${abs}\`\n\n两张图并存：\`image.png\`、\`image2.png\``,
			2,
		),
	].join("\n"), "utf8");
}

test("媒体画廊缩略图：混合相对/绝对路径的默认工作区会话不出现破图", async ({ page }) => {
	test.setTimeout(60_000);
	// 隔离环境默认无 provider：App 首启弹 onboarding 向导（modal-overlay）拦截点击
	// （同 automation.spec / settings-sound.spec 模式），先预置假 provider 关掉向导
	await saveProvider({
		id: "e2e-thumb-provider",
		name: "E2E Thumb",
		slug: "e2e-thumb",
		baseUrl: "http://localhost:9999/v1",
		apiKey: "sk-e2e",
		api: "openai-completions",
		models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
	});
	seed();
	await page.goto("/");
	// 选中会话
	await page.getByText("缩略图破图回归").first().click();
	// 绝对路径 code 渲染为图片卡片（md-image-card），相对路径保持行内 code；
	// 用户点卡片「放大」→ 画廊 items=collectMediaItems(整块文本)=3 项（绝对+两个相对）
	await expect(page.getByTestId("md-image-card")).toHaveCount(1, { timeout: 15_000 });
	await page.getByTestId("md-image-zoom").click();
	await expect(page.getByTestId("media-thumbs")).toBeVisible();
	const thumbs = page.locator('[data-testid="media-thumbs"] img');
	await expect(thumbs).toHaveCount(3);
	// 全部缩略图真实加载成功（无破图：naturalWidth > 0）
	await page.waitForFunction(
		() => {
			const imgs = document.querySelectorAll('[data-testid="media-thumbs"] img');
			return imgs.length === 3 && Array.from(imgs).every((i) => (i as HTMLImageElement).naturalWidth > 0);
		},
		{ timeout: 15_000 },
	);
	const widths = await thumbs.evaluateAll((els) =>
		els.map((e) => (e as HTMLImageElement).naturalWidth),
	);
	expect(widths).toEqual([1, 1, 1]);
});
