// E2E：通用智能体（general-purpose）model / 思考强度 保存是否生效
//
// 覆盖：
// 1. 浅色修复：内置 subagent 面板内容区无 opacity-60（文字正常色）
// 2. UI 保存 model / 思考强度 → subagent-overrides.json 文件写入
// 3. kernel 读取链路：GET /api/subagents 返回的新 override（resolveSpawnConfig 同源读取，
//    真正 spawn 透传由 kernel 单测 agent-manager-subagent-overrides.test.ts 覆盖）
// 4. 重开面板显示保存值（前端 store 经 SSE 广播刷新——保存后 UI 生效的直接证据）
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_WA_PI_DIR, E2E_WS_PORT } from "../playwright.config";
import { createAgent, deleteAgentQuiet, saveProvider } from "./helpers";

const OVERRIDES_FILE = join(E2E_WA_PI_DIR, "subagent-overrides.json");

function readOverride(
	type: string,
): { model?: string | null; thinking?: string | null } | undefined {
	try {
		const data = JSON.parse(readFileSync(OVERRIDES_FILE, "utf8"));
		return (data.overrides ?? []).find((o: any) => o.type === type);
	} catch {
		return undefined;
	}
}

test.describe
	.serial("通用智能体 model/思考强度 保存生效", () => {
		const created: string[] = [];

		test.beforeAll(async () => {
			// 侧栏需 >3 个智能体才出现「更多智能体」入口（重复跑容忍已存在）
			for (const n of ["e2e-b1", "e2e-b2", "e2e-b3"]) {
				try {
					await createAgent(n);
					created.push(n);
				} catch {
					/* 已存在 */
				}
			}
			// 预置 provider，让 model 下拉有真实选项（slug 由 name 派生：E2E-B → e2e-b）
			try {
				await saveProvider({
					id: "e2e-b-provider",
					name: "E2E-B",
					baseUrl: "http://localhost:9999/v1",
					apiKey: "sk-e2e",
					api: "openai-completions",
					models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
				});
			} catch {
				/* 已存在 */
			}
		});

		test.afterAll(async () => {
			for (const n of created) await deleteAgentQuiet(n);
		});

		test.beforeEach(async ({ page }) => {
			test.setTimeout(120_000);
			await page.goto("/", { timeout: 60_000 });
		});

		test("浅色修复：内置 subagent 面板内容区无 opacity-60", async ({
			page,
		}) => {
			await page.getByTestId("agent-more").click();
			await expect(page.getByTestId("agent-gallery")).toBeVisible({
				timeout: 10_000,
			});
			await page.getByTestId("gallery-card-general-purpose").click();
			await expect(page.getByTestId("agent-config")).toBeVisible({
				timeout: 10_000,
			});

			const opacity = await page
				.getByTestId("config-tab-content")
				.evaluate((el) => getComputedStyle(el).opacity);
			expect(opacity).toBe("1");
		});

		test("保存 model/思考强度 → 文件写入 + kernel 读取 + 重开面板显示", async ({
			page,
		}) => {
			// 打开「更多智能体」→ 通用智能体
			await page.getByTestId("agent-more").click();
			await expect(page.getByTestId("agent-gallery")).toBeVisible({
				timeout: 10_000,
			});
			await page.getByTestId("gallery-card-general-purpose").click();
			await expect(page.getByTestId("agent-config")).toBeVisible({
				timeout: 10_000,
			});

			// 修改 model + 思考强度（等 provider option 出现：saveProvider 是 Node 侧 POST，前端同步需要时间）
			const modelSelect = page.getByTestId("cfg-model-select");
			const thinkSelect = page.getByTestId("cfg-thinking-select");
			await expect(
				modelSelect.locator('option[value="e2e-b/model-a"]'),
			).toHaveCount(1, { timeout: 10_000 });
			await modelSelect.selectOption("e2e-b/model-a");
			await thinkSelect.selectOption("high");

			// 保存
			await page.getByTestId("cfg-save").click();
			await expect(page.getByTestId("agent-config")).toHaveCount(0, {
				timeout: 10_000,
			});

			// 1) 持久化：override 文件写入 model + thinking
			await expect
				.poll(
					() => {
						const o = readOverride("general-purpose");
						return o?.model === "e2e-b/model-a" && o?.thinking === "high";
					},
					{ timeout: 10_000 },
				)
				.toBe(true);

			// 2) kernel 读取链路：GET /api/subagents 返回新 override
			await expect
				.poll(
					async () => {
						const res = await fetch(
							`http://127.0.0.1:${E2E_WS_PORT}/api/subagents`,
						);
						const data: any = await res.json();
						const o = (data.subagents ?? []).find(
							(s: any) => s.name === "general-purpose",
						)?.override;
						return o?.model === "e2e-b/model-a" && o?.thinking === "high";
					},
					{ timeout: 10_000 },
				)
				.toBe(true);

			// 3) 重开面板显示保存值（前端 store 已刷新——保存后 UI 生效的直接证据）
			await page.getByTestId("agent-more").click();
			await expect(page.getByTestId("agent-gallery")).toBeVisible({
				timeout: 10_000,
			});
			await page.getByTestId("gallery-card-general-purpose").click();
			await expect(page.getByTestId("agent-config")).toBeVisible({
				timeout: 10_000,
			});
			await expect(page.getByTestId("cfg-model-select")).toHaveValue(
				"e2e-b/model-a",
				{ timeout: 10_000 },
			);
			await expect(page.getByTestId("cfg-thinking-select")).toHaveValue("high");
		});

		test("通用智能体工具 tab 显示工具列表（不卡加载中）", async ({ page }) => {
			await page.getByTestId("agent-more").click();
			await expect(page.getByTestId("agent-gallery")).toBeVisible({
				timeout: 10_000,
			});
			await page.getByTestId("gallery-card-general-purpose").click();
			await expect(page.getByTestId("agent-config")).toBeVisible({
				timeout: 10_000,
			});

			// 切到工具 tab
			await page.getByTestId("tab-tools").click();
			// “加载中...”应消失，出现至少一个工具开关行
			await expect(
				page.getByTestId("config-tab-content").getByText("加载中..."),
			).toHaveCount(0, { timeout: 10_000 });
			await expect(
				page.locator('[data-testid^="tool-switch-"]').first(),
			).toBeVisible({ timeout: 10_000 });
		});
	});
