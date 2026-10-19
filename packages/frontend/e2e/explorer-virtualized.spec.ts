// 文件树虚拟滚动 E2E：大目录（500 文件）展开后只渲染视口内 DOM 行（修复前会全量
// 挂载 500+ 行导致卡顿），滚动到底部按需渲染末行；跨轮询周期（>5s）展开态保持、
// 行数不爆（轮询等价跳过 + 虚拟化不回退）。
import { test, expect } from "@playwright/test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_WA_PI_DIR } from "../playwright.config";
import { createSessionViaPrompt, saveProvider } from "./helpers";

const BIG_DIR = join(E2E_WA_PI_DIR, "e2e-project", "big-dir");
const FILE_COUNT = 500;

// 名称三位补零：排序稳定，末行必为 file-499.txt
function seedBigDir() {
	mkdirSync(BIG_DIR, { recursive: true });
	for (let i = 0; i < FILE_COUNT; i++) {
		writeFileSync(
			join(BIG_DIR, `file-${String(i).padStart(3, "0")}.txt`),
			String(i),
		);
	}
}

async function openExplorer(page: import("@playwright/test").Page) {
	await page.goto("/");
	await page.waitForTimeout(2000);
	const session = await createSessionViaPrompt("e2e-proj-1", {
		agentName: "dev",
		text: "e2e",
		model: "test-model",
		sessionId: "s-exp-virt-" + Math.random().toString(36).slice(2),
	});
	await page.getByText("E2E项目").first().click();
	await page.getByTestId(`session-${session.id}`).click();
	await expect(page.getByTestId("session-view")).toBeVisible({
		timeout: 8000,
	});
	await page.getByTestId("btn-explorer").click();
	await expect(page.getByTestId("explorer-aside")).toBeVisible({
		timeout: 5000,
	});
}

test.beforeAll(async () => {
	seedBigDir();
	// 预置假 provider 规避首启 onboarding 向导（modal-overlay 拦截点击）——explorer.spec 同款
	await saveProvider({
		id: "e2e-explorer-virt-provider",
		name: "E2E Explorer Virt",
		slug: "e2e_explorer_virt",
		baseUrl: "http://localhost:9999/v1",
		apiKey: "sk-e2e",
		api: "openai-completions",
		models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
	});
});
test.afterAll(() => rmSync(BIG_DIR, { recursive: true, force: true }));

test("500 文件目录展开后 DOM 行数远小于总数，滚动到底末行按需渲染", async ({
	page,
}) => {
	test.setTimeout(90_000);
	await openExplorer(page);
	const panel = page.locator('[data-testid="explorer-panel"]');

	// 展开大目录：全部 500 行一次性插入（扁平数据），但 DOM 只渲染视口内行
	await panel.getByText("big-dir").click();
	await expect(panel.getByText("file-000.txt")).toBeVisible({
		timeout: 5000,
	});
	const rowCount = await panel.locator(".ep-node").count();
	expect(rowCount).toBeGreaterThan(0);
	expect(rowCount).toBeLessThan(FILE_COUNT / 5); // <100 行，远小于 500

	// 滚动到列表底部：末行按需渲染出现（虚拟化滚动链路）
	await panel.locator('[data-virtuoso-scroller="true"]').evaluate((el) => {
		el.scrollTop = el.scrollHeight;
	});
	await expect(panel.getByText("file-499.txt")).toBeVisible({
		timeout: 5000,
	});

	// 跨轮询周期（>5s）：展开态保持（不折叠）、行数仍是虚拟化的少量行
	await page.waitForTimeout(5500);
	await expect(panel.getByText("file-499.txt")).toBeVisible();
	expect(await panel.locator(".ep-node").count()).toBeLessThan(FILE_COUNT / 5);
});
