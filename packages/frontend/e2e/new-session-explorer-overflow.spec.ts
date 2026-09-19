// 新建会话 × 文件树撑高整行 E2E（第四层验证，jsdom 无布局引擎、组件测试只能断言 class 契约）：
// 回归 bug：新建会话根行（flex-1 flex min-w-0）缺 min-h-0，flex 子项 automatic minimum size
// 被文件树内容高度撑破 → 整行溢出 → 排在主列文档流末端的输入框被祖先 overflow-hidden
// 裁出视口，且滚动不可达。
// 修复契约：根行 min-h-0 钳制行高，树内容由 aside 内部 flex-1 overflow-auto 吸收为内部滚动。
// 验证场景：项目指向文件极多的真实目录，展开文件树后断言输入框 bounding rect 仍在视口内。
import { test, expect } from "@playwright/test";
import { join } from "node:path";
import { saveProvider, createProject } from "./helpers";

// cwd 指向本仓库根（process.cwd() = packages/frontend，上两级）：源码文件足够多，树内容必然远超视口高
const REPO_CWD = join(process.cwd(), "..", "..");

test("新建会话：文件树内容很高时输入框仍在视口内", async ({ page }) => {
	test.setTimeout(90_000);
	// 预置假 provider：避免首次启动向导弹窗遮挡
	await saveProvider({
		id: "e2e-explorer-overflow",
		name: "E2E Explorer",
		slug: "e2e-explorer-overflow",
		baseUrl: "http://localhost:9999/v1",
		apiKey: "sk-e2e",
		api: "openai-completions",
		models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
	});
	const project = await createProject("e2e-explorer-overflow", REPO_CWD);

	// 视口调矮：仓库根顶层文件有限（目录默认折叠，树初始约 700px），
	// 矮视口等价复现用户场景「树内容高 > 视口高」，不依赖树内部展开细节
	await page.setViewportSize({ width: 1280, height: 400 });
	await page.goto("/");
	const pane = page.getByTestId("new-session-pane");
	await expect(pane).toBeVisible({ timeout: 10_000 });

	// 选项目 → workspaceDir 就位 → 文件树开关出现 → 展开
	await page.getByTestId("project-select").selectOption(project.id);
	const toggle = page.getByTestId("btn-new-session-explorer");
	await expect(toggle).toBeVisible({ timeout: 10_000 });
	await toggle.click();
	const aside = page.getByTestId("new-session-explorer-aside");
	await expect(aside).toBeVisible();

	// 等文件列表真实加载完成（异步 fetch）：滚动发生在文件树自己的滚动容器里。
	// 树已改为 react-virtuoso 虚拟滚动（提交 4dd20fc6）——真正承载滚动的是内部
	// virtuoso scroller，不再是 .flex-1.overflow-auto 包装层（包装层自身
	// scrollHeight==clientHeight）。改为取 aside 内溢出最大的后代，兼容具体虚拟化实现。
	await expect(aside.locator(".ep-node").first()).toBeVisible({
		timeout: 15_000,
	});
	await expect
		.poll(
			async () =>
				await page.evaluate(() => {
					const asideEl = document.querySelector<HTMLElement>(
						"[data-testid='new-session-explorer-aside']",
					);
					if (!asideEl) return -1;
					let max = -1;
					for (const el of asideEl.querySelectorAll<HTMLElement>("*")) {
						const over = el.scrollHeight - el.clientHeight;
						if (over > max) max = over;
					}
					return max;
				}),
			{ timeout: 15_000 },
		)
		.toBeGreaterThan(100);

	// 真实 flex 引擎下的布局指标（取树内容溢出最大的后代作为滚动容器指标）
	const m = await page.evaluate(() => {
		const paneEl = document.querySelector<HTMLElement>(
			"[data-testid='new-session-pane']",
		)!;
		const asideRoot = document.querySelector<HTMLElement>(
			"[data-testid='new-session-explorer-aside']",
		)!;
		// virtuoso 虚拟滚动下的滚动容器不再固定为 .flex-1.overflow-auto：取溢出最大的后代
		let asideEl = asideRoot;
		let maxOver = -1;
		for (const el of asideRoot.querySelectorAll<HTMLElement>("*")) {
			const over = el.scrollHeight - el.clientHeight;
			if (over > maxOver) {
				maxOver = over;
				asideEl = el;
			}
		}
		const composer =
			document.querySelector<HTMLElement>(
				"[data-testid='new-session-scroll'] [contenteditable='true']",
			) ??
			document.querySelector<HTMLElement>(
				"[data-testid='new-session-scroll'] textarea",
			);
		return {
			viewportH: window.innerHeight,
			paneH: paneEl.clientHeight,
			asideScrollH: asideEl.scrollHeight,
			asideClientH: asideEl.clientHeight,
			composerRect: composer?.getBoundingClientRect(),
		};
	});

	// 场景成立：树内容确实远高于滚动容器可视高（内部滚动生效，复现条件满足）
	expect(m.asideScrollH).toBeGreaterThan(m.asideClientH + 100);
	// 根行未被撑破：行高不超过视口
	expect(m.paneH).toBeLessThanOrEqual(m.viewportH);
	// 输入框完整可见：底边不越过视口底（修复前：整行被撑高，输入框被裁出视口外）
	expect(m.composerRect).toBeTruthy();
	expect(m.composerRect!.bottom).toBeLessThanOrEqual(m.viewportH);
	expect(m.composerRect!.top).toBeLessThan(m.viewportH);
});
