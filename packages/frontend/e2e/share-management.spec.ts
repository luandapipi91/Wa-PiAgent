import { test, expect } from "@playwright/test";
import { saveProvider } from "./helpers";

// 分享管理（设置-分享 tab）E2E 测试
//
// 覆盖（docs/superpowers/specs/2026-08-17-share-project-management-design.md Task 6）：
// 1. 设置 → 分享：注册入口链接可见且 href 按界面语言（默认 zh）指向中文产品页
// 2. 拦截 GET /api/share/list 返回 2 条 → 「我的分享」列表渲染 2 行
// 3. 点击删除 → POST /api/share/delete 被调（携带 id）→ 再次 list 返回 1 条 → 列表剩 1 行
// 4. pending>0 时显示「N 项变更未部署」；点击立即部署 → POST /api/share/deploy 被调 → 提示消失
// 5. 清空：点击清空 → POST /api/share/clear 被调 → 列表回到「暂无分享」
//
// 约定：
// - kernel 对 EdgeOne 的 fetch 是服务端的，Playwright 拦不到；这里用 page.route 在浏览器侧
//   拦截 /api/share/*，把列表/删除/清空/部署打成状态驱动的 mock，只验证 UI 行为契约
//   （接口级真实链路已由 kernel 集成测试覆盖）。
// - mock 状态放在每个用例闭包里：list 始终回当前 state，delete/clear 直接改 state，
//   UI 操作后的 refresh() 自然读到新状态，与真实 kernel 的读写模型一致。
// - /api/settings/share 不拦截：隔离 E2E kernel 直接返回空分享配置（hasToken=false），
//   不影响「我的分享」区域的渲染。
// - 截图清理：本 spec 不落盘任何截图/临时文件（test-results/ 由 .gitignore 忽略）。

interface MockShareItem {
	id: string;
	name: string;
	files: string[];
	size: number;
	createdAt: number;
}

interface MockShareState {
	items: MockShareItem[];
	pending: number;
	calls: { delete: string[]; clear: number; deploy: number };
}

function makeState(): MockShareState {
	return {
		items: [
			{
				id: "aaa111",
				name: "index.html",
				files: ["index.html"],
				size: 2048,
				createdAt: Date.parse("2026-08-17T10:00:00Z"),
			},
			{
				id: "bbb222",
				name: "2 个文件",
				files: ["a.js", "b.css"],
				size: 4096,
				createdAt: Date.parse("2026-08-17T11:00:00Z"),
			},
		],
		pending: 0,
		calls: { delete: [], clear: 0, deploy: 0 },
	};
}

// 浏览器侧拦截 /api/share/*：状态驱动 mock（list 回当前 state；delete/clear/deploy 改 state 并记录调用）
async function mockShareApi(page: import("@playwright/test").Page, state: MockShareState) {
	const json = async (route: import("@playwright/test").Route, body: unknown) =>
		route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });

	await page.route("**/api/share/list", (route) =>
		json(route, {
			items: state.items,
			pending: state.pending,
			totalSize: state.items.reduce((s, i) => s + i.size, 0),
			totalLimit: 1024 * 1024 * 1024,
			workspaceDir: "/tmp/e2e-share-workspace",
		}),
	);
	await page.route("**/api/share/delete", async (route) => {
		const id = route.request().postDataJSON()?.id;
		state.calls.delete.push(id);
		state.items = state.items.filter((i) => i.id !== id);
		state.pending = 1; // 删除产生未部署变更
		await json(route, { ok: true });
	});
	await page.route("**/api/share/clear", async (route) => {
		state.calls.clear += 1;
		state.items = [];
		state.pending = 1;
		await json(route, { ok: true });
	});
	await page.route("**/api/share/deploy", async (route) => {
		state.calls.deploy += 1;
		state.pending = 0; // 部署后变更清零
		await json(route, { ok: true, expiresAt: Date.now() + 3 * 3600_000 });
	});
}

// 打开 设置 → 分享 tab（settings-modal 分享 nav 有 testid：settings-nav-share）
async function openShareSection(page: import("@playwright/test").Page) {
	// 锁定界面语言为 zh：i18n/detect 首次检测回退到 navigator.language，
	// headless Chromium 是 en-US，会导致文案/注册链接分流断言漂移
	await page.addInitScript(() => {
		localStorage.setItem(
			"wa-pi-ui-prefs",
			JSON.stringify({ state: { language: "zh" }, version: 0 }),
		);
	});
	await page.goto("/");
	await expect(page.getByTestId("settings-btn")).toBeVisible({ timeout: 8000 });
	await page.getByTestId("settings-btn").click();
	await expect(page.getByTestId("settings-modal")).toBeVisible();
	await page.getByTestId("settings-nav-share").click();
	await expect(page.getByTestId("share-section")).toBeVisible();
}

// 打开并切到「我的分享」tab（设置区与管理区已拆为两个 tab，管理元素只在该 tab 渲染）
async function openShareManageTab(page: import("@playwright/test").Page) {
	await openShareSection(page);
	await page.getByTestId("share-tab-shares").click();
	await expect(page.getByTestId("share-manage")).toBeVisible();
}

test.describe.serial("分享管理（设置-分享 tab）", () => {
	// 共享 kernel 可能处于无 provider 状态（onboarding-wizard 用例会清空），
	// 此时初始化向导自动弹出（modal-overlay）会挡住 settings-btn；
	// 预置一个固定 id 的假 provider（每次覆盖写入，与其他 spec 同款约定）避免向导干扰
	test.beforeAll(async () => {
		await saveProvider({
			id: "e2e-share-provider",
			name: "E2E Share",
			slug: "e2e-share",
			baseUrl: "http://localhost:9999/v1",
			apiKey: "sk-e2e",
			api: "openai-completions",
			models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
		});
	});

	test("注册入口链接可见且 href 指向 EdgeOne 中文产品页（默认 zh）", async ({ page }) => {
		const state = makeState();
		await mockShareApi(page, state);
		await openShareSection(page);

		const link = page.getByTestId("share-register-link");
		await expect(link).toBeVisible();
		await expect(link).toHaveAttribute("href", "https://edgeone.ai/zh/products/pages");
		// 自定义域名输入框在分享设置 tab 可见
		await expect(page.getByTestId("share-domain-input")).toBeVisible();
		// 切到「我的分享」tab：存储用量与「打开分享文件夹」入口可见
		await page.getByTestId("share-tab-shares").click();
		await expect(page.getByTestId("share-usage")).toBeVisible();
		await expect(page.getByTestId("share-open-folder")).toBeVisible();
	});

	test("list 返回 2 条 → 列表渲染 2 行", async ({ page }) => {
		const state = makeState();
		await mockShareApi(page, state);
		await openShareManageTab(page);

		await expect(page.getByTestId("share-item-aaa111")).toBeVisible();
		await expect(page.getByTestId("share-item-bbb222")).toBeVisible();
		await expect(page.getByTestId("share-item-aaa111")).toContainText("index.html");
		await expect(page.getByTestId("share-item-bbb222")).toContainText("2 个文件");
		// 用量汇总（2KB + 4KB = 6KB / 1GB）
		await expect(page.getByTestId("share-usage")).toContainText("存储 6 KB / 1.0 GB");
		// pending=0 时不显示未部署提示
		await expect(page.getByTestId("share-pending")).toHaveCount(0);
	});

	test("点击删除 → delete 接口被调 → 列表剩 1 行且出现未部署提示", async ({ page }) => {
		const state = makeState();
		await mockShareApi(page, state);
		await openShareManageTab(page);
		await expect(page.getByTestId("share-item-aaa111")).toBeVisible();

		await page.getByTestId("share-delete-aaa111").click();

		// POST /api/share/delete 携带正确 id；随后 refresh 读到 1 条
		await expect.poll(() => state.calls.delete).toEqual(["aaa111"]);
		await expect(page.getByTestId("share-item-aaa111")).toHaveCount(0);
		await expect(page.getByTestId("share-item-bbb222")).toBeVisible();
		// 删除产生未部署变更提示
		await expect(page.getByTestId("share-pending")).toContainText("1 项变更未部署");
	});

	test("pending>0 显示未部署提示；点击立即部署 → deploy 接口被调 → 提示消失", async ({ page }) => {
		const state = makeState();
		state.pending = 2;
		await mockShareApi(page, state);
		await openShareManageTab(page);

		await expect(page.getByTestId("share-pending")).toContainText("2 项变更未部署");

		await page.getByTestId("share-deploy").click();

		await expect.poll(() => state.calls.deploy).toBe(1);
		// 部署后 refresh 读到 pending=0，提示消失
		await expect(page.getByTestId("share-pending")).toHaveCount(0);
	});

	test("点击清空 → clear 接口被调 → 列表回到暂无分享", async ({ page }) => {
		const state = makeState();
		await mockShareApi(page, state);
		await openShareManageTab(page);
		await expect(page.getByTestId("share-item-aaa111")).toBeVisible();

		await page.getByTestId("share-clear").click();

		await expect.poll(() => state.calls.clear).toBe(1);
		await expect(page.getByTestId("share-item-aaa111")).toHaveCount(0);
		await expect(page.getByTestId("share-item-bbb222")).toHaveCount(0);
		// 空列表：显示「暂无分享」，清空按钮随列表一起隐藏
		await expect(page.getByTestId("share-manage")).toContainText("暂无分享");
		await expect(page.getByTestId("share-clear")).toHaveCount(0);
	});
});
