// 结构层装饰 E2E（第四层）：真实浏览器 + 真实 kernel，验证任务 3 的三件事——
// token 数值方块、会话头路径/状态 tag/角色 tag（+ 战术引线）、连接状态点。
//
// 为什么要 E2E：这些装饰全是「DOM 结构 + 计算样式」的联合结果，组件测试（happy-dom
// 无布局、不加载 styles.css）看不到；布局红线（1280 宽下不换行、不把顶栏撑高）也只有
// 真浏览器量得出来（计划里「token 数值方块不得破坏布局」就钉在这里）。
//
// 数据准备：projects.json 写会话记录 + jsonl 里带 usage 的 assistant 消息（供「本轮」），
// /stats 用 page.route 注入官方口径（供占用/累计/缓存）——不依赖真实 LLM。
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_WA_PI_DIR } from "../playwright.config";
import { setUiPrefs } from "./helpers";

const SESSION_ID = "s-e2e-structure-001";

/** 自建一个专用角色（<WA_PI_DIR>/agents/<displayName>.md，kernel 每次列角色都重读目录）：
 *  角色必须真实存在——缺失时会话头渲染的是「原智能体已删除」警示按钮，不是角色 tag，
 *  那样断言角色 tag 的金底/细框就变成假绿。 */
const STRUCTURE_AGENT = "E2E结构角色";

function ensureStructureAgent(): string {
	const dir = join(E2E_WA_PI_DIR, "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${STRUCTURE_AGENT}.md`),
		[
			"---",
			`displayName: ${STRUCTURE_AGENT}`,
			"avatar: 🤖",
			'avatarColor: "#06b6d4"',
			"---",
			"",
			"结构层 E2E 专用角色",
			"",
		].join("\n"),
		"utf8",
	);
	return STRUCTURE_AGENT;
}

function seedSession() {
	const projPath = join(E2E_WA_PI_DIR, "projects.json");
	const data = JSON.parse(readFileSync(projPath, "utf8"));
	if (!data.sessions.some((s: any) => s.id === SESSION_ID)) {
		data.sessions.push({
			id: SESSION_ID,
			projectId: "e2e-proj-1",
			primaryAgent: ensureStructureAgent(),
			title: "E2E结构层",
			createdAt: 1,
			lastActivity: 1,
			piSessionFile: join(E2E_WA_PI_DIR, "sessions", `${SESSION_ID}.jsonl`),
		});
		writeFileSync(projPath, JSON.stringify(data, null, 2), "utf8");
	}
	mkdirSync(join(E2E_WA_PI_DIR, "sessions"), { recursive: true });
	writeFileSync(
		join(E2E_WA_PI_DIR, "sessions", `${SESSION_ID}.jsonl`),
		[
			JSON.stringify({ type: "session", version: 3, id: "e2e-structure-uuid" }),
			JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				message: {
					role: "user",
					content: [{ type: "text", text: "结构层验证" }],
					timestamp: 1,
				},
			}),
			JSON.stringify({
				type: "message",
				id: "m2",
				parentId: "m1",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "收到" }],
					model: "m",
					stopReason: "end_turn",
					usage: { input: 513, output: 242, cacheRead: 0, cacheWrite: 0 },
					timestamp: 2,
				},
			}),
		].join("\n"),
		"utf8",
	);
}

/** 打开会话：注入 stats（占用 64K/128K、累计含缓存、缓存命中 968/(32+968)=96.8%） */
async function openSession(page: Page) {
	await page.route(`**/api/sessions/${SESSION_ID}/stats`, (route) =>
		route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({
				stats: {
					tokens: {
						input: 32_000,
						output: 2100,
						cacheRead: 968_000,
						cacheWrite: 0,
						total: 1_002_100,
						main: { total: 1_000_000 },
						subagent: { total: 2100 },
					},
					contextUsage: { used: 64_000, total: 128_000, ratio: 0.5 },
				},
			}),
		}),
	);
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto("/");
	// 首启引导遮罩会拦截点击：先关掉（与 appearance-themes 同款处理）
	const closeBtn = page.getByRole("button", { name: "关闭" });
	await closeBtn
		.first()
		.waitFor({ state: "visible", timeout: 5000 })
		.catch(() => {});
	if (await closeBtn.count()) await closeBtn.first().click();
	await page
		.locator('[data-testid="modal-overlay"]')
		.waitFor({ state: "detached", timeout: 5000 })
		.catch(() => {});
	await page.getByTestId(`session-${SESSION_ID}`).click();
	await expect(page.getByTestId("token-bar")).toBeVisible({ timeout: 10_000 });
}

const style = (page: Page, sel: string, prop: string) =>
	page.evaluate(
		([s, p]: [string, string]) => {
			const el = document.querySelector(s);
			return el ? getComputedStyle(el).getPropertyValue(p) : null;
		},
		[sel, prop],
	);

/** 布局红线：三格同一行、缓存胶囊同行、顶栏不被撑高。
 *  用「垂直中心线」判同行而不是 y：默认主题下格子各自居中，带主·子拆分的累计格
 *  更高时 y 天然不同（那不是换行）。 */
async function expectSingleRowLayout(page: Page) {
	const centers = await page.$$eval(
		'[data-testid="token-bar"] > .token-capsule',
		(els: HTMLElement[]) =>
			els.map((e) => {
				const r = e.getBoundingClientRect();
				return Math.round(r.y + r.height / 2);
			}),
	);
	expect(centers.length).toBe(3);
	const cacheCenter = await page
		.locator('[data-testid="token-capsules"] > .token-capsule--cache')
		.evaluate((e) => {
			const r = e.getBoundingClientRect();
			return Math.round(r.y + r.height / 2);
		});
	const all = [...centers, cacheCenter];
	// 四条（三格 + 缓存）中心线差距 ≤2px = 同一行，没换行
	expect(Math.max(...all) - Math.min(...all)).toBeLessThanOrEqual(2);
	const header = await page
		.getByTestId("session-view")
		.locator("header")
		.boundingBox();
	expect(header!.height).toBeLessThan(90);

	// 主·子拆分会把累计格撑高：必须验它没有溢出/被裁切，
	// 否则「中心线同行」会掩盖「某格高一截」这类回归。
	// 边界取 token-capsules 而非 token-bar：后者在默认主题下是 display:contents，没有盒子。
	const split = page.locator('[data-testid="token-capsules"] .token-split');
	if ((await split.count()) > 0) {
		const host = await page.getByTestId("token-capsules").boundingBox();
		const box = await split.first().boundingBox();
		if (host && box) {
			expect(box.y).toBeGreaterThanOrEqual(host.y - 1);
			expect(box.y + box.height).toBeLessThanOrEqual(host.y + host.height + 1);
		}
	}
}

test("鎏金：数值是深灰方块白字，路径海克斯青，状态/角色 tag 分色", async ({
	page,
}) => {
	seedSession();
	await setUiPrefs(page, "zh", { themeMode: "gilded" });
	await openSession(page);

	// 数值方块：深灰底白字等宽（设计稿 .v）
	expect(
		await style(page, '[data-testid="token-value-input"]', "background-color"),
	).toBe("rgb(68, 68, 68)");
	expect(await style(page, '[data-testid="token-value-input"]', "color")).toBe(
		"rgb(255, 255, 255)",
	);
	// 路径单独染色（设计稿 .ch-sub .path）
	expect(await style(page, '[data-testid="session-path"]', "color")).toBe(
		"rgb(19, 127, 145)",
	);
	// 状态 tag：灰底方块（设计稿 .tag.idle）
	expect(
		await style(page, '[data-testid="session-status-tag"]', "background-color"),
	).toBe("rgb(242, 242, 242)");
	// 角色 tag：金底（只读展示的 span 才染金，缺失态是 button 警示块）
	expect(
		await page.locator('header span[data-testid="agent-switcher"]').count(),
	).toBe(1);
	expect(
		await style(page, 'header span[data-testid="agent-switcher"]', "background-color"),
	).toBe("rgb(205, 190, 145)");
	// 引线标注不属于鎏金主题
	expect(await page.getByTestId("session-main-thread").count()).toBe(0);
	// 连接点：6px 青色圆点，非战术方块
	const led = await page.getByTestId("session-conn-led").boundingBox();
	expect(Math.round(led!.width)).toBe(6);
	expect(
		await style(page, '[data-testid="session-conn-led"]', "background-color"),
	).toBe("rgb(29, 166, 186)");

	await expectSingleRowLayout(page);
});

test("战术：数值白字 600 无色块，引线标注 16×1px，状态 tag 直角虚线", async ({
	page,
}) => {
	seedSession();
	await setUiPrefs(page, "zh", { themeMode: "tactical" });
	await openSession(page);

	expect(await style(page, '[data-testid="token-value-input"]', "color")).toBe(
		"rgb(255, 255, 255)",
	);
	expect(
		await style(page, '[data-testid="token-value-input"]', "font-weight"),
	).toBe("600");
	// 战术稿的数值没有色块
	expect(
		await style(page, '[data-testid="token-value-input"]', "background-color"),
	).toBe("rgba(0, 0, 0, 0)");
	// 数据条：直角 + 1px 细框
	expect(await style(page, '[data-testid="token-bar"]', "border-radius")).toBe(
		"0px",
	);
	expect(await style(page, '[data-testid="token-bar"]', "border-top-width")).toBe(
		"1px",
	);
	// 空闲态：虚线框（设计稿 .tag.idle）
	expect(
		await style(page, '[data-testid="session-status-tag"]', "border-top-style"),
	).toBe("dashed");
	expect(
		await style(page, '[data-testid="session-status-tag"]', "border-radius"),
	).toBe("0px");
	// 引线标注：16×1px 短线 + 「主线程 · MAIN」
	await expect(page.getByTestId("session-main-thread")).toBeVisible();
	await expect(page.getByTestId("session-main-thread")).toContainText("MAIN");
	const line = await page
		.locator('[data-testid="session-main-thread"] .session-leader-line')
		.boundingBox();
	expect(Math.round(line!.width)).toBe(16);
	expect(Math.round(line!.height)).toBe(1);
	// 连接点：直角青绿方块（设计稿 .led）
	expect(
		await style(page, '[data-testid="session-conn-led"]', "border-radius"),
	).toBe("0px");
	expect(
		await style(page, '[data-testid="session-conn-led"]', "background-color"),
	).toBe("rgb(15, 247, 150)");

	await expectSingleRowLayout(page);
});

test("默认主题：拆分后胶囊组仍是原来那条单行（数值无色块、无引线）", async ({
	page,
}) => {
	seedSession();
	await setUiPrefs(page, "zh", { themeMode: "light" });
	await openSession(page);

	// 数值只是普通文字：主题装饰层没生效时不带底色
	expect(
		await style(page, '[data-testid="token-value-input"]', "background-color"),
	).toBe("rgba(0, 0, 0, 0)");
	// 「/」分隔在默认主题保留，引线标注不出现
	await expect(
		page.locator('[data-testid="token-capsules"] .token-turn-sep'),
	).toBeVisible();
	expect(await page.getByTestId("session-main-thread").count()).toBe(0);
	// 默认主题用「·」分隔路径与状态
	await expect(page.locator('[data-testid="session-path"] + .session-sep')).toBeVisible();

	await expectSingleRowLayout(page);
});

// 战术主题的两处观感缺陷回归（用户截图反馈）：
// 1) 34px 水印横穿 token 数据条 → 窄窗口隐藏（阈值 1360px），宽窗口才显示
// 2) 用户气泡四周 1px 细边在纯黑背景上勾成表格框 → 去描边、改靠底色明度分层
test("战术：默认窗口宽下隐藏水印，用户气泡无描边", async ({ page }) => {
	seedSession();
	await setUiPrefs(page, "zh", { themeMode: "tactical" });
	await openSession(page);

	// openSession 设的是 1280 宽（< 1360 阈值）
	const watermarkDisplay = await page.evaluate(() => {
		const header = document.querySelector('[data-testid="session-view"] header');
		return header ? getComputedStyle(header, "::before").display : "no-header";
	});
	expect(watermarkDisplay).toBe("none");

	const bubbleBorders = await page.evaluate(() => {
		const el = document.querySelector(
			'[data-testid^="msg-"] .flex-col.items-end > div:not(.font-semibold)',
		) as HTMLElement | null;
		if (!el) return null;
		const cs = getComputedStyle(el);
		return {
			top: cs.borderTopWidth,
			left: cs.borderLeftWidth,
			bg: cs.backgroundColor,
			radius: cs.borderRadius,
		};
	});
	expect(bubbleBorders).not.toBeNull();
	expect(bubbleBorders!.top).toBe("0px");
	expect(bubbleBorders!.left).toBe("0px");
	// 直角（组件内联圆角被覆盖掉）
	expect(bubbleBorders!.radius).toBe("0px");
	// 靠底色分层：#141414
	expect(bubbleBorders!.bg).toBe("rgb(20, 20, 20)");

	// 宽窗口（≥1360）时水印必须在——否则等于把装饰悄悄删了
	await page.setViewportSize({ width: 1440, height: 800 });
	await page.waitForTimeout(300);
	const wideDisplay = await page.evaluate(() => {
		const header = document.querySelector('[data-testid="session-view"] header');
		return header ? getComputedStyle(header, "::before").display : "no-header";
	});
	expect(wideDisplay).not.toBe("none");
});
