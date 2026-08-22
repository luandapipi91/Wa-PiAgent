import { test, expect } from "@playwright/test";
import { createProject } from "./helpers";

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
	test("检查更新 → 发现新版本 → 下载 → 就绪", async ({ page }) => {
		await page.addInitScript(MOCK_SCRIPT);
		// 建项目让 sidebar 显示（复用 settings-provider.spec.ts 模式）
		await createProject("e2e-updater", "/tmp/e2e-updater");

		await page.goto("/");
		await page.getByTestId("settings-btn").click();
		await expect(page.getByTestId("settings-modal")).toBeVisible();

		// 导航到「关于」页签
		await page.getByTestId("settings-nav-about").click();

		// 初始：版本 + 检查更新按钮可见（用 testid 主导，文案断言辅助）
		await expect(page.getByTestId("about-section")).toBeVisible();
		await expect(page.getByText("版本 0.1.0")).toBeVisible();
		await expect(page.getByTestId("check-update-btn")).toBeVisible();

		// 检查更新 → 发现新版本 0.2.0
		await page.getByTestId("check-update-btn").click();
		await expect(page.getByTestId("download-update-btn")).toBeVisible();
		await expect(page.getByText(/0\.2\.0/)).toBeVisible();

		// 立即更新 → 进度条 → 就绪
		await page.getByTestId("download-update-btn").click();
		await expect(page.getByTestId("download-progress-bar")).toBeVisible();
		// downloaded 由 setTimeout(450ms) 触发，给足等待时间
		await expect(page.getByTestId("install-update-btn")).toBeVisible({ timeout: 5000 });
	});
});
