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

test("赛博主题下无全屏扫描线装饰层，点击正常（波纹已移除）", async ({ page }) => {
	await setUiPrefs(page, "zh", { themeMode: "cyber" });
	await page.goto("/");
	// 2026-11-17 用户反馈：扫描线流动像波纹、影响视觉，已整体移除。
	// 负向断言：body::before 不再有内容（新报纸/像素主题的静态纹理不受影响）。
	const overlayContent = await page.evaluate(
		() => getComputedStyle(document.body, "::before").content,
	);
	expect(["none", "normal", ""].includes(overlayContent)).toBe(true);

	const closeBtn = page.getByRole("button", { name: "关闭" });
	if (await closeBtn.count()) await closeBtn.first().click();

	await page.getByTestId("settings-btn").click();
	await expect(page.getByTestId("settings-nav-appearance")).toBeVisible();
});

// 下面三条断言的是「浏览器渲染出来的颜色」，不是 token 是否存在。
// 统一一次量出相关元素的感知亮度（0~1，WCAG 系数）。
// 量不到（元素不存在 / 背景透明）一律返回 null：**不能给 0/-1 之类哨兵值**，
// 否则 `toBeLessThan` 断言会被哨兵值混过去（-1 < 0.2、0 < 0.05 都是绿）。
function measureLuminance(page: import("@playwright/test").Page) {
	return page.evaluate(() => {
		const rgbLum = (c: string) => {
			// 现代浏览器可能是 rgb(0, 0, 0) / rgb(0 0 0 / 50%) 两种形态
			const m = c.match(/rgba?\(([^)]+)\)/);
			if (!m) return null;
			const parts = m[1]
				.split(/[,\s/]+/)
				.filter(Boolean)
				.map(Number);
			if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
			// 透明/半透明：页面上看到的是叠在底色上的合成结果，单看这一层算不出可信亮度
			// （rgba(0,0,0,0) 若当纯黑，会让「画布纯黑」假通过）→ 视为量不到
			const alpha = parts.length > 3 ? parts[3] : 1;
			if (!(alpha >= 1)) return null;
			return (
				(parts[0] * 0.299 + parts[1] * 0.587 + parts[2] * 0.114) / 255
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
			el ? rgbLum(getComputedStyle(el).backgroundColor) : null;

		const sidebar = document.querySelector('[data-testid="sidebar"]');
		// 主区背景在画布容器上（<main> 自身无背景类，取它会得到透明 rgba(0,0,0,0)）。
		// 限定 #root 的直接子元素：会话视图里 MessageList 也用了 .bg-canvas，
		// 裸 .bg-canvas 会静默取到别处
		const mainCanvas = document.querySelector("#root > .bg-canvas");
		// 侧栏文字色是内联 style 的 var(--text-primary)，没有对应 class：
		// 直接读侧栏作用域内的变量值，正好验「作用域覆盖是否生效」这个被测点
		const sidebarText = sidebar
			? hexLum(getComputedStyle(sidebar).getPropertyValue("--text-primary"))
			: null;
		// 所有 surface 类元素的背景亮度：只看单个选择器容易命中透明 wrapper，
		// 拿全量最大值才能证明「页面上没有任何浅色块」。
		// 显式把首屏恒在的输入卡（bg-surface，ComposerInput 的圆角盒子）加进样本：
		// 不能拿某个徽标恰好带底色当唯一采样点——装饰层把徽标刷成透明就会让样本集变空，
		// 那不是装饰错了，是采样点选错了。
		const surfaceEls = [
			...document.querySelectorAll(
				".bg-surface, .bg-surface-elevated, .bg-surface-hover",
			),
			document.querySelector('[data-testid="composer-input"] > .rounded-2xl'),
		];
		const surfaces = surfaceEls
			.map((el) => (el ? rgbLum(getComputedStyle(el).backgroundColor) : null))
			.filter((v): v is number => v !== null);

		return {
			mainCanvas: bgLum(mainCanvas),
			sidebarBg: bgLum(sidebar),
			sidebarText,
			modal: bgLum(document.querySelector('[data-testid="settings-modal"]')),
			surfaceCount: surfaces.length,
			maxSurface: surfaces.length ? Math.max(...surfaces) : null,
		};
	});
}

/** 断言「暗」：量不到就红（null 不得被当成暗色放过） */
function expectDark(v: number | null, max: number, what: string) {
	expect(v, `${what}：未能量到亮度（元素缺失或背景透明）`).not.toBeNull();
	expect(v as number, `${what}：亮度应 < ${max}`).toBeLessThan(max);
}

/** 断言「亮」：量不到就红 */
function expectLight(v: number | null, min: number, what: string) {
	expect(v, `${what}：未能量到亮度（元素缺失或取色失败）`).not.toBeNull();
	expect(v as number, `${what}：亮度应 > ${min}`).toBeGreaterThan(min);
}

test("鎏金主题下侧栏是深色、主区是浅色、侧栏文字可读（两段式）", async ({
	page,
}) => {
	await setUiPrefs(page, "zh", { themeMode: "gilded" });
	await page.goto("/");
	const lum = await measureLuminance(page);
	expectDark(lum.sidebarBg, 0.2, "侧栏背景");
	expectLight(lum.mainCanvas, 0.6, "主区画布");
	expectLight(lum.sidebarText, 0.6, "侧栏文字色（--text-primary）");
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
	expectDark(lum.sidebarBg, 0.2, "侧栏背景");
	expectLight(lum.modal, 0.6, "系统设置弹窗背景");
});

// 覆盖边界（故意写清楚，别让标题读起来比实测更全）：
// - 首页真实存在的 surface 卡片是「输入卡」（ComposerInput 的 rounded-2xl，bg-surface）；
//   样本集固定包含它，不再靠「某个徽标恰好带了底色」凑数（装饰层把徽标刷成透明时
//   样本集就会变空，那是采样点选错，不是装饰错）；
// - 主区消息气泡（MessageList 的 bg-surface）需要发一条真消息才渲染，本用例不覆盖。
// 断言口径：画布必须纯黑，surface 样本与弹窗卡片都不能是白块。
test("战术主题下画布纯黑、surface 样本与弹窗卡片无刺眼白块（真消息气泡未覆盖）", async ({
	page,
}) => {
	await setUiPrefs(page, "zh", { themeMode: "tactical" });
	await page.goto("/");
	// 等输入卡就位再量：首屏是异步渲染的，量太早会拿到空样本集（假绿/假红都不难发生）
	await expect(page.getByTestId("composer-input")).toBeVisible();
	const home = await measureLuminance(page);
	expectDark(home.mainCanvas, 0.05, "主区画布");
	expect(home.surfaceCount).toBeGreaterThan(0); // 防空集合假通过
	expectDark(home.maxSurface, 0.15, "页面最亮的 surface 元素");

	// 补上弹窗这张真卡片（同上：与消息卡同 token）
	const closeBtn = page.getByRole("button", { name: "关闭" });
	if (await closeBtn.count()) await closeBtn.first().click();
	await page.getByTestId("settings-btn").click();
	await expect(page.getByTestId("settings-modal")).toBeVisible();
	const opened = await measureLuminance(page);
	expectDark(opened.modal, 0.15, "系统设置弹窗背景");
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

// 装饰层零回归：鎏金/战术两套新主题新增的装饰元素与规则，
// 不得泄漏到既有五个主题（含 system 解析出的 light/dark）。
// 基线值取于未上装饰层时的实测（见 CHANGELOG 对应条目）。
const DECOR_BASELINE: Record<
	string,
	{ tabRadius: string; tabBg: string }
> = {
	light: { tabRadius: "8px", tabBg: "rgb(255, 255, 255)" },
	dark: { tabRadius: "8px", tabBg: "rgb(44, 44, 46)" },
	newspaper: { tabRadius: "0px", tabBg: "rgb(250, 245, 230)" },
	pixel: { tabRadius: "0px", tabBg: "rgb(36, 30, 56)" },
	cyber: { tabRadius: "2px", tabBg: "rgb(12, 20, 28)" },
};

for (const [theme, base] of Object.entries(DECOR_BASELINE)) {
	test(`${theme}：装饰层零回归（无新增元素、tab 样式与原值一致）`, async ({
		page,
	}) => {
		await setUiPrefs(page, "zh", { themeMode: theme });
		await page.goto("/");
		const m = await page.evaluate(() => {
			const tab = document.querySelector('[data-testid="sidebar-tab-tasks"]');
			const ts = tab ? getComputedStyle(tab) : null;
			return {
				tabRadius: ts?.borderRadius ?? null,
				tabBg: ts?.backgroundColor ?? null,
				extCount: document.querySelectorAll(".ep-ext").length,
				connLedCount: document.querySelectorAll('[data-testid="session-conn-led"]').length,
			};
		});
		// 既有主题下不得出现装饰层新增的元素
		expect(m.extCount).toBe(0);
		expect(m.connLedCount).toBe(0);
		// tab 是装饰层改动过的元素，既有主题的样式必须与原值逐字一致
		expect(m.tabRadius).toBe(base.tabRadius);
		expect(m.tabBg).toBe(base.tabBg);
	});
}

// ===== 自绘标题栏（macOS 桌面版）=====
// 浏览器里 window.waPiApp 不存在，组件按设计不渲染；这里注入一个假的 darwin 平台
// 来验证「渲染条件 + 8 套主题配色跟随」这层逻辑。真实窗口外观（红绿灯位置、
// titleBarStyle 生效）只能在打完包的桌面应用里看，自动化覆盖不到。
test.describe("自绘标题栏", () => {
	test("macOS 桌面环境下渲染，鎏金用衬线金字单行", async ({ page }) => {
		await page.addInitScript(() => {
			(window as unknown as { waPiApp?: unknown }).waPiApp = {
				platform: "darwin",
			};
		});
		await setUiPrefs(page, "zh", { themeMode: "gilded" });
		await page.goto("/");

		const bar = page.getByTestId("titlebar");
		await expect(bar).toBeVisible();
		// 纯黑底（设计稿 --topbar）
		expect(
			await bar.evaluate((el) => getComputedStyle(el).backgroundColor),
		).toBe("rgb(10, 10, 10)");
		// 副标只表示「在哪」：没有选中项目时是固定文案，与主题无关
		await expect(page.getByTestId("titlebar-theme")).toHaveText("你的小助手");
		// 鎏金是单行（baseline 横排），青绿短条不出现
		expect(
			await bar
				.locator(".titlebar-masthead")
				.evaluate((el) => getComputedStyle(el).flexDirection),
		).toBe("row");
		expect(
			await page
				.locator(".titlebar-bar")
				.evaluate((el) => getComputedStyle(el).display),
		).toBe("none");
	});

	test("战术终端：报头双行 + 青绿短条，副标等宽", async ({ page }) => {
		await page.addInitScript(() => {
			(window as unknown as { waPiApp?: unknown }).waPiApp = {
				platform: "darwin",
			};
		});
		await setUiPrefs(page, "zh", { themeMode: "tactical" });
		await page.goto("/");

		const bar = page.getByTestId("titlebar");
		await expect(bar).toBeVisible();
		expect(
			await bar.evaluate((el) => getComputedStyle(el).backgroundColor),
		).toBe("rgb(0, 0, 0)");
		await expect(page.getByTestId("titlebar-theme")).toHaveText("你的小助手");
		// 战术是报头形态：masthead 纵排、青绿短条出现
		expect(
			await bar
				.locator(".titlebar-masthead")
				.evaluate((el) => getComputedStyle(el).flexDirection),
		).toBe("column");
		const barDisplay = await page
			.locator(".titlebar-bar")
			.evaluate((el) => getComputedStyle(el).display);
		expect(barDisplay).not.toBe("none");
	});

	test("Windows 桌面环境也渲染，标题绝对居中不受系统按钮区影响", async ({
		page,
	}) => {
		await page.addInitScript(() => {
			(window as unknown as { waPiApp?: unknown }).waPiApp = {
				platform: "win32",
				setTitleBarOverlay: () => Promise.resolve(true),
			};
		});
		await setUiPrefs(page, "zh", { themeMode: "newspaper" });
		await page.goto("/");

		const bar = page.getByTestId("titlebar");
		await expect(bar).toBeVisible();
		await expect(page.getByTestId("titlebar-theme")).toHaveText("你的小助手");
		// masthead 是绝对定位居中：中心点应与窗口水平中心重合（偏差 ≤2px）
		const offset = await page.evaluate(() => {
			const masthead = document.querySelector(".titlebar-masthead");
			if (!masthead) return null;
			const r = masthead.getBoundingClientRect();
			return Math.abs(r.x + r.width / 2 - window.innerWidth / 2);
		});
		expect(offset).not.toBeNull();
		expect(offset!).toBeLessThanOrEqual(2);
	});

	test("浏览器环境（非桌面）不渲染标题栏，布局与原来一致", async ({
		page,
	}) => {
		await setUiPrefs(page, "zh", { themeMode: "light" });
		await page.goto("/");
		await expect(page.getByTestId("app-body")).toBeVisible();
		expect(await page.getByTestId("titlebar").count()).toBe(0);
	});
});
