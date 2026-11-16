// 三套风格化主题 E2E（第四层）：真实浏览器 + 隔离 kernel。
//
// 验证：
// 1. 报纸 / 像素 / 赛博 切换后 <html data-theme> 与关键 token（底色、字体栈、圆角、强调色）生效；
// 2. 用户选过蓝色强调色再切报纸，强调色必须回到印章红（新主题自带配色）；
// 3. 装饰层（纸纤维/点阵/扫描线）不拦截点击：输入框可聚焦。
import { test, expect } from "@playwright/test";
import { ensureProvider, setUiPrefs } from "./helpers";

// 无 provider 时首启会弹 onboarding 向导，其 modal-overlay 会拦截点击（其他 spec 同样处理）
test.beforeAll(async () => {
	await ensureProvider();
});

type ThemeCase = {
	theme: string;
	canvas: string;
	fontFamily: string;
	radius: string;
	accent: string;
};

const CASES: ThemeCase[] = [
	{
		theme: "newspaper",
		canvas: "#f4ecd8",
		fontFamily: "Noto Serif SC",
		radius: "0px",
		accent: "#a32f27",
	},
	{
		theme: "pixel",
		canvas: "#1a1526",
		fontFamily: "Fusion Pixel",
		radius: "0px",
		accent: "#ffd34e",
	},
	{
		theme: "cyber",
		canvas: "#05070a",
		fontFamily: "JetBrains Mono",
		radius: "2px",
		accent: "#00f0ff",
	},
];

for (const c of CASES) {
	test(`${c.theme} 主题：data-theme / 底色 / 字体栈 / 圆角 / 强调色生效`, async ({
		page,
	}) => {
		await setUiPrefs(page, "zh", { themeMode: c.theme });
		await page.goto("/");
		await expect(page.locator("html")).toHaveAttribute("data-theme", c.theme);

		const s = await page.evaluate(() => {
			const root = getComputedStyle(document.documentElement);
			return {
				canvas: root.getPropertyValue("--canvas").trim().toLowerCase(),
				radius: root.getPropertyValue("--rounded-md").trim(),
				accent: root.getPropertyValue("--accent").trim().toLowerCase(),
				font: getComputedStyle(document.body).fontFamily,
			};
		});
		expect(s.canvas).toBe(c.canvas);
		expect(s.radius).toBe(c.radius);
		expect(s.accent).toBe(c.accent);
		// 断言的是声明的字体栈顺序（字体文件未加载时同样成立）
		expect(s.font).toContain(c.fontFamily);
	});
}

test("选过蓝色强调色后切报纸主题，强调色仍为印章红", async ({ page }) => {
	await setUiPrefs(page, "zh", {
		themeMode: "newspaper",
		themeColor: "blue",
	});
	await page.goto("/");
	await expect(page.locator("html")).toHaveAttribute("data-theme", "newspaper");
	await expect(page.locator("html")).toHaveAttribute("data-accent", "blue");
	const accent = await page.evaluate(() =>
		getComputedStyle(document.documentElement)
			.getPropertyValue("--accent")
			.trim()
			.toLowerCase()
	);
	expect(accent).toBe("#a32f27");
});

test("赛博主题下装饰层不拦截点击：可正常打开系统设置", async ({ page }) => {
	await setUiPrefs(page, "zh", { themeMode: "cyber" });
	await page.goto("/");
	// 扫描线是 fixed 覆盖全屏的伪元素：能点到左栏按钮、能关掉启动弹窗，说明点击未被拦截
	const closeBtn = page.getByRole("button", { name: "关闭" });
	if (await closeBtn.count()) await closeBtn.first().click();

	await page.getByTestId("settings-btn").click();
	await expect(page.getByTestId("settings-nav-appearance")).toBeVisible();
});
