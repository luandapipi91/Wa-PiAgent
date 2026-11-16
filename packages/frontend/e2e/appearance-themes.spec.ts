// 五套风格化主题 E2E（第四层）：真实浏览器 + 隔离 kernel。
//
// 验证：
// 1. 报纸 / 像素 / 赛博 / 鎏金 / 战术 切换后 <html data-theme> 与关键 token（底色、字体栈、圆角、强调色）生效；
// 2. 用户选过蓝色强调色再切报纸，强调色必须回到印章红（新主题自带配色）；
// 3. 装饰层（纸纤维/点阵/扫描线）不拦截点击：输入框可聚焦；
// 4. 鎏金的两段式（深色侧栏 + 浅色主体）在真实渲染上成立，且深色作用域不漏进弹窗；
// 5. 战术的纯黑画布上没有任何浅色块。
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
	{
		theme: "gilded",
		canvas: "#e8e4d9",
		fontFamily: "MiSans",
		radius: "4px",
		accent: "#cdbe91",
	},
	{
		theme: "tactical",
		canvas: "#000000",
		fontFamily: "PingFang SC",
		radius: "0px",
		accent: "#0ff796",
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

// 下面三条断言的是「浏览器渲染出来的颜色」，不是 token 是否存在。
// 统一一次量出相关元素的感知亮度（0~1，WCAG 系数）；元素缺失时给 -1，
// 让断言失败而不是假通过。
function measureLuminance(page: import("@playwright/test").Page) {
	return page.evaluate(() => {
		const rgbLum = (c: string) => {
			const m = c.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/);
			if (!m) return null;
			return (
				(Number(m[1]) * 0.299 + Number(m[2]) * 0.587 + Number(m[3]) * 0.114) /
				255
			);
		};
		// 支持 #rgb / #rrggbb（侧栏的 --text-primary 是十六进制字面值）
		const hexLum = (h: string) => {
			const raw = h.trim().replace(/^#/, "");
			const full =
				raw.length === 3
					? raw
							.split("")
							.map((ch) => ch + ch)
							.join("")
					: raw;
			if (!/^[0-9a-f]{6}$/i.test(full)) return null;
			const at = (i: number) => parseInt(full.slice(i, i + 2), 16);
			return (at(0) * 0.299 + at(2) * 0.587 + at(4) * 0.114) / 255;
		};

		const bgLum = (el: Element | null) =>
			el ? rgbLum(getComputedStyle(el).backgroundColor) ?? -1 : -1;

		const sidebar = document.querySelector('[data-testid="sidebar"]');
		// 主区背景在 .bg-canvas 容器上（<main> 自身无背景类，取它会得到透明 rgba(0,0,0,0)）
		const canvasEl = document.querySelector(".bg-canvas");
		// 侧栏文字色是内联 style 的 var(--text-primary)，没有对应 class：
		// 直接读侧栏作用域内的变量值，正好验「作用域覆盖是否生效」这个被测点
		const sidebarText = sidebar
			? hexLum(getComputedStyle(sidebar).getPropertyValue("--text-primary")) ?? -1
			: -1;
		// 所有 surface 类元素的背景亮度：只看单个选择器容易命中透明 wrapper，
		// 拿全量最大值才能证明「页面上没有任何浅色块」
		const surfaces = Array.from(
			document.querySelectorAll(
				".bg-surface, .bg-surface-elevated, .bg-surface-hover",
			)
		)
			.map((el) => rgbLum(getComputedStyle(el).backgroundColor))
			.filter((v): v is number => v !== null);

		return {
			canvas: bgLum(canvasEl),
			sidebarBg: bgLum(sidebar),
			sidebarText,
			modal: bgLum(document.querySelector('[data-testid="settings-modal"]')),
			surfaceCount: surfaces.length,
			maxSurface: surfaces.length ? Math.max(...surfaces) : -1,
		};
	});
}

test("鎏金主题下侧栏是深色、主区是浅色、侧栏文字可读（两段式）", async ({
	page,
}) => {
	await setUiPrefs(page, "zh", { themeMode: "gilded" });
	await page.goto("/");
	const lum = await measureLuminance(page);
	expect(lum.sidebarBg).toBeLessThan(0.2); // 侧栏深
	expect(lum.canvas).toBeGreaterThan(0.6); // 主区浅
	expect(lum.sidebarText).toBeGreaterThan(0.6); // 侧栏文字亮（深底上可读）
});

test("鎏金主题下打开系统设置，弹窗仍是浅色（侧栏深色作用域不泄漏）", async ({
	page,
}) => {
	await setUiPrefs(page, "zh", { themeMode: "gilded" });
	await page.goto("/");
	// 启动弹窗若在，其遮罩会拦截点击（与赛博装饰层用例同款处理）
	const closeBtn = page.getByRole("button", { name: "关闭" });
	if (await closeBtn.count()) await closeBtn.first().click();

	await page.getByTestId("settings-btn").click();
	await expect(page.getByTestId("settings-modal")).toBeVisible();
	// 弹窗 portal 到 body（不在侧栏作用域内）：--surface 应取根作用域的暖白
	const lum = await measureLuminance(page);
	// 同一时刻对照：侧栏依旧深、弹窗浅——深色只活在侧栏作用域里
	expect(lum.sidebarBg).toBeLessThan(0.2);
	expect(lum.modal).toBeGreaterThan(0.6);
});

test("战术主题下画布纯黑、surface 卡片与弹窗都是暗色（无刺眼白块）", async ({
	page,
}) => {
	await setUiPrefs(page, "zh", { themeMode: "tactical" });
	await page.goto("/");
	const home = await measureLuminance(page);
	expect(home.canvas).toBeLessThan(0.05); // 纯黑画布
	expect(home.surfaceCount).toBeGreaterThan(0); // 防空集合假通过
	expect(home.maxSurface).toBeLessThan(0.15);

	// 首页几乎没有 surface 卡片，弹窗是 var(--surface) 卡片（与消息卡同 token），
	// 补上它才能真的证明「黑底上没有刺眼白块」
	const closeBtn = page.getByRole("button", { name: "关闭" });
	if (await closeBtn.count()) await closeBtn.first().click();
	await page.getByTestId("settings-btn").click();
	await expect(page.getByTestId("settings-modal")).toBeVisible();
	const opened = await measureLuminance(page);
	expect(opened.modal).toBeGreaterThanOrEqual(0); // 量不到就是量错了，不当假通过
	expect(opened.modal).toBeLessThan(0.15);
});

test("外观页从 select 切到报纸/像素：主题生效且主题颜色整块隐藏", async ({ page }) => {
	await setUiPrefs(page, "zh", { themeMode: "light" });
	await page.goto("/");
	await page.getByTestId("settings-btn").click();
	await page.getByTestId("settings-nav-appearance").click();

	// 浅色下主题颜色可见
	await expect(page.getByTestId("theme-color-row")).toBeVisible();
	await page.getByTestId("theme-mode-select").selectOption("newspaper");
	await expect(page.locator("html")).toHaveAttribute("data-theme", "newspaper");
	// 固定配色主题下整块隐藏
	await expect(page.getByTestId("theme-color-row")).toHaveCount(0);
	await page.getByTestId("theme-mode-select").selectOption("light");
	await expect(page.getByTestId("theme-color-row")).toBeVisible();
});
