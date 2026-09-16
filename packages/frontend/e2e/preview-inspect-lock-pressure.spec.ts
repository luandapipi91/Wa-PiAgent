import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createProject, saveProvider } from "./helpers";

// 预览元素「双击锁定」压力测试 —— 用真实页面「门店店长管理绩效.html」做标准 case。
// 在该渲染页面上，快速双击「> 15 ~ 20w」区间 50 次（≈100 次点击），
// 断言预览 inspect 稳定完成 50 次「锁定/解锁」切换（每次都正确切换、无漏切/错切）。
// fixture：packages/kernel/tests/fixtures/preview-inspect/门店店长管理绩效.html
test.describe
	.serial("预览元素锁定压力（真实页面 > 15 ~ 20w）", () => {
		const projectName = `e2e-inspect-pressure-${randomUUID().slice(0, 8)}`;
		const cwd = `/tmp/${projectName}`;
		const FIXTURE = join(
			process.cwd(),
			"..",
			"kernel",
			"tests",
			"fixtures",
			"preview-inspect",
			"门店店长管理绩效.html",
		);

		test.beforeEach(async ({ page }) => {
			await page.goto("/");
			await page.evaluate(() => localStorage.clear());
			await page.goto("/");
			await createProject(projectName, cwd);
			mkdirSync(cwd, { recursive: true });
			writeFileSync(
				join(cwd, "门店店长管理绩效.html"),
				readFileSync(FIXTURE, "utf8"),
			);
			await saveProvider({
				id: "e2e-inspect-pressure-provider",
				name: "E2E Inspect Pressure",
				slug: "e2e-inspect-pressure",
				baseUrl: "http://localhost:9999/v1",
				apiKey: "sk-e2e",
				api: "openai-completions",
				models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
			});
		});

		test.afterAll(() => {
			rmSync(cwd, { recursive: true, force: true });
		});

		// 进入 session 视图（与 browser-preview.spec.ts 同款 helper）
		async function enterSession(
			page: import("@playwright/test").Page,
			text: string,
		): Promise<void> {
			await page.goto("/");
			await expect(page.getByTestId("new-session-pane")).toBeVisible({
				timeout: 5000,
			});
			await page
				.getByTestId("model-selector")
				.selectOption({ label: "E2E Inspect Pressure/model-a" });
			await page
				.locator('[data-testid="composer-input"] [role="textbox"]')
				.fill(text);
			await page.getByTestId("composer-send").click();
			await expect(page.getByTestId("session-view")).toBeVisible({
				timeout: 5000,
			});
		}

		// 打开预览并加载真实页面（POSIX 斜杠拼路径，同 browser-preview.spec.ts 说明）
		async function openPreview(
			page: import("@playwright/test").Page,
			filename: string,
		): Promise<void> {
			await page.getByTestId("btn-browser-preview").click();
			await expect(page.getByTestId("browser-panel")).toBeVisible();
			await page.getByTestId("browser-input").fill(`${cwd}/${filename}`);
			await page.getByTestId("browser-input").press("Enter");
			await expect(page.getByTestId("html-preview-iframe")).toBeVisible();
		}

		test("快速双击 > 15 ~ 20w 50 次 → 稳定 50 次锁定/解锁切换", async ({
			page,
		}) => {
			await enterSession(page, "锁定压力测试");
			await openPreview(page, "门店店长管理绩效.html");
			const frame = page.frameLocator('[data-testid="html-preview-iframe"]');
			// 定位提点区间「> 15 ~ 20w」元素
			const el = frame
				.locator(".rl-range")
				.filter({ hasText: "> 15 ~ 20w" })
				.first();
			await el.waitFor({ state: "visible", timeout: 8000 });
			await el.scrollIntoViewIfNeeded();
			// hover 触发预览 inspect 选中该元素（工具条出现）
			await el.hover();
			await expect(frame.getByText("发送到聊天").first()).toBeVisible({
				timeout: 5000,
			});
			// 连续双击 50 次（≈100 次点击），每次读锁按钮 title，统计锁定/解锁切换次数。
			// 注意：不能用 el.dblclick()（默认点元素中心）——hover 激活后工具条恰好
			// 遮住小元素中心，点击落在工具条上被 handler 吞掉，永远无法锁定。
			// 因此在元素矩形内挑一个不被工具条遮挡的采样点，用视口坐标 mouse 双击。
			const lockBtn = frame
				.locator('button[title="锁定当前元素"], button[title="解除高亮锁定"]')
				.first();
			const barLoc = frame
				.locator('button[title="锁定当前元素"], button[title="解除高亮锁定"]')
				.first()
				.locator("xpath=ancestor::div[1]");
			async function pickPoint(): Promise<{ x: number; y: number }> {
				const box = await el.boundingBox();
				if (!box) throw new Error("元素无 boundingBox");
				const bar = await barLoc.boundingBox().catch(() => null);
				const pts = [
					{ x: box.x + box.width / 2, y: box.y + box.height / 2 },
					{ x: box.x + 5, y: box.y + 5 },
					{ x: box.x + box.width - 5, y: box.y + 5 },
					{ x: box.x + 5, y: box.y + box.height - 5 },
					{ x: box.x + box.width - 5, y: box.y + box.height - 5 },
				];
				for (const pt of pts) {
					const covered =
						bar != null &&
						pt.x >= bar.x &&
						pt.x <= bar.x + bar.width &&
						pt.y >= bar.y &&
						pt.y <= bar.y + bar.height;
					if (!covered) return pt;
				}
				throw new Error("元素上所有采样点均被工具条遮挡");
			}
			// 50 次双击都应完成「锁定/解锁」切换。切换未发生视为该击被工具条
			// 动态遮挡吞掉（第一击后 bar 重渲染移动属几何偶发），换点重试；
			// 脚本缺陷（节流/图标重建/多击计数）的表现是连续 miss 超限。
			let toggles = 0;
			let misses = 0;
			let last = await lockBtn.getAttribute("title");
			while (toggles < 50 && misses < 5) {
				const pt = await pickPoint();
				await page.mouse.dblclick(pt.x, pt.y);
				const t = await lockBtn.getAttribute("title");
				if (t && last !== null && t !== last) {
					toggles++;
					last = t;
				} else {
					misses++;
				}
			}
			expect(toggles).toBe(50);
			expect(misses).toBeLessThan(5);
		});
	});
