import { expect, test } from "@playwright/test";
import { saveProvider } from "./helpers";

// 设置 → 联网 → 互联网搜索：免费 Bing 供应商默认可选、可切换并保存（REST 往返）。
// 隔离目录（~/.wa-pi-e2e）无存量 webSearch → GET 返回默认 provider=bing。
const KERNEL = `http://127.0.0.1:${process.env.WA_PI_E2E_WS_PORT ?? 9776}`;

test("联网供应商：默认 bing，select 切换 bigmodel 保存后 REST 往返可见", async ({ page }) => {
	// 预置假 provider：全新隔离目录无 provider 时首启 onboarding 向导会拦截点击（对齐 settings-sound.spec）
	await saveProvider({
		id: "websearch-e2e-provider",
		name: "WebSearch E2E",
		baseUrl: "https://example.invalid",
		apiKey: "sk-test",
		api: "openai-completions",
		models: [{ id: "test-model", contextWindow: 100000, maxTokens: 8192 }],
	});
	await page.goto("/");
	await page.getByTestId("settings-btn").click();
	await expect(page.getByTestId("settings-modal")).toBeVisible();
	// 联网页（testid 沿用 settings-nav-share），默认 tab 即「互联网搜索」
	await page.getByTestId("settings-nav-share").click();
	const select = page.getByTestId("websearch-provider-select");
	await expect(select).toBeVisible();
	await expect(select).toHaveValue("bing");
	await expect(page.getByTestId("websearch-bing-hint")).toBeVisible();
	// 切到 智谱 BigModel：出现智谱 Key 输入；保存
	await select.selectOption("bigmodel");
	await expect(page.getByTestId("websearch-key-bigmodel-input")).toBeVisible();
	await page.getByTestId("websearch-save").click();
	await expect(page.getByTestId("websearch-saved")).toBeVisible();
	// REST 往返：内核落盘 provider=bigmodel
	const got = await page.request.get(`${KERNEL}/api/settings/websearch`);
	expect(((await got.json()) as any).webSearch.provider).toBe("bigmodel");
	// 切回 bing 保存（现场恢复），REST 复核落盘
	await select.selectOption("bing");
	await page.getByTestId("websearch-save").click();
	await expect
		.poll(async () => {
			const r = await page.request.get(`${KERNEL}/api/settings/websearch`);
			return ((await r.json()) as any).webSearch.provider;
		})
		.toBe("bing");
});
