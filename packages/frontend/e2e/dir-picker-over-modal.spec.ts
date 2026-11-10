import { test, expect } from "@playwright/test";
import { ensureProvider, setUiPrefs } from "./helpers";

// 回归：新建知识库弹窗内点「浏览」→ 目录选择器必须盖在弹窗之上且可真实点击。
//
// 缺陷形态（修复前）：DirTreePicker 是普通渲染节点，z-index 只在同一层叠上下文内比较。
// 它被渲染在 SettingsModal 的 Modal（portal 到 body、z-50）层叠上下文内，
// 而 KbFormModal 自己的 Modal 也是 portal 到 body、z-50 且挂载更晚，
// 于是在根上下文压住整个设置子树——目录选择器被新建弹窗遮挡，无法操作。
//
// 断言分两层：① 命中测试（选择器中心点最上层元素属于选择器）；
// ② 真实交互（点「取消」真的能关掉选择器，证明点击没被上层弹窗吞掉）。

test("新建知识库弹窗内「浏览」：目录选择器盖在弹窗之上且可操作", async ({
	page,
}) => {
	test.setTimeout(120_000);
	await ensureProvider(); // 防 onboarding 向导拦截点击
	await setUiPrefs(page, "zh");
	await page.goto("/", { timeout: 60_000 });

	// 设置 → 知识库 → 新建
	await page.getByTestId("settings-btn").click();
	await expect(page.getByTestId("settings-modal")).toBeVisible();
	await page.getByTestId("settings-nav-knowledge").click();
	await expect(page.getByTestId("kb-page")).toBeVisible();
	await page.getByTestId("kb-add-button").click();
	await expect(page.getByTestId("kb-form-modal")).toBeVisible();

	// 浏览器环境无 Electron 原生目录对话框 → 回退目录树选择器
	await page.getByTestId("kb-browse").click();
	const picker = page.getByTestId("dir-picker");
	await expect(picker).toBeVisible();

	// ① 命中测试：选择器几何中心的最上层元素必须落在选择器内部（没被弹窗压住）
	await expect
		.poll(
			() =>
				page.evaluate(() => {
					const el = document.querySelector('[data-testid="dir-picker"]');
					if (!el) return "no-picker";
					const r = el.getBoundingClientRect();
					const hit = document.elementFromPoint(
						r.left + r.width / 2,
						r.top + r.height / 2,
					);
					if (!hit) return "no-hit";
					if (!el.contains(hit)) {
						const owner = hit.closest("[data-testid]");
						return `blocked-by:${owner?.getAttribute("data-testid") ?? hit.tagName}`;
					}
					return "picker-top";
				}),
			{ timeout: 10_000 },
		)
		.toBe("picker-top");

	// ② 真实交互：点选择器的「取消」→ 选择器关闭（点击确实到达覆盖层）
	await page.getByTestId("dir-cancel").click();
	await expect(picker).toBeHidden({ timeout: 10_000 });
	// 新建弹窗仍在（取消选择器不应连带关闭表单弹窗）
	await expect(page.getByTestId("kb-form-modal")).toBeVisible();
});
