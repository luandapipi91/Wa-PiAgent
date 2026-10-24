// 图片标注覆盖保存 E2E（第四层）：真实浏览器 + 真实 kernel + 真实文件系统。
// 覆盖规格主链路：发送前附件缩略图 → 预览窗「标注」→ 画笔/矩形绘制 → 工具栏折叠展开 →
// 保存覆盖 uploads 原图（toast + 退出标注）→ 重新打开仍是 200×120 且含标注像素 →
// 内核侧读回文件字节已变、路径不变 → 缩略图 URL 带 `&v=`（跨提交隐性依赖回归封口断言）。
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2E_WA_PI_DIR, E2E_WS_PORT } from "../playwright.config";
import { createProject, saveProvider, setUiPrefs } from "./helpers";

/** 原图底色（明显区别于标注默认红 #E5484D，便于采样判定「是新画的标注」） */
const BASE_RGB = [30, 58, 138] as const;
const ANNOTATE_RGB = [229, 72, 77] as const;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 在页面里把 200×120 纯色画布导出成 PNG base64：标注尺寸与底色都可控 */
async function makeFixture(page: Page): Promise<string> {
	return page.evaluate(([r, g, b]) => {
		const canvas = document.createElement("canvas");
		canvas.width = 200;
		canvas.height = 120;
		const ctx = canvas.getContext("2d")!;
		ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		return canvas.toDataURL("image/png").split(",")[1];
	}, [...BASE_RGB] as [number, number, number]);
}

test.describe.serial("图片标注覆盖保存", () => {
	test.beforeAll(async () => {
		// 预置假 provider：规避首启 onboarding 向导弹窗拦截交互
		await saveProvider({
			id: "e2e-annotate-provider",
			name: "E2E Annotate",
			slug: "e2e-annotate",
			baseUrl: "http://localhost:9999/v1",
			apiKey: "sk-e2e",
			api: "openai-completions",
			models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
		});
	});

	test("附件缩略图 → 标注绘制 → 保存覆盖原图并刷新缩略图", async ({ page }) => {
		test.setTimeout(180_000);
		// 独立项目目录：uploads 里只有本次这一张图，同目录画廊清单固定为 1 项
		const projectName = `e2e-annotate-${randomUUID().slice(0, 8)}`;
		const projectCwd = join(E2E_WA_PI_DIR, projectName);
		mkdirSync(projectCwd, { recursive: true });
		const workDir = join(tmpdir(), "wa-pi-e2e-annotate");
		mkdirSync(workDir, { recursive: true });
		const shotAnnotator = join(workDir, "annotator-open.png");
		const shotSaved = join(workDir, "annotator-saved.png");
		const fixturePath = join(workDir, "annotate-source.png");
		let projectId = "";

		try {
			const project = await createProject(projectName, projectCwd);
			projectId = project.id;

			// 固定中文界面：断言「图片1」「已保存」等 i18n 文案
			await setUiPrefs(page, "zh");
			await page.goto("/");
			writeFileSync(
				fixturePath,
				Buffer.from(await makeFixture(page), "base64"),
			);
			const originalBytes = readFileSync(fixturePath);

			await expect(page.getByTestId("new-session-pane")).toBeVisible({
				timeout: 10_000,
			});
			await page.getByTestId("project-select").selectOption(project.id);

			// 真实用户路径：附件按钮上传 → 附件区缩略图
			await page.setInputFiles(
				'[data-testid="composer-input"] input[type="file"]',
				fixturePath,
			);
			const list = page.getByTestId("attachment-list");
			const chip = list.getByTestId("attachment-chip");
			await expect(chip).toHaveCount(1, { timeout: 20_000 });
			await expect(list).toContainText("图片1");
			const thumb = list.getByTestId("attachment-thumb");
			await expect
				.poll(() => thumb.evaluate((el) => (el as HTMLImageElement).naturalWidth))
				.toBe(200);

			// 上传后的缩略图 URL：/file?path=<abs>，此时还没有版本号
			const srcBefore = (await thumb.getAttribute("src")) ?? "";
			const absPath = new URL(srcBefore, "http://localhost").searchParams.get(
				"path",
			)!;
			expect(absPath).toContain(".wa-pi/uploads");
			expect(srcBefore).not.toContain("&v=");

			// 点缩略图 → 媒体预览窗；笔按钮仅发送前附件图片显示
			await chip.click();
			const modal = page.getByTestId("media-preview-modal");
			await expect(modal).toBeVisible({ timeout: 10_000 });
			// 入口是浮在图片右下角的圆形笔按钮（不是顶栏图标）：约 70×70、默认半透明
			const annotateBtn = page.getByTestId("media-annotate");
			await expect(annotateBtn).toBeVisible();
			const btnBox = (await annotateBtn.boundingBox())!;
			expect(Math.round(btnBox.width)).toBe(70);
			expect(Math.round(btnBox.height)).toBe(70);
			const btnOpacity = await annotateBtn.evaluate(
				(el) => getComputedStyle(el).opacity,
			);
			expect(Number(btnOpacity)).toBeLessThan(1);
			await annotateBtn.hover();
			await expect
				.poll(() =>
					annotateBtn.evaluate((el) => getComputedStyle(el).opacity),
				)
				.toBe("1");
			// 外面先放大到 125%：进编辑态后视角要一致（不重置回 100%）
			await page.getByTestId("media-zoom-in").click();
			await expect(page.getByTestId("media-zoom-percent")).toHaveText("125%");
			const previewImgTransform = await page
				.getByTestId("zoomable-image")
				.locator("img")
				.evaluate((el) => getComputedStyle(el).transform);
			expect(previewImgTransform).toContain("1.25");

			await annotateBtn.click();

			const annotator = page.getByTestId("image-annotator");
			const bar = page.getByTestId("annotator-bar");
			await expect(annotator).toBeVisible();
			await expect(bar).toBeVisible();
			const canvas = page.getByTestId("annotator-canvas");
			await expect
				.poll(() =>
					canvas.evaluate((el) => {
						const c = el as HTMLCanvasElement;
						return [c.width, c.height];
					}),
				)
				.toEqual([200, 120]);
			// 画布必须把原图铺进去（只画标注线时画布是透明的，用户看到「图片不见了」）：
			// 测试图是纯色底，中心像素应等于原图底色且不透明；修复前 alpha=0（只有标注线）
			const centerPixel = await canvas.evaluate((el) => {
				const c = el as HTMLCanvasElement;
				const ctx = c.getContext("2d")!;
				const d = ctx.getImageData(
					Math.floor(c.width / 2),
					Math.floor(c.height / 2),
					1,
					1,
				).data;
				return [d[0], d[1], d[2], d[3]];
			});
			expect(centerPixel).toEqual([...BASE_RGB, 255]);
			// 编辑态沿用外面的视角：顶栏百分比仍是 125%，画布的 transform 也是 1.25
			await expect(page.getByTestId("media-zoom-percent")).toHaveText("125%");
			const canvasTransform = await canvas.evaluate(
				(el) => getComputedStyle(el).transform,
			);
			expect(canvasTransform).toContain("1.25");
			// 编辑态也能缩放：顶栏 − + 改的是标注画布
			await page.getByTestId("media-zoom-in").click();
			await expect(page.getByTestId("media-zoom-percent")).toHaveText("156%");
			await page.getByTestId("media-zoom-out").click();
			await expect(page.getByTestId("media-zoom-percent")).toHaveText("125%");
			// 放大后的画布在视口里确实更大（rect 已含 transform，绘制换算才能自洽）
			const zoomedBox = (await canvas.boundingBox())!;
			expect(zoomedBox.width).toBeGreaterThan(200);

			await page.screenshot({ path: shotAnnotator });
			expect(statSync(shotAnnotator).size).toBeGreaterThan(0);
			// 零图形时保存无语义：按钮应为禁用，画一笔后才可用
			await expect(page.getByTestId("annotator-save")).toBeDisabled();

			// 工具可取消选中：默认画笔已选中，再点一次回到手掌（拖图模式）
			await expect(page.getByTestId("annotator-tool-pen")).toHaveAttribute(
				"aria-pressed",
				"true",
			);
			await page.getByTestId("annotator-tool-pen").click();
			await expect(page.getByTestId("annotator-tool-pen")).toHaveAttribute(
				"aria-pressed",
				"false",
			);
			await expect(page.getByTestId("annotator-tool-hand")).toHaveAttribute(
				"aria-pressed",
				"true",
			);
			// 先缩小到 80%：用户反馈「图片缩小后就不能拖了」——任何缩放下都应该能拖
			await page.getByTestId("media-zoom-out").click();
			await page.getByTestId("media-zoom-out").click();
			await expect(page.getByTestId("media-zoom-percent")).toHaveText("80%");
			// 手掌模式下拖拽只平移视角，不产生图形（撤销仍禁用）
			const panBefore = await canvas.evaluate((el) => el.style.transform);
			const hb = (await canvas.boundingBox())!;
			await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
			await page.mouse.down();
			await page.mouse.move(hb.x + hb.width / 2 + 20, hb.y + hb.height / 2 + 12, {
				steps: 4,
			});
			await page.mouse.up();
			await expect
				.poll(() => canvas.evaluate((el) => el.style.transform))
				.not.toBe(panBefore);
			// 从图片外的空白区按下也能拖（手掌层铺满整块编辑区，不必正好按在图上）
			const rootBox = (await annotator.boundingBox())!;
			const blankX = rootBox.x + 24;
			const blankY = rootBox.y + 24;
			const panBeforeBlank = await canvas.evaluate((el) => el.style.transform);
			await page.mouse.move(blankX, blankY);
			await page.mouse.down();
			await page.mouse.move(blankX + 18, blankY + 10, { steps: 4 });
			await page.mouse.up();
			await expect
				.poll(() => canvas.evaluate((el) => el.style.transform))
				.not.toBe(panBeforeBlank);
			await expect(page.getByTestId("annotator-undo")).toBeDisabled();

			// 继续拖第二次：位置应累加，而不是被「重置回中心」
			const panAfterFirst = await canvas.evaluate((el) => el.style.transform);
			const hb2 = (await canvas.boundingBox())!;
			await page.mouse.move(hb2.x + hb2.width / 2, hb2.y + hb2.height / 2);
			await page.mouse.down();
			await page.mouse.move(hb2.x + hb2.width / 2 + 20, hb2.y + hb2.height / 2 + 12, {
				steps: 4,
			});
			await page.mouse.up();
			await expect
				.poll(() => canvas.evaluate((el) => el.style.transform))
				.not.toBe(panAfterFirst);
			await expect(page.getByTestId("annotator-undo")).toBeDisabled();
			// 点回画笔：选中态恢复，光标不再是抓手
			await page.getByTestId("annotator-tool-pen").click();
			await expect(page.getByTestId("annotator-tool-pen")).toHaveAttribute(
				"aria-pressed",
				"true",
			);
			await expect(page.getByTestId("annotator-tool-hand")).toHaveAttribute(
				"aria-pressed",
				"false",
			);

			// 画笔：斜向拖一条
			const box = (await canvas.boundingBox())!;
			const at = (fx: number, fy: number) => ({
				x: box.x + box.width * fx,
				y: box.y + box.height * fy,
			});
			const from = at(0.1, 0.15);
			const to = at(0.85, 0.85);
			await page.mouse.move(from.x, from.y);
			await page.mouse.down();
			await page.mouse.move(to.x, to.y, { steps: 8 });
			await page.mouse.up();
			await expect(page.getByTestId("annotator-undo")).toBeEnabled();
			await expect(page.getByTestId("annotator-save")).toBeEnabled();

			// 矩形：换工具再拖一个
			await page.getByTestId("annotator-tool-rect").click();
			await expect(page.getByTestId("annotator-tool-rect")).toHaveAttribute(
				"aria-pressed",
				"true",
			);
			const r1 = at(0.2, 0.25);
			const r2 = at(0.75, 0.7);
			await page.mouse.move(r1.x, r1.y);
			await page.mouse.down();
			await page.mouse.move(r2.x, r2.y, { steps: 6 });
			await page.mouse.up();
			await expect(page.getByTestId("annotator-clear")).toBeEnabled();

			// 浮条不再可收起（保存右侧没有收起按钮，也不存在小笔折叠态）
			await expect(page.getByTestId("annotator-collapse")).toHaveCount(0);
			await expect(page.getByTestId("annotator-expand")).toHaveCount(0);
			await expect(bar).toBeVisible();

			// 点顶栏 ✕：有未保存图形 → 弹丢弃确认条
			await page.getByTestId("media-close").click();
			await expect(bar).toBeVisible();
			await expect(page.getByTestId("annotator-confirm")).toBeVisible();
			// 选「取消」：留在编辑态、窗口不关
			await page.getByTestId("annotator-confirm-no").click();
			await expect(page.getByTestId("annotator-confirm")).toHaveCount(0);
			await expect(modal).toBeVisible();
			await expect(annotator).toHaveCount(1);

			// 保存：成功 toast + 退出标注态
			await page.getByTestId("annotator-save").click();
			await expect(page.getByTestId("toast-container")).toContainText("已保存", {
				timeout: 15_000,
			});
			await expect(annotator).toHaveCount(0);
			await page.screenshot({ path: shotSaved });
			expect(statSync(shotSaved).size).toBeGreaterThan(0);

			// 封口断言：缩略图 URL 追加 &v= 版本号（缓存刷新）且指向同一路径
			await expect
				.poll(async () => (await thumb.getAttribute("src")) ?? "")
				.toContain("&v=");
			const srcAfter = (await thumb.getAttribute("src")) ?? "";
			expect(new URL(srcAfter, "http://localhost").searchParams.get("path")).toBe(
				absPath,
			);
			// 缩略图换新地址后仍能真实加载
			await expect
				.poll(() => thumb.evaluate((el) => (el as HTMLImageElement).naturalWidth))
				.toBe(200);

			// 关闭预览 → 重新打开：尺寸不变，像素里出现标注色
			await page.getByTestId("media-close").click();
			await expect(modal).toHaveCount(0);
			await chip.click();
			await expect(modal).toBeVisible({ timeout: 10_000 });
			const previewImg = modal
				.getByTestId("zoomable-image")
				.locator("img")
				.first();
			await expect
				.poll(() =>
					previewImg.evaluate((el) => {
						const i = el as HTMLImageElement;
						return [i.naturalWidth, i.naturalHeight];
					}),
				)
				.toEqual([200, 120]);
			const sampled = await previewImg.evaluate(
				(el, [base, mark]) => {
					const img = el as HTMLImageElement;
					const c = document.createElement("canvas");
					c.width = img.naturalWidth;
					c.height = img.naturalHeight;
					const ctx = c.getContext("2d")!;
					ctx.drawImage(img, 0, 0);
					const d = ctx.getImageData(0, 0, c.width, c.height).data;
					const hit = (
						rgb: [number, number, number],
						p: number,
					): boolean =>
						Math.abs(d[p] - rgb[0]) <= 12 &&
						Math.abs(d[p + 1] - rgb[1]) <= 12 &&
						Math.abs(d[p + 2] - rgb[2]) <= 12;
					let annotated = 0;
					let backdrop = 0;
					for (let p = 0; p < d.length; p += 4) {
						if (hit(mark as [number, number, number], p)) annotated += 1;
						else if (hit(base as [number, number, number], p)) backdrop += 1;
					}
					return { annotated, backdrop };
				},
				[[...BASE_RGB], [...ANNOTATE_RGB]] as [
					[number, number, number],
					[number, number, number],
				],
			);
			// 画笔 + 矩形两条红色标注都应落在图内；原底色仍占绝大多数
			expect(sampled.annotated).toBeGreaterThan(500);
			expect(sampled.backdrop).toBeGreaterThan(10_000);
			await page.getByTestId("media-close").click();

			// 内核侧读回：文件内容已变、PNG 结构完好、路径不变（同一条 /file?path=）
			const res = await fetch(
				`http://127.0.0.1:${E2E_WS_PORT}/file?path=${encodeURIComponent(absPath)}&cb=${Date.now()}`,
				{ cache: "no-store" },
			);
			expect(res.status).toBe(200);
			const overwritten = Buffer.from(await res.arrayBuffer());
			expect(overwritten.equals(originalBytes)).toBe(false);
			expect(overwritten.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
			expect(overwritten.length).toBeGreaterThan(200);
		} finally {
			// 关掉页面再删目录：Windows 上浏览器尚未释放的 /file 响应句柄会让 rmdir 偶发 EBUSY
			await page.goto("about:blank").catch(() => {});
			if (projectId) {
				await fetch(
					`http://127.0.0.1:${E2E_WS_PORT}/api/projects/${encodeURIComponent(projectId)}`,
					{ method: "DELETE" },
				).catch(() => {});
			}
			// 项目 cwd（含 uploads 副本）不在这里删：kernel 刚服务过该图的 /file 请求，
			// Windows 上 rmdir 必报 EBUSY；整个 ~/.wa-pi-e2e 由 globalTeardown 整体清除。
			// 这里只清本用例自己的临时素材与截图（tmpdir）。
			if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
		}
	});
});
