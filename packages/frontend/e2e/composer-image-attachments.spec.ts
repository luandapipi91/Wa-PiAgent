// 图片附件展示 E2E（第四层）：真实浏览器 + 真实 kernel。
// 回归用户反馈：粘贴多张图片时附件区全部显示 image.png（浏览器给剪贴板位图的统一命名），
// 且只有图标没有预览。现在要求：
//   1) 按图片顺序显示 i18n 编号「图片1 / 图片2」，不再出现重复的 image.png
//   2) 每张图片渲染真实缩略图（/file?path= 真加载，naturalWidth > 0，不破图）
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createProject, saveProvider, setUiPrefs } from "./helpers";

// 1x1 PNG（最小合法图片，避免依赖外部素材）
const PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test.describe.serial("图片附件编号与缩略图", () => {
	test.beforeAll(async () => {
		// 预置假 provider：规避首启 onboarding 向导弹窗拦截交互
		await saveProvider({
			id: "e2e-img-att-provider",
			name: "E2E ImgAtt",
			slug: "e2e-img-att",
			baseUrl: "http://localhost:9999/v1",
			apiKey: "sk-e2e",
			api: "openai-completions",
			models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
		});
	});

	test("粘贴两张同名 image.png：显示 图片1/图片2，缩略图真实加载", async ({
		page,
	}) => {
		test.setTimeout(90_000);
		const projectName = `e2e-img-att-${randomUUID().slice(0, 8)}`;
		const project = await createProject(projectName, `/tmp/${projectName}`);

		// 固定中文界面：断言 i18n 文案「图片N」
		await setUiPrefs(page, "zh");
		await page.goto("/");
		await expect(page.getByTestId("new-session-pane")).toBeVisible({
			timeout: 10_000,
		});
		await page.getByTestId("project-select").selectOption(project.id);

		// 真实浏览器里派发带 2 个同名 image.png 的 paste（DataTransfer 构造，
		// 与系统剪贴板位图进入 handlePaste 的链路一致，绕开 headless 剪贴板权限）
		await page
			.locator('[data-testid="composer-input"] [contenteditable]')
			.evaluate((el, b64) => {
				const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
				const dt = new DataTransfer();
				for (let i = 0; i < 2; i++) {
					dt.items.add(new File([bytes], "image.png", { type: "image/png" }));
				}
				el.dispatchEvent(
					new ClipboardEvent("paste", {
						clipboardData: dt,
						bubbles: true,
						cancelable: true,
					}),
				);
			}, PNG_BASE64);

		const list = page.getByTestId("attachment-list");
		await expect(list.getByTestId("attachment-chip")).toHaveCount(2, {
			timeout: 20_000,
		});
		await expect(list).toContainText("图片1");
		await expect(list).toContainText("图片2");
		// 不再显示重复的原始文件名
		await expect(list).not.toContainText("image.png");

		// 缩略图：真实加载成功（naturalWidth > 0 证明 /file?path= 链路可用）
		const thumbs = list.getByTestId("attachment-thumb");
		await expect(thumbs).toHaveCount(2);
		await expect
			.poll(async () =>
				thumbs.evaluateAll((imgs) =>
					(imgs as HTMLImageElement[]).map((i) => i.naturalWidth),
				),
			)
			.toEqual([1, 1]);
	});

	// 回归用户反馈：图片 + 普通文件混排时，附件区多出一个大灰块。
	// 根因：附件行是 flex-wrap（默认 align-items: stretch），行高被最高的图片 chip
	// （56 缩略图 + 标签）撞高，文件胶囊的 bg + rounded-pill 背景被拉成一大块。
	test("图片与普通文件混排：文件胶囊不被行高拉伸", async ({ page }) => {
		test.setTimeout(90_000);
		const projectName = `e2e-mixed-att-${randomUUID().slice(0, 8)}`;
		const project = await createProject(projectName, `/tmp/${projectName}`);

		await setUiPrefs(page, "zh");
		await page.goto("/");
		await expect(page.getByTestId("new-session-pane")).toBeVisible({
			timeout: 10_000,
		});
		await page.getByTestId("project-select").selectOption(project.id);

		// drop 一次带入「一张图片 + 一个文本文件」，走真实上传链路
		await page
			.locator('[data-testid="composer-input"]')
			.evaluate((el, b64) => {
				const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
				const dt = new DataTransfer();
				dt.items.add(
					new File(["@echo off\n"], "start.bat", { type: "text/plain" }),
				);
				dt.items.add(new File([bytes], "image.png", { type: "image/png" }));
				el.dispatchEvent(
					new DragEvent("drop", {
						dataTransfer: dt,
						bubbles: true,
						cancelable: true,
					}),
				);
			}, PNG_BASE64);

		const list = page.getByTestId("attachment-list");
		await expect(list.getByTestId("attachment-chip")).toHaveCount(2, {
			timeout: 20_000,
		});
		const fileChip = list
			.getByTestId("attachment-chip")
			.filter({ hasText: "start.bat" });
		const imgChip = list
			.getByTestId("attachment-chip")
			.filter({ hasText: "图片1" });
		const fileBox = (await fileChip.boundingBox())!;
		const imgBox = (await imgChip.boundingBox())!;
		// 图片 chip 高（缩略图 + 标签）；文件胶囊保持自身高度，不被拉伸到行高
		expect(imgBox.height).toBeGreaterThan(60);
		expect(fileBox.height).toBeLessThan(40);
		expect(Math.abs(fileBox.y - imgBox.y)).toBeLessThan(4);
	});
});
