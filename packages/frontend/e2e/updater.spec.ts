import { test, expect } from "@playwright/test";
import { createProject, ensureProvider } from "./helpers";

/**
 * 关于页签更新流程 E2E。
 *
 * 真实 IPC（desktop 主进程的 waApi）在 dev 浏览器下不可用，这里通过 addInitScript
 * 在页面加载前注入一个 mock 的 window.waPiUpdater，模拟主进程的事件流：
 *   getInfo → 拉版本信息
 *   check   → 广播 available
 *   download → 广播 downloading（进度序列） + downloaded
 *   onEvent  → 注册监听器，事件经此回调推入 store
 *
 * 注意：App.tsx 在 mount 时调用 initUpdater()（getInfo + onEvent），所以 mock 必须在
 * 任何应用代码运行前就位 —— addInitScript 正是为此（每次导航前执行）。
 */
const MOCK_SCRIPT = `
window.__updaterListeners = [];
window.waPiUpdater = {
  getInfo: async () => ({ appVersion: "0.1.0", isDesktop: true }),
  check: async () => {
    window.__updaterListeners.forEach(cb => cb({
      phase: "available",
      version: "0.2.0",
      releaseNotes: "修复：文件预览持久化",
    }));
    return { ok: true };
  },
  download: async () => {
    [10, 40, 70, 100].forEach((p, i) => setTimeout(() => {
      window.__updaterListeners.forEach(cb => cb({
        phase: "downloading",
        progress: p,
        transferred: p * 10,
        total: 1000,
      }));
    }, i * 100));
    setTimeout(() => {
      window.__updaterListeners.forEach(cb => cb({ phase: "downloaded", version: "0.2.0" }));
    }, 450);
    return { ok: true };
  },
  quitAndInstall: async () => ({ ok: true }),
  onEvent: (cb) => { window.__updaterListeners.push(cb); return () => {}; },
};
`;

test.describe("关于页签更新流程（mock waPiUpdater）", () => {
  // 防无 provider 首启 onboarding 向导遮挡点击（子集单跑自保）
  test.beforeAll(async () => {
    await ensureProvider();
  });
	test("检查更新 → 发现新版本 → 下载 → 就绪", async ({ page }) => {
		await page.addInitScript(MOCK_SCRIPT);
		// 建项目让 sidebar 显示（复用 settings-provider.spec.ts 模式）
		await createProject("e2e-updater", "/tmp/e2e-updater");

		await page.goto("/");
		await page.getByTestId("settings-btn").click();
		await expect(page.getByTestId("settings-modal")).toBeVisible();

		// 导航到「关于」页签
		await page.getByTestId("settings-nav-about").click();

		// 初始：版本可见。桌面端打开设置即自动检查更新（SettingsModal effect +
		// mock check 同步返回），可能已跳过 idle 态直达 available——两种状态都兼容：
		// available 则直接进入下载流程，否则手动点「检查更新」
		await expect(page.getByTestId("about-section")).toBeVisible();
		await expect(page.getByText("版本 0.1.0")).toBeVisible();
		const downloadBtn = page.getByTestId("download-update-btn");
		if (!(await downloadBtn.isVisible().catch(() => false))) {
			await page.getByTestId("check-update-btn").click();
		}
		await expect(downloadBtn).toBeVisible();
		// 作用域限定到状态条：分栏左列会渲染大量「v0.2.x」版本号，裸 getByText 在严格模式下会命中多处
		await expect(
			page.getByTestId("updater-status").getByText(/0\.2\.0/),
		).toBeVisible();

		// 更新历史：左右分栏 + 点版本切换详情
		const list = page.getByTestId("version-history-list");
		const detail = page.getByTestId("version-history-detail");
		await expect(list).toBeVisible();
		await expect(detail).toBeVisible();
		const secondVersion = await list.locator("button").nth(1).innerText();
		await list.locator("button").nth(1).click();
		await expect(detail).toContainText(secondVersion.split("\n")[0]);

		// 立即更新 → 进度条 → 就绪
		await page.getByTestId("download-update-btn").click();
		await expect(page.getByTestId("download-progress-bar")).toBeVisible();
		// downloaded 由 setTimeout(450ms) 触发，给足等待时间
		await expect(page.getByTestId("install-update-btn")).toBeVisible({ timeout: 5000 });
	});

	test("版本历史停在旧数据时：发现新版本后强制重拉，并展示新版本自己的内容", async ({
		page,
	}) => {
		await page.addInitScript(MOCK_SCRIPT);
		await createProject("e2e-updater-stale", "/tmp/e2e-updater-stale");

		// 拦截版本历史接口：首次（走内核缓存）返回不含 0.2.0 的旧数据；
		// 带 refresh=1 的强制重拉才返回含 0.2.0 的新数据（真实发版后内核缓存 6h 的形态）
		const historyPaths: string[] = [];
		await page.route("**/api/version-history*", async (route) => {
			const url = route.request().url();
			historyPaths.push(url);
			const fresh = url.includes("refresh=1");
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					type: "version-history:get",
					history: fresh
						? [
								{
									version: "0.2.0",
									date: "2026-02-01",
									sections: { 修复: ["新版本内容甲"] },
								},
							]
						: [
								{
									version: "0.1.9",
									date: "2026-01-30",
									sections: { 改进: ["旧版本内容乙"] },
								},
							],
					source: "remote",
				}),
			});
		});

		await page.goto("/");
		await page.getByTestId("settings-btn").click();
		await page.getByTestId("settings-nav-about").click();
		await expect(page.getByTestId("about-section")).toBeVisible();

		const downloadBtn = page.getByTestId("download-update-btn");
		if (!(await downloadBtn.isVisible().catch(() => false))) {
			await page.getByTestId("check-update-btn").click();
		}
		await expect(downloadBtn).toBeVisible();

		// 发现新版本但历史里没有它 → 自动带 refresh=1 重拉一次
		await expect
			.poll(() => historyPaths.some((u) => u.includes("refresh=1")), {
				timeout: 10_000,
			})
			.toBe(true);

		// 重拉后区间包含新版本，且展示的是新版本自己的内容（不是旧数据）
		await page.getByTestId("toggle-pending-versions").click();
		const pending = page.getByTestId("pending-versions");
		await expect(pending).toContainText("新版本内容甲");
		await expect(pending).not.toContainText("旧版本内容乙");
	});
});
