import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { E2E_WS_PORT } from "../playwright.config";
import { createProject, saveProvider, createSessionViaPrompt } from "./helpers";

// wa-pi-tui-host 扩展面板 E2E：ctx.ui.custom 的图形界面三态浮窗（规格 §7.1）全链路。
//
// 链路：测试桩扩展（examples/tui-host-demo 的 /tui-demo）调 ctx.ui.custom
//   → pi 进程里的 wa-pi-tui-host 扩展接管，帧经 /bridge/tui-host/frames 长连接送 kernel
//   → kernel 转 SSE 的 extension_tui_open/frame/close
//   → 前端 store/tui-panel → TuiPanel 三态浮窗（data-testid=tui-panel-expanded/badge/pill）。
//
// 环境坑（照 e2e-electron/preview-window.spec.ts 的团队备忘）：
//   1. 宿主的 WA_PI_* 环境变量会污染隔离 kernel（WA_PI_WEB_DIR 指向已安装版旧前端，
//      新功能完全不生效）——本 spec 断言的是仓库源码前端，若加载到旧前端会直接失败；
//   2. 本机已有真实 kernel 占用 9776/9778 时，用偏移端口运行（见文件底部说明）。
// 依赖真实 pi 进程（扩展经 settings.json packages 机制加载），无 pi 环境会失败——不做门控，
// 保证默认 `bun run e2e -- tui-panel.spec.ts` 真的跑而不是静默跳过。

const DEMO_DIR = join(process.cwd(), "..", "..", "examples", "tui-host-demo");
const PROVIDER_SLUG = "e2e-tui-host";
const MODEL = `${PROVIDER_SLUG}/model-a`;
const BASE = `http://127.0.0.1:${E2E_WS_PORT}`;

async function apiPost(path: string, body: unknown) {
	const res = await fetch(`${BASE}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const data: any = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(
			`REST POST ${path} 失败(${res.status}): ${data?.error ?? res.status}`,
		);
	}
	return data;
}

test.describe
	.serial("扩展 TUI 面板（ctx.ui.custom）", () => {
		let projectId = "";
		let projectName = "";

		test.beforeAll(async () => {
			projectName = `e2e-tui-${randomUUID().slice(0, 8)}`;
			const project = await createProject(projectName, `/tmp/${projectName}`);
			projectId = project.id;
			// 预置假 provider：无 provider 时前端会弹首次启动向导遮住聊天区
			await saveProvider({
				id: "e2e-tui-host-provider",
				name: "E2E TuiHost",
				slug: PROVIDER_SLUG,
				baseUrl: "http://localhost:9999/v1",
				apiKey: "sk-e2e",
				api: "openai-completions",
				models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
			});
			// 安装测试桩扩展（本地绝对路径；重复安装容错「已安装」）
			try {
				await apiPost("/api/extensions/install", { name: DEMO_DIR });
			} catch (e) {
				if (!String(e).includes("已安装")) throw e;
			}
		});

		/**
		 * 起一个会话并让 pi 执行 /tui-demo（首条消息用扩展命令：pi 拦截执行、
		 * 不产生 LLM turn，面板打开后一直等到我们按键才结束）。
		 */
		async function spawnSessionWithPanel(): Promise<string> {
			const sessionId = "s-e2e-tui-" + randomUUID().slice(0, 8);
			await createSessionViaPrompt(projectId, {
				agentName: "研发",
				text: "/tui-demo",
				model: MODEL,
				sessionId,
			});
			return sessionId;
		}

		/**
		 * 起一个会话并让 pi 执行 /tui-demo-echo（回显型面板：输入逐条回显，回车结束）。
		 * 用于验证「输入法上屏的中文真的进了假终端并被插件消费、渲染到帧上」。
		 */
		async function spawnSessionWithEchoPanel(): Promise<string> {
			const sessionId = "s-e2e-tui-echo-" + randomUUID().slice(0, 8);
			await createSessionViaPrompt(projectId, {
				agentName: "研发",
				text: "/tui-demo-echo",
				model: MODEL,
				sessionId,
			});
			return sessionId;
		}

		/** 起一个会话并让 pi 执行 /tui-demo-options（键盘型编号选项对话框） */
		async function spawnSessionWithOptionsPanel(): Promise<string> {
			const sessionId = "s-e2e-tui-opt-" + randomUUID().slice(0, 8);
			await createSessionViaPrompt(projectId, {
				agentName: "研发",
				text: "/tui-demo-options",
				model: MODEL,
				sessionId,
			});
			return sessionId;
		}

		/** 起一个会话并让 pi 执行 /tui-demo-input（真实输入框桩） */
		async function spawnSessionWithInputPanel(): Promise<string> {
			const sessionId = "s-e2e-tui-in-" + randomUUID().slice(0, 8);
			await createSessionViaPrompt(projectId, {
				agentName: "研发",
				text: "/tui-demo-input",
				model: MODEL,
				sessionId,
			});
			return sessionId;
		}

		/** 打开页面 → 选项目 → 进会话，返回面板展开态定位器 */
		async function openPanel(
			page: Page,
			sessionId: string,
			expects: string[] = ["alpha", "beta", "gamma"],
		) {
			await page.goto("/");
			await page.waitForTimeout(500);
			await page.getByText(projectName).first().click();
			await page.getByTestId(`session-${sessionId}`).click();
			await expect(page.getByTestId("session-view")).toBeVisible({
				timeout: 8000,
			});
			const panel = page.getByTestId("tui-panel-expanded");
			// 面板要等 pi 进程启动 + 扩展加载 + 帧流建立，给足超时
			await expect(panel).toBeVisible({ timeout: 60_000 });
			// 帧到达前先渲染的是空面板：等到内容上屏再断言
			for (const [i, text] of expects.entries()) {
				await expect(panel).toContainText(text, {
					timeout: i === 0 ? 20_000 : undefined,
				});
			}
			return panel;
		}

		test("扩展面板：出现、键盘选择、回车后回显并关闭", async ({ page }) => {
			const sessionId = await spawnSessionWithPanel();
			const panel = await openPanel(page, sessionId);

			// 键盘归面板（展开态自动聚焦，显式 focus 一次防侧栏点击抢走焦点）
			await panel.focus();
			await page.keyboard.press("ArrowDown");
			await page.keyboard.press("ArrowDown");
			// 选中项移到 gamma：帧里的选择标记跟着走，是「按键真的送到了面板」的直接证据
			await expect(panel).toContainText("▸ gamma", { timeout: 10_000 });

			await page.keyboard.press("Enter");

			// 面板消失（kernel 回推 extension_tui_close 驱动，不是前端本地关闭）
			await expect(page.getByTestId("tui-panel-expanded")).toHaveCount(0, {
				timeout: 20_000,
			});
			// 选择结果经 ctx.ui.notify 回显到聊天（扩展 UI 桥固有形态）
			await expect(
				page.locator('[data-testid^="custom-"]:has-text("tui-demo 选择：gamma")'),
			).toBeVisible({ timeout: 20_000 });
		});

		/**
		 * 鼠标 → 键盘回退：对话框只实现 handleInput（pi-goal-x 的问卷/提案确认就是这个形态），
		 * 真终端里点它等于没反应。宿主在组件没消费鼠标时按帧文本推出等价的 ↑↓ + Enter。
		 *
		 * 帧特意做成 30+ 行（高于面板视口）：选项在底部，点击前浏览器会把该行滚进视口，
		 * 因此这条同时压住 «帧行 = 可见行 + 滚动偏移» 的换算（少了它就会点中上面十几行的另一行）。
		 */
		test("键盘型对话框：点击选项行即选中并确认（鼠标→键盘回退）", async ({ page }) => {
			const sessionId = await spawnSessionWithOptionsPanel();
			const panel = await openPanel(page, sessionId, [
				"1. Confirm — create this goal now",
				"3. Cancel — discard this draft",
			]);

			// 点第 2 项：面板壳不处理点击，点的是帧文本行
			await panel.getByText("2. Continue chatting — keep refining").click();

			// 选项经 done 回传 → 面板关闭 → 结果经 ctx.ui.notify 回显到聊天
			await expect(page.getByTestId("tui-panel-expanded")).toHaveCount(0, {
				timeout: 20_000,
			});
			await expect(
				page.locator(
					'[data-testid^="custom-"]:has-text("tui-demo-options 选择：2 Continue chatting")',
				),
			).toBeVisible({ timeout: 20_000 });
		});

		test("面板三态：收起为挂件、再收为胶囊、点胶囊展开", async ({ page }) => {
			const sessionId = await spawnSessionWithPanel();
			const panel = await openPanel(page, sessionId);

			// 「—」收起 → 挂件卡片（标题栏第一个按钮）
			await page
				.getByTestId("tui-panel-header")
				.getByRole("button")
				.first()
				.click();
			const badge = page.getByTestId("tui-panel-badge");
			await expect(badge).toBeVisible({ timeout: 10_000 });
			await expect(page.getByTestId("tui-panel-expanded")).toHaveCount(0);
			// 挂件卡片带实时帧预览行
			await expect(badge).toContainText("alpha");
			await expect(badge).toContainText("beta");

			// 「–」再收起 → 胶囊
			await badge.getByRole("button").click();
			const pill = page.getByTestId("tui-panel-pill");
			await expect(pill).toBeVisible({ timeout: 10_000 });
			await expect(page.getByTestId("tui-panel-badge")).toHaveCount(0);

			// 点胶囊 → 回到展开态浮窗，且帧内容仍在
			await pill.click();
			await expect(page.getByTestId("tui-panel-expanded")).toBeVisible({
				timeout: 10_000,
			});
			await expect(page.getByTestId("tui-panel-expanded")).toContainText("gamma");
		});

		/**
		 * 输入法（IME）中文上屏的真实浏览器验证（第四层）。
		 *
		 * 链路：展开态面板的隐藏 textarea（data-testid=tui-panel-ime）是 IME 落点；
		 * 输入法在它上面组词 → compositionend → TuiPanel 取上屏文本整串 POST
		 * 「/api/extensions/tui-input({type:'key',data:'你好'})」→ kernel 写假终端 → pi-tui 组件
		 * handleInput 收到整串 → 回显面板把「你好」渲染成帧行。
		 *
		 * 用 CDP 在真实 Chromium 里走一遍真实 IME 事件序列（compositionstart →
		 * compositionupdate → compositionend；探针已确认 insertText 会补发 compositionend
		 * 且 textarea.value 落定为上屏文本），所以这是「真浏览器 + 真 DOM 事件链路」，
		 * 不是页面里手搓事件。
		 */
		test("IME 中文上屏：真实输入法事件 → 假终端 → 帧回显", async ({ page }) => {
			const sessionId = await spawnSessionWithEchoPanel();

			// (c) 先挂请求采集：断言页面确实发出了携带中文的 POST /api/extensions/tui-input
			const tuiPosts: Array<Record<string, unknown>> = [];
			page.on("request", (req) => {
				if (
					req.method() === "POST" &&
					req.url().includes("/api/extensions/tui-input")
				) {
					try {
						tuiPosts.push(JSON.parse(req.postData() ?? "{}"));
					} catch {
						/* 本接口请求体必为 JSON，解析失败则忽略 */
					}
				}
			});

			const panel = await openPanel(page, sessionId, ["Echo Panel"]);

			// IME 落点（隐藏 textarea）必须聚焦，输入法才会在它上面组词
			const ime = page.getByTestId("tui-panel-ime");
			await expect(ime).toBeAttached();
			await ime.focus();

			// 真实输入法链路：CDP 让 Chromium 在聚焦元素上组词并提交「你好」
			const cdp = await page.context().newCDPSession(page);
			await cdp.send("Input.imeSetComposition", {
				text: "ni hao",
				selectionStart: 6,
				selectionEnd: 6,
			});
			// insertText 提交组词：Chromium 补发 compositionend，textarea.value 落定为上屏文本
			await cdp.send("Input.insertText", { text: "你好" });

			// (a) 帧里出现中文：上屏文本真的经假终端被插件消费并渲染到帧上
			await expect(panel).toContainText("你好", { timeout: 10_000 });
			// 反向断言：组词中间态（拼音串）不得进假终端——组词期按键一个都不许转发
			await expect(panel).not.toContainText("ni hao");

			// (b) 落点被清空、无残值（残留会跟着下一次按键被重复发送）
			await expect(ime).toHaveValue("");

			// (c) 页面发出了携带中文的 type:key POST（POST 体里的 data 含「你好」）
			await expect
				.poll(
					() =>
						tuiPosts.some(
							(p) => p.type === "key" && String(p.data).includes("你好"),
						),
					{ timeout: 5_000 },
				)
				.toBe(true);
		});

		/**
		 * 真实输入框桩（/tui-demo-input）：不是「按键回显」，而是一个可编辑的单行输入框。
		 * 验的是真实编辑语义下的输入法：组词拼音不进值、选词后整串落进值、
		 * 光标跟随（候选框贴输入位置）、退格可编辑。
		 */
		test("真实输入框桩：IME 中文上屏进值、光标跟随、退格可编辑", async ({ page }) => {
			const sessionId = await spawnSessionWithInputPanel();
			const panel = await openPanel(page, sessionId, ["Input Demo"]);
			const ime = page.getByTestId("tui-panel-ime");
			await expect(ime).toBeAttached();

			// 输入框桩在光标处发 CURSOR_MARKER → 帧光标非空 → 落点/候选框跟着光标
			await expect(page.getByTestId("tui-panel-cursor")).toBeAttached();

			const cdp = await page.context().newCDPSession(page);
			await cdp.send("Input.imeSetComposition", {
				text: "ni hao",
				selectionStart: 6,
				selectionEnd: 6,
			});
			await cdp.send("Input.insertText", { text: "你好" });

			// 中文进了输入框的值（真实编辑语义），而不是逐键回显；落点无残值
			await expect(panel).toContainText("输入：你好", { timeout: 10_000 });
			await expect(panel).not.toContainText("ni hao");
			await expect(ime).toHaveValue("");

			// 退格键可编辑：删掉最后一个字
			await page.keyboard.press("Backspace");
			await expect(panel).toContainText("输入：你", { timeout: 5_000 });
		});

		/**
		 * 鼠标点一下面板（mousedown 不 preventDefault，为保住原生拖选）会让浏览器把焦点
		 * 默认给「最近的聚焦祖先」——容器 div（tabindex=0），而不是 IME 落点。
		 * 容器不可编辑 → 输入法不再启动。
		 */
		test("IME 落点常驻焦点：点击面板正文后再组词，中文仍能上屏", async ({ page }) => {
			const sessionId = await spawnSessionWithEchoPanel();
			const panel = await openPanel(page, sessionId, ["Echo Panel"]);
			const ime = page.getByTestId("tui-panel-ime");
			const cdp = await page.context().newCDPSession(page);
			const compose = async (pinyin: string, text: string) => {
				await cdp.send("Input.imeSetComposition", {
					text: pinyin,
					selectionStart: pinyin.length,
					selectionEnd: pinyin.length,
				});
				await cdp.send("Input.insertText", { text });
			};

			// 首次组词：面板打开后的自动聚焦路径
			await compose("ni hao", "你好");
			await expect(panel).toContainText("你好", { timeout: 10_000 });

			// 点一下正文：焦点必须仍在可编辑的落点上（否则浏览器不启动输入法）
			await page.getByTestId("tui-panel-body").click();
			await expect(ime).toBeFocused();

			// 再次组词：仍能上屏
			await compose("shi jie", "世界");
			await expect(panel).toContainText("世界", { timeout: 10_000 });
		});

		/**
		 * 守住既有契约（规格 §7.5）：面板帧是 DOM 文本，复制走「原生拖选 + Cmd+C」。
		 * IME 落点不能把这条路径打断。
		 */
		test("面板正文仍可原生拖选（IME 落点不打断文本选择）", async ({ page }) => {
			const sessionId = await spawnSessionWithEchoPanel();
			const panel = await openPanel(page, sessionId, ["Echo Panel"]);
			const line = panel.locator("div.whitespace-pre").first();
			const box = await line.boundingBox();
			expect(box).not.toBeNull();
			await page.mouse.move(box!.x + 20, box!.y + box!.height / 2);
			await page.mouse.down();
			await page.mouse.move(box!.x + 140, box!.y + box!.height / 2, {
				steps: 8,
			});
			await page.mouse.up();
			const probe = await page.evaluate(() => ({
				sel: window.getSelection()?.toString() ?? "",
				active:
					(document.activeElement as HTMLElement)?.getAttribute?.(
						"data-testid",
					) ?? document.activeElement?.tagName,
			}));
			expect(probe.sel.length).toBeGreaterThan(0);
			// 拖选期间不能把焦点抢回落点：抢了浏览器会清掉刚建立的文档选区（真浏览器实测）
			expect(probe.active).not.toBe("tui-panel-ime");
		});

		test("收起态下输入框恢复可用", async ({ page }) => {
			const sessionId = await spawnSessionWithPanel();
			await openPanel(page, sessionId);

			const textbox = page.locator(
				'[data-testid="composer-input"] [role="textbox"]',
			);
			// 展开态：键盘锁给面板，Composer 只读
			await expect(textbox).toHaveAttribute("contenteditable", "false");

			// 收起为胶囊（比挂件态更彻底，确保三态都不锁输入框）
			await page
				.getByTestId("tui-panel-header")
				.getByRole("button")
				.first()
				.click();
			await expect(page.getByTestId("tui-panel-badge")).toBeVisible({
				timeout: 10_000,
			});
			await page.getByTestId("tui-panel-badge").getByRole("button").click();
			await expect(page.getByTestId("tui-panel-pill")).toBeVisible({
				timeout: 10_000,
			});

			// 收起后：输入框恢复可编辑，且能真的输入
			await expect(textbox).toHaveAttribute("contenteditable", "true");
			await textbox.click();
			await textbox.pressSequentially("收起后可用");
			await expect(textbox).toContainText("收起后可用");
		});
	});

// 本机已有真实 kernel 占用 9776/5180 时（见 playwright.config.ts 的安全闸门）用偏移端口：
//   WA_PI_E2E_WS_PORT=19876 WA_PI_E2E_WEB_PORT=5182 WA_PI_WEB_PORT=5182 \
//     bun run --filter @wa-pi/frontend e2e -- tui-panel.spec.ts
