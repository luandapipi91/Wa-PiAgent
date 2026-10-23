import { expect, test } from "@playwright/test";
import { ensureProvider } from "./helpers";

// 浏览器启动（无 Electron 桥）下，外观 tab 不应出现「桌面宠物」设置项：
// 没有 waPiPet 桥就建不了宠物窗口，显示开关会误导。
// （Electron 下该开关必须出现，由 e2e-electron/desktop-pet.spec.ts 覆盖。）
test.beforeAll(async () => {
	// 无 provider 时首启会弹 onboarding 向导，其 modal-overlay 会拦截设置弹窗的点击
	await ensureProvider();
});

test("浏览器模式：外观 tab 不出现「桌面宠物」开关，其余设置项照常", async ({
	page,
}) => {
	await page.goto("/");
	// 首次冷启动可能弹出引导/未配置模型 modal，先按 Escape 关闭再操作设置
	await page.keyboard.press("Escape");
	await page.getByTestId("settings-btn").click();
	await expect(page.getByTestId("settings-modal")).toBeVisible();
	await page.getByTestId("settings-nav-appearance").click();

	// 外观页已就绪（相邻开关可见）
	await expect(page.getByTestId("collapse-process-toggle")).toBeVisible();
	await expect(page.getByTestId("frog-task-done-toggle")).toBeVisible();

	// 桌宠开关不出现（反向断言）
	await expect(page.getByTestId("desktop-pet-toggle")).toHaveCount(0);
	// 也不出现它的文案（防「隐藏了控件但留了标题」）
	await expect(page.getByText("桌面宠物")).toHaveCount(0);
});
