import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createProject, saveProvider } from "./helpers";

// 回归防线：锁定选中元素后，顶部开关「关闭→重新打开」不得破坏选中能力。
// 背景（2026-09-01 用户报告 + E2E 复实）：
//  1) 关闭的 set(enabled=false) 走 message 分支未清锁定 → 重开被 pinned 拦死；
//  2) 嵌套场景清锁未广播 lock(false) → 父层抑制链不断 → 子层被 hold:true 永久抑制，
//     表现为「重开后再也没有高亮」。
// 两处修复均在 preview-inspect.js 的清锁路径（setDisabled + message set 分支）。
test.describe
	.serial("元素选中：锁定后开关关开不失效（单层 + 嵌套）", () => {
		const projectName = `e2e-inspect-reset-${randomUUID().slice(0, 8)}`;
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
		// 自包含嵌套页：外层 PRD 壳 + <iframe id="protoFrame" srcdoc="…fixture…">。
		// 原用例读用户私有路径 PRD-岗位的总业绩提成核算阶梯.html（本机不存在 → ENOENT），
		// 改用仓库 fixture 作内层 srcdoc 内容，保留用例真正要验的结构：嵌套 srcdoc 子文档
		// （inspect 由父页代注入）内的锁定/开关复位链路。
		const NESTED_NAME = "nested-prd.html";
		function buildNestedPrdPage(): string {
			const inner = readFileSync(FIXTURE, "utf8")
				.replace(/&/g, "&amp;")
				.replace(/"/g, "&quot;");
			return [
				'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />',
				"<title>PRD × 原型 · 双栏预览</title>",
				"<style>html,body{margin:0;height:100%;font:14px/1.6 system-ui,sans-serif}",
				".wrap{display:flex;height:100%}.col{flex:1;padding:12px;overflow:auto}",
				".proto{border-left:1px solid #ddd}iframe{width:100%;height:100%;border:0}</style>",
				'</head><body><div class="wrap">',
				'<div class="col"><h1>PRD × 原型 · 双栏预览</h1><p>嵌套 srcdoc 原型预览。</p></div>',
				'<div class="col proto"><iframe id="protoFrame" srcdoc="',
				inner,
				'"></iframe></div>',
				"</div></body></html>",
			].join("");
		}

		test.beforeEach(async ({ page }) => {
			await page.goto("/");
			await page.evaluate(() => localStorage.clear());
			await page.goto("/");
			mkdirSync(cwd, { recursive: true });
			try {
				await createProject(projectName, cwd);
			} catch (e) {
				// serial 用例共用 cwd：项目已存在时继续使用
				if (!String(e).includes("duplicate")) throw e;
			}
			writeFileSync(
				join(cwd, "门店店长管理绩效.html"),
				readFileSync(FIXTURE, "utf8"),
			);
			await saveProvider({
				id: "e2e-inspect-reset-provider",
				name: "E2E Inspect Reset",
				slug: "e2e-inspect-toggle",
				baseUrl: "http://localhost:9999/v1",
				apiKey: "sk-e2e",
				api: "openai-completions",
				models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
			});
		});

		test.afterAll(() => {
			rmSync(cwd, { recursive: true, force: true });
		});

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
				.selectOption({ label: "E2E Inspect Reset/model-a" });
			await page
				.locator('[data-testid="composer-input"] [role="textbox"]')
				.fill(text);
			await page.getByTestId("composer-send").click();
			await expect(page.getByTestId("session-view")).toBeVisible({
				timeout: 5000,
			});
		}

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

		test("锁定 → 开关关 → 开 → hover 重新选中", async ({ page }) => {
			test.setTimeout(60_000);
			await enterSession(page, "开关复现测试");
			await openPreview(page, "门店店长管理绩效.html");
			const frame = page.frameLocator('[data-testid="html-preview-iframe"]');
			const el = frame
				.locator(".rl-range")
				.filter({ hasText: "> 15 ~ 20w" })
				.first();
			await el.waitFor({ state: "visible", timeout: 8000 });
			await el.scrollIntoViewIfNeeded();
			const lockBtn = frame
				.locator('button[title="锁定当前元素"], button[title="解除高亮锁定"]')
				.first();

			// ① hover 选中 → 双击锁定
			await el.hover();
			await expect(frame.getByText("发送到聊天").first()).toBeVisible({
				timeout: 5000,
			});
			// 点锁头按钮锁定（工具条可能遮挡小元素的点击落点，锁头点击不经页面 hit-testing）。
			// hover 后 bar 刚出现、布局未稳，点击可能落空（render 移动了按钮）→ 带重试
			let t1 = await lockBtn.getAttribute("title");
			for (let i = 0; i < 3 && t1 !== "解除高亮锁定"; i++) {
				await page.waitForTimeout(250);
				await lockBtn.click();
				t1 = await lockBtn.getAttribute("title");
			}
			expect(t1).toBe("解除高亮锁定");

			// ② 点顶部开关关闭（真实 UI 点击）
			await page.getByTestId("browser-inspect").click();
			await page.waitForTimeout(500);
			// 关闭后 UI 隐藏（锁头不可见）
			await expect(
				frame
					.locator('button[title="锁定当前元素"], button[title="解除高亮锁定"]')
					.first(),
			).toBeHidden();

			// ③ 再点开关打开
			await page.getByTestId("browser-inspect").click();
			await page.waitForTimeout(500);

			// ④ hover 元素 → 工具条应重新出现（用户报「再也没有高亮」）
			await el.hover();
			await expect(frame.getByText("发送到聊天").first()).toBeVisible({
				timeout: 5000,
			});
			const t4 = await lockBtn.getAttribute("title");
			expect(t4).toBe("锁定当前元素");

			// ⑤ 闭环：再点锁头锁定
			await lockBtn.click();
			const t5 = await lockBtn.getAttribute("title");
			expect(t5).toBe("解除高亮锁定");
		});

		test("嵌套 srcdoc：锁定内层元素 → 开关关 → 开 → hover 恢复", async ({
			page,
		}) => {
			test.setTimeout(60_000);
			await enterSession(page, "嵌套开关复现");
			writeFileSync(join(cwd, NESTED_NAME), buildNestedPrdPage());
			await page.getByTestId("btn-browser-preview").click();
			await expect(page.getByTestId("browser-panel")).toBeVisible();
			await page.getByTestId("browser-input").fill(`${cwd}/${NESTED_NAME}`);
			await page.getByTestId("browser-input").press("Enter");
			await expect(page.getByTestId("html-preview-iframe")).toBeVisible();
			const outer = page.frameLocator('[data-testid="html-preview-iframe"]');
			// 外层 PRD 壳已渲染（非空白页）
			await expect(outer.getByText("PRD × 原型 · 双栏预览").first()).toBeVisible({
				timeout: 8000,
			});
			const inner = outer.frameLocator("#protoFrame");
			// 内层 srcdoc 原型：JS 渲染的阶梯表就绪
			await expect(
				inner.locator(".rl-range").filter({ hasText: "> 15 ~ 20w" }).first(),
			).toBeVisible({ timeout: 8000 });
			const innerTable = inner.locator("table").first();
			await innerTable.scrollIntoViewIfNeeded();
			// hover 内层元素 → 内层工具条出现
			await innerTable.hover();
			await expect(inner.getByText("发送到聊天").first()).toBeVisible({
				timeout: 5000,
			});
			// 点内层锁头锁定。注意 preview-inspect 锁头有 400ms 防连点节流
			// （preview-inspect.js：`lastLockTap = 0` + `performance.now()` 是文档相对时钟），
			// 内层 srcdoc 文档刚创建 400ms 内的首击会被吞（探针实测：首击落在文档 376ms 处 →
			// 被 return，第 2 击 954ms 才生效）→ 与单层用例同款「点击落空」重试，
			// 最终仍断言必须锁定成功。
			const innerLock = inner
				.locator('button[title="锁定当前元素"], button[title="解除高亮锁定"]')
				.first();
			let it1 = await innerLock.getAttribute("title");
			for (let i = 0; i < 3 && it1 !== "解除高亮锁定"; i++) {
				await page.waitForTimeout(400);
				await innerLock.click();
				it1 = await innerLock.getAttribute("title");
			}
			expect(it1).toBe("解除高亮锁定");
			// 开关关 → 开（真实 UI）
			await page.getByTestId("browser-inspect").click();
			await page.waitForTimeout(500);
			await page.getByTestId("browser-inspect").click();
			await page.waitForTimeout(500);
			// hover 内层元素 → 工具条应重新出现（用户场景）
			await innerTable.hover();
			await expect(inner.getByText("发送到聊天").first()).toBeVisible({
				timeout: 5000,
			});
			const it2 = await innerLock.getAttribute("title");
			expect(it2).toBe("锁定当前元素");
		});
	});
