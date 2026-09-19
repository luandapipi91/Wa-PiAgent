import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createProject, saveProvider } from "./helpers";

// 嵌套 srcdoc iframe 预览回归：PRD 页内嵌 <iframe srcdoc="…">（原型页），
// 在 wa-pi 预览（kernel /preview + sandbox 不透明源 + inspect 注入）下，
// 原型区域应正常渲染出完整数据表，不得空白/无法预览。
// 自包含：外层 PRD 壳由用例生成，内层 srcdoc 用仓库 fixture
// packages/kernel/tests/fixtures/preview-inspect/门店店长管理绩效.html
//（原目标页 /Users/co/Documents/work/hlk/prd/hlk-2026Q3_0901_0915/PRD-岗位的总业绩提成核算阶梯.html
// 是用户私有文件，仓库与 CI 机器上均不存在 → 用例跑到 fixture 拷贝处直接 ENOENT）
test.describe
	.serial("嵌套 srcdoc iframe 预览", () => {
		const projectName = `e2e-srcdoc-${randomUUID().slice(0, 8)}`;
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
		// 写进项目 cwd 后再预览（kernel /preview 限项目内文件）
		const NESTED_NAME = "nested-prd.html";

		// 自包含嵌套页：外层 PRD 壳 + <iframe id="protoFrame" srcdoc="…fixture…">，
		// 保留用例要验的结构（嵌套 srcdoc 子文档，inspect 由父页代注入）。
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
			await createProject(projectName, cwd);
			mkdirSync(cwd, { recursive: true });
			writeFileSync(join(cwd, NESTED_NAME), buildNestedPrdPage());
			void readFileSync(FIXTURE, "utf8"); // fixture 存在性自检
			await saveProvider({
				id: "e2e-srcdoc-provider",
				name: "E2E Srcdoc",
				slug: "e2e-srcdoc",
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
				.selectOption({ label: "E2E Srcdoc/model-a" });
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

		test("PRD 内嵌 srcdoc 原型（> 15 ~ 20w 所在页）正常渲染", async ({
			page,
		}) => {
			await enterSession(page, "嵌套 srcdoc 预览测试");
			await openPreview(page, NESTED_NAME);
			// 外层预览 = PRD 页（kernel /preview 注入 inspect），内层 = srcdoc 原型
			const outer = page.frameLocator('[data-testid="html-preview-iframe"]');
			// PRD 页自身的双栏标题可见（外层渲染 OK）
			await expect(outer.getByText("PRD × 原型 · 双栏预览")).toBeVisible({
				timeout: 8000,
			});
			// 内层 srcdoc 原型：JS 渲染，就绪后可见阶梯表（原断言用的是私有 PRD 页文案
			// 「业绩提成表」，改为仓库 fixture 中等价的 JS 渲染标记）
			const inner = outer.frameLocator("#protoFrame");
			await expect(
				inner.locator(".rl-range").filter({ hasText: "> 15 ~ 20w" }).first(),
			).toBeVisible({ timeout: 8000 });
			// 内层原型是 JS 渲染的数据表：确认表格真实渲染（而非空白）
			await expect(inner.locator("table").first()).toBeVisible();
			await expect(inner.locator("#tableBody tr").first()).toBeVisible();
			// 原型自身交互控件可见：导出表格按钮（原断言为私有页的「未排除任何项目」）
			await expect(inner.getByText("导出表格")).toBeVisible();
			// hover 内层 srcdoc 元素：inspect 高亮框 + 工具条应出现（嵌套选中能力）
			await inner.locator("table").first().hover();
			// 诊断：读内/外层高亮层的隐藏原因（render 各提前 return 会写 data-hide-reason）
			const hideReason = await inner
				.locator('div[data-hide-reason], div[style*="2147483646"]')
				.first()
				.getAttribute("data-hide-reason");
			const outerReason = await outer
				.locator('div[data-hide-reason], div[style*="2147483646"]')
				.first()
				.getAttribute("data-hide-reason");
			console.log(
				"[诊断] 外层 hl hideReason =",
				outerReason,
				"| 内层 hl hideReason =",
				hideReason,
			);
			// 决定性诊断：手动向 srcdoc 下发 set(enabled=true)（模拟主应用正确下发）——
			// 若 bar 出现 = 开关同步链路断了；若仍不出现 = render 其它隐藏路径
			await page.evaluate(() => {
				document
					.querySelector('[data-testid="html-preview-iframe"]')
					?.contentWindow?.postMessage(
						{ type: "hiagent:inspect:set", enabled: true },
						"*",
					);
			});
			await expect(inner.getByText("发送到聊天").first()).toBeVisible({
				timeout: 5000,
			});
			await expect(inner.getByText("选择父级").first()).toBeVisible();
		});
	});
