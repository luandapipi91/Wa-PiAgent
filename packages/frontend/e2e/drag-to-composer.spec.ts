// 拖拽到聊天输入框 E2E（第四层验证）：组件测试只能 mock elementFromPoint 模拟落点，
// 这里用真实鼠标指针链 + 真实 kernel 验证全链路。
//   1) 拖文件树文件 → chip token 为绝对路径（不再相对 workspaceDir）
//   2) 拖文件树文件夹 → chip token 同样为绝对路径
//   3) 从系统拖文件夹进来 → 走 /api/fs/copy 路径引用生成 folder 附件，不出现 Failed to fetch
//   4) 浏览器环境拖文件夹 → 直观提示「不支持操作」（不暴露「无法获取文件路径」）
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { E2E_WA_PI_DIR } from "../playwright.config";
import { saveProvider } from "./helpers";

const PROJECT_CWD = join(E2E_WA_PI_DIR, "e2e-project");
const FILE_PATH = join(PROJECT_CWD, "AGENTS.md");
const DIR_PATH = join(PROJECT_CWD, "e2e-drag-dir");
mkdirSync(DIR_PATH, { recursive: true });

test.describe
	.serial("拖拽到聊天输入框", () => {
		test.beforeAll(async () => {
			// 预置假 provider：规避首启 onboarding 向导弹窗拦截点击
			await saveProvider({
				id: "e2e-drag",
				name: "E2E Drag",
				slug: "e2e-drag",
				baseUrl: "http://localhost:9999/v1",
				apiKey: "sk-e2e",
				api: "openai-completions",
				models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
			});
		});

		/** 新建会话页选中 E2E项目 并展开文件树 */
		async function openExplorer(page: import("@playwright/test").Page) {
			await page.goto("/");
			await expect(page.getByTestId("new-session-pane")).toBeVisible({
				timeout: 10_000,
			});
			await page.getByTestId("project-select").selectOption("e2e-proj-1");
			const toggle = page.getByTestId("btn-new-session-explorer");
			await expect(toggle).toBeVisible({ timeout: 10_000 });
			await toggle.click();
			await expect(page.getByTestId("new-session-explorer-aside")).toBeVisible({
				timeout: 5000,
			});
		}

		/** 真实鼠标指针链：文件树节点 → 输入框编辑器，返回编辑器 locator */
		async function dragNodeToComposer(
			page: import("@playwright/test").Page,
			name: string,
		) {
			const node = page.locator(".ep-node", { hasText: name }).first();
			await expect(node).toBeVisible({ timeout: 15_000 });
			const editor = page.locator(
				'[data-testid="composer-input"] [role="textbox"]',
			);
			await expect(editor).toBeVisible({ timeout: 5000 });

			const nb = (await node.boundingBox())!;
			const eb = (await editor.boundingBox())!;
			await page.mouse.move(nb.x + nb.width / 2, nb.y + nb.height / 2);
			await page.mouse.down();
			await page.mouse.move(eb.x + eb.width / 2, eb.y + eb.height / 2, {
				steps: 12,
			});
			await page.mouse.up();
			return editor;
		}

		test("拖文件树文件到输入框：chip token 为绝对路径", async ({ page }) => {
			test.setTimeout(60_000);
			await openExplorer(page);
			const editor = await dragNodeToComposer(page, "AGENTS.md");

			const chip = editor.locator(".chip-file").first();
			await expect(chip).toBeVisible({ timeout: 10_000 });
			// chip 视觉只显示 basename，data-token 保留绝对路径引用
			await expect(chip).toHaveText("#AGENTS.md");
			await expect(chip).toHaveAttribute("data-token", `#[${FILE_PATH}]`);
		});

		test("拖文件树文件夹到输入框：chip token 同样为绝对路径", async ({ page }) => {
			test.setTimeout(60_000);
			await openExplorer(page);
			const editor = await dragNodeToComposer(page, "e2e-drag-dir");

			const chip = editor.locator(".chip-file").first();
			await expect(chip).toBeVisible({ timeout: 10_000 });
			await expect(chip).toHaveText("#e2e-drag-dir");
			await expect(chip).toHaveAttribute("data-token", `#[${DIR_PATH}]`);
		});

		test("从系统拖入文件夹：走路径引用生成 folder 附件，不出现 Failed to fetch", async ({
			page,
		}) => {
			test.setTimeout(60_000);
			await page.goto("/");
			await expect(page.getByTestId("new-session-pane")).toBeVisible({
				timeout: 10_000,
			});
			await page.getByTestId("project-select").selectOption("e2e-proj-1");

			// 浏览器无法构造「系统目录」的 DataTransferItem（items 只读、目录项不可造），
			// 故在页面内合成 drop：注入 Electron 才有的 waPiApp.getPathForFile +
			// 目录型 DataTransferItem，验证 UI 分支（不上传内容、无原生英文报错）
			await page.evaluate((dirPath) => {
				(window as any).waPiApp = { getPathForFile: () => dirPath };
				const host = document.querySelector(
					'[data-testid="composer-input"]',
				) as HTMLElement;
				const dirFile = new File([], "e2e-drag-dir");
				const items = [
					{
						kind: "file",
						getAsFile: () => dirFile,
						webkitGetAsEntry: () => ({
							isDirectory: true,
							name: "e2e-drag-dir",
						}),
					},
				];
				const evt = new Event("drop", { bubbles: true, cancelable: true });
				Object.defineProperty(evt, "dataTransfer", {
					value: { items, files: [] },
				});
				host.dispatchEvent(evt);
			}, DIR_PATH);

			// 真实 kernel /api/fs/copy 对目录回源路径 → folder 附件 chip
			await expect(page.getByTestId("attachment-list")).toContainText(
				"e2e-drag-dir",
				{ timeout: 10_000 },
			);
			await expect(page.getByText("Failed to fetch")).toHaveCount(0);
		});

		test("浏览器环境拖入文件夹：toast 提示不支持操作，而非「无法获取文件路径」", async ({
			page,
		}) => {
			test.setTimeout(60_000);
			await page.goto("/");
			await expect(page.getByTestId("new-session-pane")).toBeVisible({
				timeout: 10_000,
			});
			await page.getByTestId("project-select").selectOption("e2e-proj-1");

			// 纯浏览器无 Electron 桥（window.waPiApp 不存在），目录拿不到真实路径
			await page.evaluate(() => {
				const host = document.querySelector(
					'[data-testid="composer-input"]',
				) as HTMLElement;
				const items = [
					{
						kind: "file",
						getAsFile: () => new File([], "some-dir"),
						webkitGetAsEntry: () => ({
							isDirectory: true,
							name: "some-dir",
						}),
					},
				];
				const evt = new Event("drop", { bubbles: true, cancelable: true });
				Object.defineProperty(evt, "dataTransfer", {
					value: { items, files: [] },
				});
				host.dispatchEvent(evt);
			});

			await expect(page.getByText(/不支持操作|Unsupported operation/)).toBeVisible(
				{ timeout: 10_000 },
			);
			await expect(
				page.getByText(/无法获取文件路径|Cannot get file path/),
			).toHaveCount(0);
		});
	});
