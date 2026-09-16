import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createProject, saveProvider, createSessionViaPrompt } from "./helpers";

// 浏览器环境没有 Electron IPC 桥：注入 mock 桥，验宿（主窗口）侧的驱动逻辑。
// 浮动模式的呈现是**独立系统窗口**，真实窗口行为由 e2e-electron/preview-window.spec.ts 验。
async function installPreviewBridge(
	page: import("@playwright/test").Page,
): Promise<void> {
	await page.addInitScript(() => {
		const calls = { opens: [] as unknown[], cmds: [] as unknown[] };
		const listeners: Array<(e: unknown) => void> = [];
		(window as any).__previewBridge = { calls, listeners };
		(window as any).waPiPreviewWin = {
			open: async (payload: unknown) => {
				calls.opens.push(payload);
				return { ok: true };
			},
			cmd: (payload: unknown) => calls.cmds.push(payload),
			act: () => {},
			setSize: () => {},
			onEvent: (cb: (e: unknown) => void) => {
				listeners.push(cb);
				return () => {};
			},
		};
	});
}

// 浏览器预览：分屏/全屏/浮动 + 本地 html 元素选中 chip
test.describe
	.serial("浏览器预览与元素选中", () => {
		const projectName = `e2e-preview-${randomUUID().slice(0, 8)}`;
		const cwd = `/tmp/${projectName}`;
		// 当前用例项目 id（beforeEach 建项目后填入；文件树用例需要在项目下建会话）
		let projectId = "";

		test.beforeEach(async ({ page }) => {
			// 本 spec 会注入 mock 桥（installPreviewBridge），而“默认模式”判定看的就是有没有 Electron 桥
			// （store/browser.ts defaultBrowserMode：有桥即默认浮窗）——这里显式固定 split，
			// 保持“内嵌预览”相关断言的原口径；浮动路径另有专门用例。
			// addInitScript 在每次导航前执行（下面还会 clear 一次 localStorage）。
			await page.addInitScript(() => {
				localStorage.setItem("hiagent.browser.mode", "split");
			});
			await page.goto("/");
			// 预览窗口模式按 origin 存 localStorage（E2E 隔离 WA_PI_DIR 但 localStorage 不隔离），
			// 串行用例间会互相污染默认模式，进页面前先清
			await page.evaluate(() => localStorage.clear());
			await page.goto("/");
			const proj = await createProject(projectName, cwd);
			projectId = proj?.id ?? "";
			mkdirSync(cwd, { recursive: true });
			writeFileSync(
				join(cwd, "index.html"),
				[
					"<!DOCTYPE html>",
					"<html>",
					"<head><title>t</title></head>",
					"<body>",
					'<div id="card">',
					"  <p>hello</p>",
					"</div>",
					"</body>",
					"</html>",
				].join("\n"),
			);
			await saveProvider({
				id: "e2e-preview-provider",
				name: "E2E Preview",
				slug: "e2e-preview",
				baseUrl: "http://localhost:9999/v1",
				apiKey: "sk-e2e",
				api: "openai-completions",
				models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
			});
		});

		test.afterAll(() => {
			rmSync(cwd, { recursive: true, force: true });
		});

		// 进入 session 视图（与 composer.spec.ts 同款 helper）
		async function enterSession(
			page: import("@playwright/test").Page,
			text: string,
		): Promise<void> {
			await page.goto("/");
			await expect(page.getByTestId("new-session-pane")).toBeVisible({
				timeout: 5000,
			});
			await page
				.getByTestId("model-selector")
				.selectOption({ label: "E2E Preview/model-a" });
			await page
				.locator('[data-testid="composer-input"] [role="textbox"]')
				.fill(text);
			await page.getByTestId("composer-send").click();
			await expect(page.getByTestId("session-view")).toBeVisible({
				timeout: 5000,
			});
		}

		// 打开预览并加载本地 html
		// 注意：地址栏用 POSIX 斜杠拼路径（join 在 Windows 产出 \tmp\...，前端 openPath
		// 的绝对路径判定不认 \ 开头的 rooted 路径，会当非法路径拒绝）；Node 侧写文件仍用 join
		async function openPreview(
			page: import("@playwright/test").Page,
		): Promise<void> {
			await page.getByTestId("btn-browser-preview").click();
			await expect(page.getByTestId("browser-panel")).toBeVisible();
			await page.getByTestId("browser-input").fill(`${cwd}/index.html`);
			await page.getByTestId("browser-input").press("Enter");
			await expect(page.getByTestId("html-preview-iframe")).toBeVisible();
		}

		test("split 模式：聊天与预览并存，拖分隔条改比例", async ({ page }) => {
			await enterSession(page, "预览分屏测试");
			await openPreview(page);
			// 并存：会话视图不被卸载
			await expect(page.getByTestId("session-view")).toBeVisible();
			await expect(page.getByTestId("browser-split-resizer")).toBeVisible();
			const panelBefore = await page.getByTestId("browser-panel").boundingBox();
			const resizer = await page
				.getByTestId("browser-split-resizer")
				.boundingBox();
			// 向左拖 150px：预览变宽
			await page.mouse.move(resizer!.x + 1, resizer!.y + 100);
			await page.mouse.down();
			await page.mouse.move(resizer!.x - 150, resizer!.y + 100, { steps: 5 });
			await page.mouse.up();
			const panelAfter = await page.getByTestId("browser-panel").boundingBox();
			expect(panelAfter!.width).toBeGreaterThan(panelBefore!.width + 100);
			// 向右回拖横穿预览 iframe（回归：iframe 吞事件导致拖拽卡死——
			// 无屏蔽时越过 iframe 边界的 mousemove 全部丢失，宽度几乎不变；此处断言宽度确实回缩）
			const resizer2 = await page
				.getByTestId("browser-split-resizer")
				.boundingBox();
			await page.mouse.move(resizer2!.x + 1, resizer2!.y + 100);
			await page.mouse.down();
			await page.mouse.move(resizer2!.x + 150, resizer2!.y + 200, { steps: 8 });
			await page.mouse.up();
			const panelAfter2 = await page.getByTestId("browser-panel").boundingBox();
			expect(panelAfter2!.width).toBeLessThan(panelAfter!.width - 100);
		});

		test("全屏/分屏模式切换", async ({ page }) => {
			await enterSession(page, "预览全屏测试");
			await openPreview(page);
			await page.getByTestId("browser-mode-full").click();
			await expect(page.getByTestId("session-view")).toBeHidden();
			await expect(page.getByTestId("browser-panel")).toBeVisible();
			await page.getByTestId("browser-mode-split").click();
			await expect(page.getByTestId("session-view")).toBeVisible();
		});

		test("遗留 float 偏好（浏览器无 Electron 桥）：html 预览不消失，自动降级为分屏", async ({
			page,
		}) => {
			// 浏览器环境没有 Electron 桥，但 localStorage 可能留着 float——早期版本 float 是
			// 主窗口内的 DOM 浮层，同一 origin 的持久化偏好会被继承。float 的承载者现在是
			// 独立系统窗口，无桥时它没有任何承载者：旧实现下打开预览直接「毫无反应」，
			// 而且面板不渲染，用户也没有 UI 出路切回内嵌。
			// 注意：beforeEach 也注册了 addInitScript（把 mode 设回 split，防止串行用例互相污染），
			// addInitScript 按注册顺序执行，这里后注册的一条在每次导航时最后执行 → 最终为 float，
			// 不能改用 evaluate+reload（reload 同样触发 beforeEach 那条脚本，会把 float 覆盖掉）。
			await page.addInitScript(() =>
				localStorage.setItem("hiagent.browser.mode", "float"),
			);
			await page.goto("/");
			await enterSession(page, "预览遗留浮动偏好");
			await openPreview(page);
			// 面板在 = 预览没被吞（旧行为下此处会等不到 browser-panel）
			await expect(page.getByTestId("browser-panel")).toBeVisible();
			await expect(page.getByTestId("browser-split-resizer")).toBeVisible();
			// 无桥时不渲染浮动按钮（点了只会让预览消失且无路可退）
			await expect(page.getByTestId("browser-mode-float")).toHaveCount(0);
			// 只降级读取、不改写偏好：同 origin 的桌面端下次仍按 float 生效
			expect(
				await page.evaluate(() => localStorage.getItem("hiagent.browser.mode")),
			).toBe("float");
		});

		test("浮动模式：交给独立窗口承载（主窗口不再渲染内嵌浮层）", async ({
			page,
		}) => {
			await installPreviewBridge(page);
			await enterSession(page, "预览浮动测试");
			await openPreview(page);
			await page.getByTestId("browser-mode-float").click();
			// 浮动预览已改为独立系统窗口：主窗口不残留旧的内嵌浮层，也不留面板
			await expect(page.getByTestId("float-window")).toHaveCount(0);
			await expect(page.getByTestId("browser-panel")).toHaveCount(0);
			// 聊天不受影响（浮动模式不再占用主窗口预览区）
			await expect(page.getByTestId("session-view")).toBeVisible();
			// 宿主已按当前预览内容请求开窗
			const opens = await page.evaluate(
				() => (window as any).__previewBridge.calls.opens,
			);
			expect(opens.at(-1).path).toContain("index.html");
		});

		test("浮动模式：最小化为气泡，点击气泡请求恢复窗口", async ({ page }) => {
			await installPreviewBridge(page);
			await enterSession(page, "预览最小化测试");
			await openPreview(page);
			await page.getByTestId("browser-mode-float").click();
			// 独立窗口上报最小化（真实场景由 Electron 主进程中转，这里直接投递事件）
			await page.evaluate(() =>
				(window as any).__previewBridge.listeners.forEach((cb: any) =>
					cb({ type: "minimized" }),
				),
			);
			// 主窗口出现恢复入口，聊天不受影响
			await expect(page.getByTestId("float-bubble")).toBeVisible();
			await expect(page.getByTestId("session-view")).toBeVisible();
			// 等 pop-in 动画（0.18s）结束：动画期间 transform: scale 会让 boundingBox 取到缩放态
			await page.waitForTimeout(400);
			// 气泡可拖动停放位置（拖完持久化）
			const bubble = page.getByTestId("float-bubble");
			const before = await bubble.boundingBox();
			await page.mouse.move(before!.x + 22, before!.y + 22);
			await page.mouse.down();
			await page.mouse.move(before!.x - 58, before!.y - 58, { steps: 5 });
			await page.mouse.up();
			const after = await bubble.boundingBox();
			expect(Math.abs(after!.x - before!.x + 80)).toBeLessThan(20);
			expect(Math.abs(after!.y - before!.y + 80)).toBeLessThan(20);
			// 持久化（debounce 300ms，等 500ms 后读 localStorage）
			await page.waitForTimeout(500);
			const saved = await page.evaluate(() =>
				JSON.parse(localStorage.getItem("hiagent.browser.bubblePos") ?? "null"),
			);
			expect(Math.abs(saved.x - after!.x)).toBeLessThan(2);
			expect(Math.abs(saved.y - after!.y)).toBeLessThan(2);
			// 点击气泡（无拖动）→ 清除最小化并请求恢复独立窗口
			await page.getByTestId("float-bubble").click();
			await expect(page.getByTestId("float-bubble")).toHaveCount(0);
			const cmds = await page.evaluate(
				() => (window as any).__previewBridge.calls.cmds,
			);
			expect(cmds.at(-1)).toEqual({ type: "restore" });
		});

		test("元素选中：hover 高亮 → 发送到聊天 → chip 落入输入框", async ({
			page,
		}) => {
			await enterSession(page, "元素选中测试");
			await openPreview(page);
			const frame = page.frameLocator('[data-testid="html-preview-iframe"]');
			// hover #card：inspect 工具条出现（hover 命中最深的 <p>，工具条显示元素名 p）
			await frame.locator("#card").hover();
			const sendBtn = frame.getByText("发送到聊天");
			await expect(sendBtn).toBeVisible({ timeout: 5000 });
			await expect(frame.getByText("p", { exact: true })).toBeVisible();
			// 模拟真实鼠标：从元素分步移向工具条（路径穿过元素与工具条之间的间隙，
			// 覆盖"移动中选中被切走导致按钮点不到"的回归）
			const btnBox = await sendBtn.boundingBox();
			await page.mouse.move(
				btnBox!.x + btnBox!.width / 2,
				btnBox!.y + btnBox!.height / 2,
				{ steps: 12 },
			);
			// 选择父级：高亮目标上移（#card 的父级是 body）；工具条元素名更新为 div#card
			await frame.getByText("选择父级").click();
			await expect(frame.getByText("div#card", { exact: true })).toBeVisible();
			// 锁定回归：鼠标移回 #card 内的 <p> 上，选中保持 div#card 不被子元素抢回
			await frame.locator("#card p").hover();
			await expect(frame.getByText("div#card", { exact: true })).toBeVisible();
			// 移出 #card → 解锁，hover 恢复（div#card 标签消失）
			await frame.locator("html").hover({ position: { x: 400, y: 300 } });
			await expect(frame.getByText("div#card", { exact: true })).toHaveCount(0);
			// 重新选中 #card：hover <p> 再选择父级
			await frame.locator("#card p").hover();
			await frame.getByText("选择父级").click();
			await expect(frame.getByText("div#card", { exact: true })).toBeVisible();
			// 再上移到 body：body 也锁定（覆盖"body 不锁导致选中立刻被子元素抢回"的回归）
			await frame.getByText("选择父级").click();
			await expect(frame.getByText("body", { exact: true })).toBeVisible();
			await frame.locator("#card p").hover();
			await expect(frame.getByText("body", { exact: true })).toBeVisible();
			// 移到页边空白（命中 html）→ 解锁；重新选中 div#card 再发送
			await frame.locator("html").hover({ position: { x: 400, y: 300 } });
			await frame.locator("#card p").hover();
			await frame.getByText("选择父级").click();
			await expect(frame.getByText("div#card", { exact: true })).toBeVisible();
			// 发送到聊天：元素以 内联 chip 出现在输入框文本流里（非附件栏）
			await sendBtn.click();
			const chip = page.locator('[data-testid="composer-input"] .chip-element');
			await expect(chip).toBeVisible({ timeout: 5000 });
			await expect(chip).toContainText("index.html");
			// 附件栏不出现元素附件
			await expect(page.getByTestId("attachment-chip")).toHaveCount(0);
		});

		test("元素 chip 随消息发送（含行号定位文本）", async ({ page }) => {
			await enterSession(page, "元素发送测试");
			// enterSession 的首条消息让 agent 卡在运行中（假 provider 不回复），
			// 先停止——否则后续消息进队列面板（纯文本），无法断言消息列表 chip 回显
			await page.getByTestId("btn-stop").click();
			await expect(page.getByTestId("btn-stop")).toBeHidden({ timeout: 10000 });
			await openPreview(page);
			// 先输入文本再插入 chip（fill 会整体替换内容，后输入会把 chip 抹掉）
			await page
				.locator('[data-testid="composer-input"] [role="textbox"]')
				.fill("改这个元素");
			const frame = page.frameLocator('[data-testid="html-preview-iframe"]');
			await frame.locator("#card").hover();
			// hover 命中的是 #card 内最深的 <p>（第 6 行）；先「选择父级」上移高亮到
			// #card（第 5 行 <div>），再发送，chip 才带 index.html:5 定位
			await frame.getByText("选择父级").click();
			await frame.getByText("发送到聊天").click();
			const chip = page.locator('[data-testid="composer-input"] .chip-element');
			await expect(chip).toBeVisible({ timeout: 5000 });
			// chip 带行号（静态文件可定位：index.html:5 <div>）
			await expect(chip).toContainText("index.html:5");
			await page.getByTestId("composer-send").click();
			// 发送后 chip 随文本清空；消息里的定位文本回显为 chip（非纯文本）
			await expect(chip).toHaveCount(0);
			await expect(page.getByText("改这个元素").first()).toBeVisible({
				timeout: 8000,
			});
			const msgChip = page
				.locator('[data-testid="session-view"] .chip-element')
				.first();
			await expect(msgChip).toBeVisible({ timeout: 8000 });
			await expect(msgChip).toContainText("index.html:5");
		});

		test("全屏预览关闭后，文件树展开状态不重置", async ({ page }) => {
			test.setTimeout(60_000);
			// 预置子目录：给文件树一个可展开的目录节点
			mkdirSync(join(cwd, "sub"), { recursive: true });
			writeFileSync(join(cwd, "sub", "a.txt"), "child");
			// REST 在本项目下建会话（enterSession 直发会落到默认工作区，树根不是项目 cwd）
			const session = await createSessionViaPrompt(projectId, {
				agentName: "dev",
				text: "e2e",
				model: "test-model",
				sessionId: "s-tree-" + Math.random().toString(36).slice(2),
			});
			await page.goto("/");
			await page.getByText(projectName).first().click();
			await page.getByTestId(`session-${session.id}`).click();
			await expect(page.getByTestId("session-view")).toBeVisible({
				timeout: 8000,
			});
			// 打开文件树并展开 sub 目录
			await page.getByTestId("btn-explorer").click();
			await expect(page.getByTestId("explorer-aside")).toBeVisible({
				timeout: 5000,
			});
			const panel = page.locator('[data-testid="explorer-panel"]');
			const subNode = panel.getByText("sub", { exact: true });
			await expect(subNode).toBeVisible({ timeout: 5000 });
			await subNode.click();
			const childNode = panel.getByText("a.txt", { exact: true });
			await expect(childNode).toBeVisible({ timeout: 5000 });
			// 打开预览 → 切全屏 → 全屏下关闭（bug 复现路径）
			await page.getByTestId("btn-browser-preview").click();
			await expect(page.getByTestId("browser-panel")).toBeVisible();
			await page.getByTestId("browser-mode-full").click();
			await page.getByTestId("browser-close").click();
			// 关闭后回到会话：文件树仍展开（子节点仍可见）——修复前整棵树重挂、回到全折叠
			await expect(page.getByTestId("explorer-aside")).toBeVisible();
			await expect(childNode).toBeVisible();
		});
	});
