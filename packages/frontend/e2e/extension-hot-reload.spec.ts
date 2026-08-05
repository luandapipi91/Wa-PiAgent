import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { E2E_WS_PORT } from "../playwright.config";
import { createProject, saveProvider, createSessionViaPrompt } from "./helpers";

// 插件热生效 E2E：安装/卸载/升级后「当前会话」立即生效，不等下次对话。
//
// 链路：REST 卸载/安装 → kernel markAllDirty + 广播 extension:changed →
// 前端 App.tsx 重拉当前会话命令 → kernel getCommands 脏感知，idle 脏会话先
// _reloadIfDirty 重建 pi 进程 → 重建后合成 extension_ui_reset（清旧进程扩展 UI
// 残留）→ 新进程 session_start 重新发射当前扩展 UI。
//
// 断言（同一会话页面、不切换不刷新）：
// 1. 卸载后：demo 的 widget/status/title 消失，/ 菜单不再有 uidemo
// 2. 重装后：widget/status/title 重新出现（新进程 session_start 发射），/ 菜单恢复 uidemo
//
// 依赖真实 pi 进程（本地扩展经 -e 加载 + 进程重建），按 PI_E2E=1 门控，CI 默认跳过。
// 设置页提示文案用例为纯前端行为，始终运行。
// 截图清理：本 spec 不落盘任何截图/临时文件。

const DEMO_DIR = join(process.cwd(), "..", "..", "examples", "ext-ui-bridge-demo");
const PKG = "ext-ui-bridge-demo";

const BASE = `http://127.0.0.1:${E2E_WS_PORT}`;

async function apiPost(path: string, body: unknown) {
	const res = await fetch(`${BASE}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const data: any = await res.json().catch(() => ({}));
	if (!res.ok)
		throw new Error(
			`REST POST ${path} 失败(${res.status}): ${data?.error ?? res.status}`,
		);
	return data;
}

test.describe.serial("插件操作后当前会话立即生效", () => {
	let projectId = "";
	let projectName = "";

	test.beforeAll(async () => {
		test.skip(!process.env.PI_E2E, "需真实 Pi 环境（PI_E2E=1 启用）");
		projectName = `e2e-hot-reload-${randomUUID().slice(0, 8)}`;
		const project = await createProject(projectName, `/tmp/${projectName}`);
		projectId = project.id;
		await saveProvider({
			id: "e2e-hot-reload-provider",
			name: "E2E HotReload",
			slug: "e2e-hot-reload",
			baseUrl: "http://localhost:9999/v1",
			apiKey: "sk-e2e",
			api: "openai-completions",
			models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
		});
		// 起点：确保 demo 已安装（重复安装容错「已安装」）
		try {
			await apiPost("/api/extensions/install", { name: DEMO_DIR });
		} catch (e) {
			if (!String(e).includes("已安装")) throw e;
		}
	});

	test("卸载 → 当前会话扩展 UI 立即消失且 / 菜单移除命令；重装 → 立即恢复", async ({
		page,
	}) => {
		test.setTimeout(180_000);
		// 重建一次 pi 进程约 5-10s（冷启动），涉及进程重建的断言统一给 60s 窗口
		const REBUILD = 60_000;

		// 建会话：首条消息用扩展命令，pi 直接执行不产生 LLM turn（避开假 provider 失败轮 busy）。
		// agentName 用「研发」：隔离 e2e 环境的内置智能体（用 "dev" 会报「原智能体已删除」）。
		const sessionId = "s-e2e-hotreload-" + randomUUID().slice(0, 8);
		await createSessionViaPrompt(projectId, {
			agentName: "研发",
			text: "/uidemo title",
			model: "e2e-hot-reload/model-a",
			sessionId,
		});

		// 打开会话页面（整个用例不离开此页面）
		await page.goto("/");
		await page.waitForTimeout(500);
		await page.getByText(projectName).first().click();
		await page.getByTestId(`session-${sessionId}`).click();
		await expect(page.getByTestId("session-view")).toBeVisible({
			timeout: 8000,
		});

		// 前置确认：手动触发 demo 发射四类 UI（widget/status/title）。
		// 注意不能用建会话时的 session_start 自动发射——SSE 在页面打开后才连接，
		// 早于页面连接的事件前端收不到。
		await page
			.getByTestId("model-selector")
			.selectOption({ label: "E2E HotReload/model-a" });
		const textbox = page.locator(
			'[data-testid="composer-input"] [role="textbox"]',
		);
		await textbox.fill("/uidemo all");
		await page.keyboard.press("Escape"); // 收起 / 菜单，避免干扰发送
		await page.getByTestId("composer-send").click();
		await expect(page.getByTestId("ext-widget-ui-demo-above")).toBeVisible({
			timeout: REBUILD,
		});
		await expect(page.getByTestId("ext-status-bar")).toBeVisible();
		await expect(page.getByTestId("ext-title-bar")).toBeVisible();
		// / 菜单含 uidemo
		await textbox.click();
		await page.keyboard.type("/", { delay: 5 });
		await expect(page.getByTestId("quick-invoke-menu")).toBeVisible({
			timeout: 5000,
		});
		await expect(page.getByTestId("quick-invoke-menu")).toContainText(
			"uidemo",
			{ timeout: 8000 },
		);
		await page.keyboard.press("Escape");

		// ── 卸载：当前会话内扩展 UI 消失 + / 菜单移除 uidemo ──
		await apiPost("/api/extensions/uninstall", { name: PKG });
		// extension:changed → 前端重拉命令 → kernel 重建进程（demo 移除）→
		// extension_ui_reset 清空旧 UI；新进程无 demo，不再发射
		await expect(page.getByTestId("ext-widget-ui-demo-above")).toHaveCount(0, {
			timeout: REBUILD,
		});
		await expect(page.getByTestId("ext-widget-ui-demo-below")).toHaveCount(0);
		await expect(page.getByTestId("ext-status-bar")).toHaveCount(0);
		await expect(page.getByTestId("ext-title-bar")).toHaveCount(0);
		// / 菜单不再有 uidemo（commands store 已随 extension:changed 刷新）
		await textbox.click();
		await page.keyboard.type("/", { delay: 5 });
		await expect(page.getByTestId("quick-invoke-menu")).toBeVisible({
			timeout: 5000,
		});
		await expect(page.getByTestId("quick-invoke-menu")).not.toContainText(
			"uidemo",
		);
		await page.keyboard.press("Escape");

		// ── 重装：当前会话内扩展 UI 恢复 + / 菜单恢复 uidemo ──
		await apiPost("/api/extensions/install", { name: DEMO_DIR });
		// 再次重建进程（demo 回来）→ reset 后新进程 session_start 重新发射 UI
		await expect(page.getByTestId("ext-widget-ui-demo-above")).toBeVisible({
			timeout: REBUILD,
		});
		await expect(page.getByTestId("ext-status-bar")).toBeVisible();
		await expect(page.getByTestId("ext-title-bar")).toBeVisible();
		await textbox.click();
		await page.keyboard.type("/", { delay: 5 });
		await expect(page.getByTestId("quick-invoke-menu")).toBeVisible({
			timeout: 5000,
		});
		await expect(page.getByTestId("quick-invoke-menu")).toContainText(
			"uidemo",
			{ timeout: 8000 },
		);
		await page.keyboard.press("Escape");
	});

	test("设置页提示文案为「当前对话立即生效」", async ({ page }) => {
		await page.goto("/");
		await expect(page.getByTestId("settings-btn")).toBeVisible({
			timeout: 8000,
		});
		await page.getByTestId("settings-btn").click();
		await expect(page.getByTestId("settings-modal")).toBeVisible();
		await page.getByRole("button", { name: "插件", exact: true }).click();
		await expect(page.getByTestId("ext-install-input")).toBeVisible();
		await expect(
			page.getByText("当前对话立即生效", { exact: false }),
		).toBeVisible();
		await expect(
			page.getByText("下次对话开始时生效", { exact: false }),
		).toHaveCount(0);
	});
});
