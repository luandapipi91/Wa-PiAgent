import { test, expect } from "@playwright/test";
import { E2E_WS_PORT, E2E_WA_PI_DIR } from "../playwright.config";
import { saveProvider } from "./helpers";
// Task 11：CLI 建任务 + 配置错误修复 的 E2E。用 Node 侧 child_process/fs 模拟
// agent 经 CLI 写任务文件、直接写坏文件，需在 kernel 已分发资产后运行。
import { execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	rmSync,
	writeFileSync,
	readFileSync,
} from "node:fs";
import { join } from "node:path";

// 定时任务系统 E2E：任务 10（规格场景 ①⑤ 的浏览器端全链路）
//
// 覆盖（serial 连贯流）：
// 1. 切换 automation 页签 → 侧边栏任务列表 + 主区头部可见；无任务 → 主区新建引导页
// 2. 新建完整流程：+ 新建 → 弹窗内填名称 → 选计划类型(每周) → AgentDropdown 选执行角色 → 填指令 → 保存
//    → 弹窗关闭，有任务未选中 → 默认执行记录页
// 3. 点击任务卡片 → 详情四宫格；再点同一卡片取消选中 → 回执行记录页
// 4. 右键任务卡 → 删除确认弹窗 → 确认删除 → SSE 驱动列表恢复空态引导页
// 5. 执行记录行点击 → record-detail 页签回放该次执行的会话消息（写 jsonl → MessageList 渲染）→ 返回执行记录页
//
// 环境说明：
// - 执行角色「研发」由 global-setup 预置（agents/dev.md，displayName=研发）；
//   kernel 以 WA_PI_SKIP_AGENT_SEED=1 启动，无内置角色干扰。
// - App.tsx 监听 scheduled-tasks:changed SSE 事件重拉任务列表，删除后 UI 自动刷新。
// - 任务 id 不在 UI 暴露，经 REST GET /api/scheduled-tasks 按名称取（helpers.ts 未导出
//   通用 api，本 spec 局部实现同风格 fetch）。
//
// 清理：taskId 经 REST DELETE 幂等删除（afterAll 兜底 + 用例 5 内联验证删除生效）。

const BASE = `http://127.0.0.1:${E2E_WS_PORT}`;
const TASK_NAME = "E2E 测试任务";

/** 底层 REST 调用：非 2xx 抛错，返回解析后的 body（风格对齐 e2e/helpers.ts） */
async function api<T = any>(
	method: string,
	path: string,
	body?: unknown,
): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		method,
		headers:
			body === undefined ? undefined : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const data: any = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(
			`REST ${method} ${path} 失败(${res.status}): ${data?.error ?? ""}`,
		);
	}
	return data as T;
}

/** 轮询任务列表直到指定名称的任务出现（保存是 UI 触发的异步 POST） */
async function findTaskByName(name: string): Promise<any> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const data = await api<{ tasks: any[] }>("GET", "/api/scheduled-tasks");
		const hit = (data.tasks ?? []).find((t) => t.name === name);
		if (hit) return hit;
		if (Date.now() > deadline) throw new Error(`任务未出现: ${name}`);
		await new Promise((r) => setTimeout(r, 200));
	}
}

/** 清理用删除：忽略任务不存在的报错，永不抛出 */
async function deleteTaskQuiet(id: string): Promise<void> {
	if (!id) return;
	try {
		await api("DELETE", `/api/scheduled-tasks/${id}`);
	} catch {
		/* 忽略：任务可能已被用例 5 删除 */
	}
}

// ===== Task 11 专用：CLI 建任务 + 配置错误修复 两个新场景的常量与 helper =====
// e2e-proj-1 的 cwd 由 global-setup 预置（projects.json: cwd=$E2E_WA_PI_DIR/e2e-project）；
// kernel 启动时 ensureScheduledTasksAssets 向各项目分发 CLI 资产，并建 tasks/ logs/ 目录。
const PROJ_CWD = join(E2E_WA_PI_DIR, "e2e-project");
const CLI_ASSET = join(PROJ_CWD, ".wa-pi", "scheduled-tasks", "cron-task.ts");
const TASKS_DIR = join(PROJ_CWD, ".wa-pi", "scheduled-tasks", "tasks");
const LOGS_DIR = join(PROJ_CWD, ".wa-pi", "scheduled-tasks", "logs");

/** 清理用删除（URL 编码 id，支持中文任务 id）：忽略不存在的报错，永不抛出 */
async function deleteTaskQuietEncoded(id: string): Promise<void> {
	if (!id) return;
	try {
		await api("DELETE", `/api/scheduled-tasks/${encodeURIComponent(id)}`);
	} catch {
		/* 忽略：任务可能已被其它用例删除 */
	}
}

/** 轮询任务列表 errors 数组直到指定 taskId 的配置错误出现（坏文件 watcher 热载后条目出现） */
async function findTaskError(taskId: string): Promise<any> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const data = await api<{ errors: any[] }>("GET", "/api/scheduled-tasks");
		const hit = (data.errors ?? []).find((e) => e.taskId === taskId);
		if (hit) return hit;
		if (Date.now() > deadline) throw new Error(`配置错误未出现: ${taskId}`);
		await new Promise((r) => setTimeout(r, 200));
	}
}

/** 轮询执行记录直到指定任务出现一条含 status 的记录（运行态即落盘，无真实模型也有效） */
async function findRecord(taskId: string, timeoutMs = 30_000): Promise<any> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const data = await api<{ records: any[] }>(
			"GET",
			`/api/execution-records?taskId=${encodeURIComponent(taskId)}`,
		);
		const rec = (data.records ?? []).find((r) => r.status);
		if (rec) return rec;
		if (Date.now() > deadline) throw new Error(`执行记录未出现: ${taskId}`);
		await new Promise((r) => setTimeout(r, 300));
	}
}

/** 等待 kernel 把定时任务 CLI 资产分发到项目目录（ensureScheduledTasksAssets），上限 5s */
async function waitForCliAsset(): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!existsSync(CLI_ASSET) && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 200));
	}
	expect(existsSync(CLI_ASSET), `CLI 资产未就绪: ${CLI_ASSET}`).toBe(true);
}

test.describe
	.serial("定时任务自动化", () => {
		let taskId = "";

		test.beforeAll(async () => {
			// 预置假 provider：隔离环境默认无 provider，App 首启弹 onboarding 向导
			// （modal-overlay）拦截点击（同 streaming-render-perf.spec.ts 模式）
			await saveProvider({
				id: "e2e-automation-provider",
				name: "E2E Automation",
				slug: "e2e-automation",
				baseUrl: "http://localhost:9999/v1",
				apiKey: "sk-e2e",
				api: "openai-completions",
				models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
			});
		});

		test.beforeEach(async ({ page }) => {
			test.setTimeout(60_000);
			await page.goto("/", { timeout: 60_000 });
			// 切换到自动化 Tab（侧边栏分段标签 tasks | im | automation）
			await page.getByTestId("sidebar-tab-automation").click();
			await expect(page.getByTestId("automation-sidebar")).toBeVisible({
				timeout: 10_000,
			});
		});

		test.afterAll(async () => {
			await deleteTaskQuiet(taskId);
		});

		test("1 切换 automation 页签：无任务 → 主区新建引导页", async ({ page }) => {
			const sidebar = page.getByTestId("automation-sidebar");
			await expect(sidebar).toContainText("定时任务");
			await expect(page.getByTestId("automation-main-header")).toContainText(
				"定时任务",
			);
			// 干净隔离环境无预置任务 → 主区默认新建引导页（含直达新建按钮）
			const guide = page.getByTestId("automation-empty-guide");
			await expect(guide).toBeVisible();
			await expect(guide.getByTestId("automation-guide-new-btn")).toBeVisible();
		});

		test("2 新建定时任务完整流程：弹窗填表单 → 保存 → 列表展示", async ({
			page,
		}) => {
			// 点击「+ 新建」→ 表单以弹窗呈现（主区不再整页替换）
			await page.getByTestId("automation-new-btn").click();
			const form = page.getByTestId("task-edit-form");
			await expect(form).toBeVisible();
			// 弹窗标题显示新建，主区 header 保持任务详情标题
			await expect(page.getByTestId("task-edit-modal-title")).toContainText(
				"新建自动化",
			);
			await expect(page.getByTestId("automation-main-header")).toContainText(
				"定时任务",
			);

			// 填任务名称
			await page.getByTestId("task-name-input").fill(TASK_NAME);

			// 计划类型选「每周」（表单内第一个 select），周几保持默认（周一）
			await form.locator("select").first().selectOption("weekly");

			// 选择执行角色（global-setup 预置的「研发」）：通用 AgentDropdown —— pill 展开 → 列表项
			await page.getByTestId("task-agent-select").click();
			await page.getByTestId("task-agent-item-研发").click();
			await expect(page.getByTestId("task-agent-select")).toContainText("研发");
			// ▾ 图标右对齐：最后一个 span 右缘贴近 pill 按钮右缘（间距仅 padding）
			const agentPill = page.getByTestId("task-agent-select");
			const caretBox = await agentPill.locator("span").last().boundingBox();
			const pillBox = await agentPill.boundingBox();
			expect(caretBox).toBeTruthy();
			expect(pillBox).toBeTruthy();
			expect(
				pillBox!.x + pillBox!.width - (caretBox!.x + caretBox!.width),
			).toBeLessThanOrEqual(16);

			// 填任务指令：先验证 $ 触发技能弹窗（真实浏览器，contenteditable chip 输入框）
			const promptInput = page.getByTestId("task-prompt-input");
			await promptInput.fill("整理一下 $");
			await expect(page.getByTestId("skill-picker")).toBeVisible();
			// 弹窗宽度 = 输入框宽度（不横向撑满屏幕），顶部贴输入框底部（光标下方）
			const skillBox = await page.getByTestId("skill-picker").boundingBox();
			const inputBox = await promptInput.boundingBox();
			expect(skillBox).toBeTruthy();
			expect(inputBox).toBeTruthy();
			expect(skillBox!.width).toBeLessThanOrEqual(inputBox!.width + 2);
			expect(skillBox!.y).toBeGreaterThanOrEqual(
				inputBox!.y + inputBox!.height - 2,
			);
			await promptInput.fill("E2E：请整理今日文件");
			await expect(page.getByTestId("skill-picker")).toBeHidden();

			// 验证 @ 触发联系人选择器（派生状态：value 末尾 @ 即弹出，无需按键）
			await promptInput.fill("推送 @");
			await expect(page.getByTestId("contact-picker")).toBeVisible();
			// 联系人弹窗同样：宽度受限且贴输入框下方
			const contactBox = await page.getByTestId("contact-picker").boundingBox();
			expect(contactBox!.width).toBeLessThanOrEqual(inputBox!.width + 2);
			expect(contactBox!.y).toBeGreaterThanOrEqual(
				inputBox!.y + inputBox!.height - 2,
			);
			await promptInput.fill("E2E：请整理今日文件");
			await expect(page.getByTestId("contact-picker")).toBeHidden();

			// 必填齐全后保存按钮可用 → 点击保存
			const save = page.getByTestId("task-save-btn");
			await expect(save).toBeEnabled();
			await save.click();

			// 保存成功后弹窗关闭：store.createTask 新建后自动选中新任务（view=detail，
			// selectedTaskId=新任务）→ 主区默认展示任务详情视图（非执行记录页）
			await expect(page.getByTestId("task-detail-view")).toBeVisible();

			// 任务卡片出现在侧边栏（id 经 REST 查询，UI 不暴露）
			taskId = (await findTaskByName(TASK_NAME)).id;
			const card = page.getByTestId(`automation-task-${taskId}`);
			await expect(card).toBeVisible();
			await expect(card).toContainText(TASK_NAME);
		});

		test("3 详情→再点取消：四宫格展示后取消选中回执行记录页", async ({
			page,
		}) => {
			const card = page.getByTestId(`automation-task-${taskId}`);
			await expect(card).toBeVisible();
			await card.click();

			const detail = page.getByTestId("task-detail-view");
			await expect(detail).toBeVisible();
			await expect(detail).toContainText("计划时间");
			await expect(detail).toContainText("每周一 09:00"); // weekly + 默认周一 + 默认时间
			await expect(detail).toContainText("执行角色");
			await expect(detail).toContainText("研发");
			await expect(detail).toContainText("E2E：请整理今日文件");

			// 再点同一张卡片 → 取消选中 → 主区回默认执行记录页
			await card.click();
			await expect(page.getByTestId("execution-records")).toBeVisible();
			await expect(page.getByTestId("task-detail-view")).toBeHidden();
		});

		test("4 右键弹上下文菜单→删除：确认弹窗 → SSE 驱动恢复空态引导页", async ({
			page,
		}) => {
			const card = page.getByTestId(`automation-task-${taskId}`);
			await card.click({ button: "right" });

			// 右键弹上下文菜单（不再直接弹删除确认）：含立即执行/删除菜单项
			const menu = page.getByTestId("task-context-menu");
			await expect(menu).toBeVisible();
			await expect(menu).toContainText("立即执行");
			await expect(page.getByTestId("confirm-dialog")).toBeHidden();

			// 点「删除」→ 确认弹窗：任务名回显 + 危险确认
			await menu.getByTestId("task-menu-delete").click();
			const dialog = page.getByTestId("confirm-dialog");
			await expect(dialog).toBeVisible();
			await expect(dialog).toContainText(TASK_NAME);
			await dialog.getByTestId("confirm-ok").click();

			// 不 reload：kernel 广播 scheduled-tasks:changed → App 重拉任务列表 → 空态引导页自动出现，
			// 顺带验证 SSE 刷新链路
			await expect(page.getByTestId("automation-empty-guide")).toBeVisible({
				timeout: 10_000,
			});
			taskId = ""; // 已删，跳过 afterAll 兜底
		});

		test("5 执行记录详情：点详情回放该次执行的会话消息", async ({ page }) => {
			// 前置：用例 4 已删任务，本用例 REST 重建（agent 用 global-setup 预置 dev.md）
			await api("POST", "/api/scheduled-tasks", {
				name: TASK_NAME,
				agentId: "dev",
				prompt: "E2E：请整理今日文件",
				schedule: { type: "daily", time: "09:00" },
			});
			const task = await findTaskByName(TASK_NAME);
			taskId = task.id;

			// SSE scheduled-tasks:changed → App 重拉 → 空态引导页让位执行记录页（有任务未选中）
			await expect(page.getByTestId("execution-records")).toBeVisible({
				timeout: 10_000,
			});

			// 触发立即执行（fire-and-forget）→ 轮询执行记录直到 sessionId 回填
			// （E2E 假 provider：agent 回合会失败，但会话已创建、sessionId 已回填 record）
			await api("POST", `/api/scheduled-tasks/${taskId}/run`);
			let record: any;
			const deadline = Date.now() + 30_000;
			for (;;) {
				const data = await api<{ records: any[] }>(
					"GET",
					`/api/execution-records?taskId=${taskId}`,
				);
				record = (data.records ?? []).find((r) => r.sessionId);
				if (record || Date.now() > deadline) break;
				await new Promise((r) => setTimeout(r, 300));
			}
			expect(record, "执行记录未出现或 sessionId 未回填").toBeTruthy();

			// 直接写会话 jsonl（piSessionFile = <WA_PI_DIR>/sessions/<id>.jsonl）：
			// 让回放有内容可读（真实执行在假 provider 环境必然失败、消息为空）
			const { writeFileSync } = await import("node:fs");
			const jsonl = [E2E_WA_PI_DIR, "sessions", `${record.sessionId}.jsonl`].join(
				"/",
			);
			writeFileSync(
				jsonl,
				[
					JSON.stringify({ type: "session", version: 3, id: record.sessionId }),
					JSON.stringify({
						type: "message",
						id: "m1",
						parentId: null,
						message: {
							role: "user",
							content: [{ type: "text", text: "E2E定时任务指令" }],
							timestamp: 1,
						},
					}),
					JSON.stringify({
						type: "message",
						id: "m2",
						parentId: "m1",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "E2E执行完成回复" }],
							timestamp: 2,
						},
					}),
				].join("\n") + "\n",
				"utf8",
			);

			// 点记录行 → record-detail 页签：MessageList 复用渲染 jsonl 回放
			await page.getByTestId(`execution-record-row-${record.id}`).click();
			await expect(page.getByTestId("execution-detail-view")).toBeVisible({
				timeout: 10_000,
			});
			await expect(page.getByText("E2E定时任务指令")).toBeVisible({
				timeout: 15_000,
			});
			await expect(page.getByText("E2E执行完成回复")).toBeVisible();

			// 消息列表容器高度非零：锁住 flex 塌陷回归（父容器非 flex 时 MessageList
			// 根 div 的 flex-1 失效，Virtuoso absolute inset-0 高度塌陷为 0，消息不可见）
			const listBox = await page.getByTestId("message-list").boundingBox();
			expect(
				listBox?.height ?? 0,
				"消息列表容器高度应 > 0（flex 塌陷回归）",
			).toBeGreaterThan(0);

			// 返回 → 按来源快照回执行记录页
			await page.getByTestId("execution-detail-back").click();
			await expect(page.getByTestId("execution-records")).toBeVisible();
			await expect(page.getByTestId("execution-detail-view")).toBeHidden();
		});
	});

// ===== Task 11：定时任务 AI 化——CLI 外部建任务 + 配置错误修复 两条链 =====
// 场景 6：agent 经分发的 CLI 直接写任务文件 → watcher 热载 → 前端列表可见 →
//         触发立即执行 → 执行日志落盘 → 清理。模拟「agent 不经过 UI 建任务」的全链路。
// 场景 7：坏任务文件（缺 name）→ 面板「配置错误」条目 → 点进编辑表单补全 →
//         PUT upsert 修复 → 错误消失、任务正常显示。覆盖错误条目的展示与修复闭环。
test.describe
	.serial("定时任务 AI 化（CLI 建任务 + 配置错误修复）", () => {
		test.beforeAll(async () => {
			// 预置假 provider（幂等）：隔离环境无 provider 时 App 首启弹 onboarding 向导，
			// 拦截对 sidebar-tab-automation 的点击（同上方「定时任务自动化」模式）。
			await saveProvider({
				id: "e2e-automation-provider",
				name: "E2E Automation",
				slug: "e2e-automation",
				baseUrl: "http://localhost:9999/v1",
				apiKey: "sk-e2e",
				api: "openai-completions",
				models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
			});
		});

		test.beforeEach(async ({ page }) => {
			test.setTimeout(90_000);
			await page.goto("/", { timeout: 60_000 });
			await page.getByTestId("sidebar-tab-automation").click();
			await expect(page.getByTestId("automation-sidebar")).toBeVisible({
				timeout: 10_000,
			});
		});

		test("6 agent 经 CLI 创建任务 → 前端可见 → 触发 → 日志落盘 → 清理", async ({
			page,
		}) => {
			// 1. 等 kernel 分发 CLI 资产到 e2e-proj-1（cwd=$E2E_WA_PI_DIR/e2e-project）
			await waitForCliAsset();

			// 2. 模拟 agent：经 CLI 直接写任务文件（add 不依赖 kernel 在线）
			execSync(
				`bun "${CLI_ASSET}" add --name "E2E任务" --agent dev --schedule '{"type":"daily","time":"09:30"}' --prompt "E2E：请整理今日文件"`,
				{ cwd: PROJ_CWD },
			);

			let taskId = "";
			try {
				// 3. watcher 热载 → scheduled-tasks:changed SSE → 前端重拉 → 列表出现任务卡
				const task = await findTaskByName("E2E任务");
				taskId = task.id;
				await expect(page.getByTestId(`automation-task-${taskId}`)).toBeVisible({
					timeout: 10_000,
				});

				// 4. 触发立即执行（fire-and-forget，返回 200 即视为已受理）
				await api(
					"POST",
					`/api/scheduled-tasks/${encodeURIComponent(taskId)}/run`,
				);

				// 5. 执行记录落盘（运行态一起 appendRecord 写 logs/<id>.log；无真实模型时记录仍存在）
				await findRecord(taskId);

				// 6. 断言日志文件存在且非空（executeTask 启动时同步 append 了 running 态行）
				const logPath = join(LOGS_DIR, `${taskId}.log`);
				expect(existsSync(logPath), `执行日志未落盘: ${logPath}`).toBe(true);
				expect(readFileSync(logPath, "utf8").trim().length).toBeGreaterThan(0);
			} finally {
				// 清理：REST 删除任务 + 删除执行日志文件
				await deleteTaskQuietEncoded(taskId);
				rmSync(join(LOGS_DIR, `${taskId}.log`), { force: true });
			}
		});

		test("7 坏文件 → 面板显示配置错误 → 修复后消失", async ({ page }) => {
			// 1. 直接写一个坏任务文件（缺 name → parseTaskFile 抛错 → errors 条目）
			const badId = `坏-${Math.random().toString(36).slice(2, 8)}`;
			mkdirSync(TASKS_DIR, { recursive: true });
			writeFileSync(
				join(TASKS_DIR, `${badId}.md`),
				[
					"---",
					`schedule: ${JSON.stringify({ type: "daily", time: "09:30" })}`,
					'agentId: "dev"',
					"---",
					"",
					"E2E：这个坏文件缺 name，会被判定为配置错误",
					"",
				].join("\n"),
				"utf8",
			);

			try {
				// 2. watcher 热载 → errors 条目 + 面板「配置错误」卡片（含错误原因）
				const err = await findTaskError(badId);
				expect(err.error).toContain("name 不能为空");
				const errCard = page.getByTestId(`automation-task-error-${badId}`);
				await expect(errCard).toBeVisible({ timeout: 10_000 });
				await expect(errCard).toContainText("配置错误");
				await expect(errCard).toContainText("name 不能为空");

				// 3. 点击错误条目 → 编辑表单（回填 taskId/默认计划）→ 补全 name/agent/prompt → 保存
				await errCard.click();
				const form = page.getByTestId("task-edit-form");
				await expect(form).toBeVisible();
				await expect(page.getByTestId("task-edit-modal-title")).toContainText(
					"编辑自动化",
				);

				await page.getByTestId("task-name-input").fill("E2E修复任务");
				await page.getByTestId("task-agent-select").click();
				await page.getByTestId("task-agent-item-研发").click();
				await expect(page.getByTestId("task-agent-select")).toContainText("研发");
				await page.getByTestId("task-prompt-input").fill("E2E：修复后的任务指令");

				const save = page.getByTestId("task-save-btn");
				await expect(save).toBeEnabled();
				await save.click();

				// 4. PUT upsert 修复后：错误条目消失、任务正常显示、REST errors 已清空
				await expect(errCard).toBeHidden({ timeout: 10_000 });
				const task = await findTaskByName("E2E修复任务");
				await expect(page.getByTestId(`automation-task-${task.id}`)).toBeVisible({
					timeout: 10_000,
				});
				const after = await api<{ errors: any[] }>("GET", "/api/scheduled-tasks");
				expect(after.errors.find((e) => e.taskId === badId)).toBeFalsy();
			} finally {
				// 清理：删除修复后的任务 + 兜底删坏文件（若未修复成功）
				await deleteTaskQuietEncoded(badId);
				rmSync(join(TASKS_DIR, `${badId}.md`), { force: true });
			}
		});
	});
