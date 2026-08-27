// 文件树右键菜单视口钳制 E2E（第四层验证，jsdom 无布局引擎）：
// 回归 bug：ep-ctx-menu 用 e.clientY 原样作 position:fixed 的 top，无边界检测 →
// 树底部文件右键时菜单固定向下展开、底部菜单项超出窗口不可点击。
// 修复契约：菜单渲染后实测尺寸钳制到视口内（复用 ProjectItem 的 useClampMenu）。
// 验证：矮视口 + 树滚到底 + 右键最底部文件 → 菜单整体在视口内 → 最底部菜单项真实可点。
import { test, expect } from "@playwright/test";
import { join } from "node:path";
import { saveProvider, createProject } from "./helpers";

const REPO_CWD = join(process.cwd(), "..", "..");

test("文件树底部文件右键：菜单不出窗口且最底部项可点", async ({ page }) => {
	test.setTimeout(90_000);
	// 预置假 provider：避免首次启动向导弹窗遮挡
	await saveProvider({
		id: "e2e-ctx-menu-clamp",
		name: "E2E CtxMenu",
		slug: "e2e-ctx-menu-clamp",
		baseUrl: "http://localhost:9999/v1",
		apiKey: "sk-e2e",
		api: "openai-completions",
		models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
	});
	const project = await createProject("e2e-ctx-menu-clamp", REPO_CWD);

	// 矮视口：等价复现「树内容高 > 视口」的用户场景
	await page.setViewportSize({ width: 1280, height: 400 });
	await page.goto("/");
	await page.getByTestId("project-select").selectOption(project.id);
	await page.getByTestId("btn-new-session-explorer").click();
	await page.waitForSelector(".ep-node", { timeout: 15_000 });

	// 树滚到底：最底部文件贴近视口底（右键点它的 clientY 接近视口高）
	await page.evaluate(() => {
		const tree = document.querySelector<HTMLElement>(".ep-tree");
		if (tree) tree.scrollTop = tree.scrollHeight;
	});
	const lastNode = page.locator(".ep-node").last();
	await lastNode.click({ button: "right" });

	const menu = page.locator(".ep-ctx-menu");
	await expect(menu).toBeVisible({ timeout: 5_000 });

	// 菜单整体在视口内：底边不越过视口底（修复前：top=clientY 固定向下，底边越界）
	const menuBox = await menu.boundingBox();
	const viewportH = 400;
	expect(menuBox).toBeTruthy();
	expect(menuBox!.y).toBeGreaterThanOrEqual(0);
	expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(viewportH);

	// 最底部菜单项也在视口内（此前正是它不可点）
	const lastItem = menu.locator(".ep-ctx-item").last();
	const itemBox = await lastItem.boundingBox();
	expect(itemBox).toBeTruthy();
	expect(itemBox!.y + itemBox!.height).toBeLessThanOrEqual(viewportH);

	// 真实点击最底部菜单项（「复制路径」，无副作用）成功——修复前 Playwright 会因
	// 目标在视口外而点击失败/超时
	await lastItem.click({ timeout: 5_000 });
	// 点击后菜单关闭（既有 onClose 行为）即为点击生效的旁证
	await expect(menu).toBeHidden({ timeout: 5_000 });
});
