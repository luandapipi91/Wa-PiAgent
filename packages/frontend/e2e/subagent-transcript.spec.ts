// E2E（Layer 4）：子代理转录 查看 / resume / 旧会话兼容
//
// 三个场景（规格 §9 + 任务 11 简报）：
//  1) 真实委托一次 → 打开会话 → 展开卡片 → 点「查看全部内容」→ 弹窗里思考/工具/正文三类都在 → 切筛选 → 关闭
//  2) resume：拿场景 1 的 agentId 再委托一次 → 同一份 jsonl 行数增长且 meta.resumeCount === 1
//  3) 旧会话（改造前产生的 delegate / fleet 记录）→ 卡片正常渲染、无「查看全部内容」按钮
//
// 真实模型调用是允许的（Ruling 5）——mock 无法证明 pi 的历史读回。委托次数控制在最少：
// 场景 1 一次真实委托，场景 2 一次 resume 续聊。
//
// 环境变量（可选覆盖，便于对真实历史跑回归）：
//  - E2E_SESSION_ID：复用已存在的父会话（不提供时场景 1 自建）
//  - E2E_LEGACY_SESSION_PATH / E2E_LEGACY_SESSION_ID：改造前产生的真实会话 jsonl
//    （E2E_LEGACY_SESSION_PATH 优先；否则在 ~/.pi/agent/sessions/<id>.jsonl 找）。
//    不提供时场景 3 用内置的合成旧格式转录（同样走「jsonl → kernel → 浏览器」真实链路）。
//
// 数据清理：会话均建在 E2E_WA_PI_DIR 隔离目录内，afterAll 经 REST 删除；不落盘任何截图。
import { test, expect } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { E2E_WA_PI_DIR, E2E_WS_PORT } from "../playwright.config";
import {
	createAgent,
	createSessionViaPrompt,
	deleteAgentQuiet,
	saveProvider,
	setUiPrefs,
} from "./helpers";

const BASE = `http://127.0.0.1:${E2E_WS_PORT}`;
const PROJECT_ID = "e2e-proj-1"; // global-setup 预置项目（cwd 存在，Explore 能读到文件）
const PROJECT_NAME = "E2E项目";
// E2E 环境的智能体名：global-setup 写的 dev.md（`name: dev` + `tools: read,bash,edit`）在 kernel
// 启动时被 migrateNameToDisplayName 迁移为 `研发.md`，且其 tools 白名单**不含 delegate** →
// 模型看不到委派工具。故本 spec 自建一个无 tools 白名单的专用智能体（tools=[] 走排除式，
// delegate 放行），用完即删。
const AGENT_NAME = "E2E转录";
const MODEL = "deepseek/deepseek-v4-flash";
const LEGACY_SESSION_ID = "s-e2e-legacy-001";

// 真实模型偶发不按指令调用工具 → 允许一次重试（断言不放宽）
test.describe.configure({ retries: 1 });

/** 从本机 pi 凭证库读 deepseek apiKey（仅测试运行期内存使用，不落盘） */
function readDeepseekKey(): string {
	const home = process.env.HOME || process.env.USERPROFILE || homedir();
	const auth = JSON.parse(
		readFileSync(join(home, ".pi", "agent", "auth.json"), "utf8"),
	);
	const key = auth?.deepseek?.key;
	if (!key) throw new Error("~/.pi/agent/auth.json 缺少 deepseek.key，无法执行 LLM E2E");
	return key;
}

/** kernel REST 调用（成功返回解析后 body，非 2xx 抛错） */
async function kernel<T = any>(
	method: string,
	path: string,
	body?: unknown,
): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		method,
		headers: body !== undefined ? { "content-type": "application/json" } : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	const data: any = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(`REST ${method} ${path} 失败(${res.status}): ${data?.error ?? JSON.stringify(data)}`);
	}
	return data as T;
}

interface TranscriptResponse {
	meta: { agentId: string; status: string; resumeCount?: number };
	messages: Array<{ message: unknown }>;
}

/** 轮询单个子代理转录，直到 resume 完成（resumeCount >= 1 且已离开 running）或超时。
 * 注意：resumeCount 在 spawn 前就已 +1（meta 置 running），必须等终态才是“已追加”。 */
async function waitForResume(
	sessionId: string,
	agentId: string,
	timeoutMs: number,
): Promise<TranscriptResponse> {
	const deadline = Date.now() + timeoutMs;
	let last: TranscriptResponse | undefined;
	for (;;) {
		last = await kernel<TranscriptResponse>(
			"GET",
			`/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(agentId)}`,
		);
		if ((last?.meta?.resumeCount ?? 0) >= 1 && last?.meta?.status !== "running") return last;
		if (Date.now() > deadline) return last;
		await new Promise((r) => setTimeout(r, 2000));
	}
}

/** 合成「改造前格式」的转录（旧 delegate 单任务 shape + 旧 fleet shape，均无 details.subagents）。 */
function syntheticLegacyTranscript(): string {
	const now = 1_700_000_000_000;
	const cwd = join(E2E_WA_PI_DIR, "e2e-project");
	const fleetId = "call_legacy_fleet_1";
	const delegateId = "call_legacy_delegate_1";
	const rows = [
		{ type: "session", version: 3, id: "e2e-legacy-uuid", timestamp: new Date(now).toISOString(), cwd },
		{
			type: "message",
			id: "lu1",
			parentId: null,
			message: { role: "user", content: [{ type: "text", text: "并行调查 A 与 B 两个模块" }], timestamp: now },
		},
		{
			type: "message",
			id: "la1",
			parentId: "lu1",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "拆成两个互不依赖的任务并行派发。" },
					{
						type: "toolCall",
						id: fleetId,
						name: "fleet",
						arguments: {
							tasks: [
								{ agent: "Explore", task: "调查 A" },
								{ agent: "Explore", task: "调查 B" },
							],
						},
					},
				],
				model: "legacy-model",
				stopReason: "tool_use",
				timestamp: now + 1,
			},
		},
		{
			type: "message",
			id: "lr1",
			parentId: "la1",
			message: {
				role: "toolResult",
				toolCallId: fleetId,
				toolName: "fleet",
				content: [{ type: "text", text: "【Explore】A 模块调查完成。\n\n【Explore】B 模块调查完成。" }],
				isError: false,
				timestamp: now + 2,
				// 旧 fleet shape：按序号统计 + 按序号 interrupted，**没有** subagents
				details: {
					fleet: {
						"0": { total: 3, done: 3, error: 0, running: 0 },
						"1": { total: 2, done: 2, error: 0, running: 0 },
					},
					interrupted: { "0": false, "1": false },
				},
			},
		},
		{
			type: "message",
			id: "lu2",
			parentId: "lr1",
			message: { role: "user", content: [{ type: "text", text: "再单独派一次 Explore 调查 C" }], timestamp: now + 3 },
		},
		{
			type: "message",
			id: "la2",
			parentId: "lu2",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: delegateId, name: "delegate", arguments: { agent: "Explore", task: "单独调查 C" } },
				],
				model: "legacy-model",
				stopReason: "tool_use",
				timestamp: now + 4,
			},
		},
		{
			type: "message",
			id: "lr2",
			parentId: "la2",
			message: {
				role: "toolResult",
				toolCallId: delegateId,
				toolName: "delegate",
				content: [{ type: "text", text: "C 模块单独调查完成。" }],
				isError: false,
				timestamp: now + 5,
				// 旧 delegate（单任务）shape：只有布尔 interrupted
				details: { interrupted: false },
			},
		},
	];
	return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

/** 向隔离目录写一个「旧格式」会话（projects.json 记录 + pi 会话 jsonl）。kernel 每次请求重新 load，改动即生效。 */
function seedLegacySession(): { realSource: boolean } {
	const projPath = join(E2E_WA_PI_DIR, "projects.json");
	const data = JSON.parse(readFileSync(projPath, "utf8"));
	const sessionPath = join(E2E_WA_PI_DIR, "sessions", `${LEGACY_SESSION_ID}.jsonl`);
	if (!data.sessions.some((s: any) => s.id === LEGACY_SESSION_ID)) {
		data.sessions.push({
			id: LEGACY_SESSION_ID,
			projectId: PROJECT_ID,
			primaryAgent: AGENT_NAME,
			title: "E2E 旧版委派会话",
			createdAt: 1,
			lastActivity: 1,
			piSessionFile: sessionPath,
		});
		writeFileSync(projPath, JSON.stringify(data, null, 2), "utf8");
	}

	// 源文件：优先 E2E_LEGACY_SESSION_PATH，其次 ~/.pi/agent/sessions/<E2E_LEGACY_SESSION_ID>.jsonl
	const explicit = process.env.E2E_LEGACY_SESSION_PATH;
	const byId = process.env.E2E_LEGACY_SESSION_ID
		? join(homedir(), ".pi", "agent", "sessions", `${process.env.E2E_LEGACY_SESSION_ID}.jsonl`)
		: "";
	const src = explicit && existsSync(explicit) ? explicit : byId && existsSync(byId) ? byId : "";

	mkdirSync(join(E2E_WA_PI_DIR, "sessions"), { recursive: true });
	if (!src) {
		writeFileSync(sessionPath, syntheticLegacyTranscript(), "utf8");
		return { realSource: false };
	}

	// 真实旧会话：只改首行 cwd，指向隔离项目 cwd——避免打开会话预热 pi 时在开发机凭空创建历史仓库目录。
	const lines = readFileSync(src, "utf8").split(/\r?\n/);
	if (lines.length > 0 && lines[0].trim()) {
		try {
			const head = JSON.parse(lines[0]);
			head.cwd = join(E2E_WA_PI_DIR, "e2e-project");
			lines[0] = JSON.stringify(head);
		} catch {
			/* 首行非 JSON：原样保留（预热失败也不影响只读历史渲染） */
		}
	}
	writeFileSync(sessionPath, lines.join("\n"), "utf8");
	return { realSource: true };
}

/** 展开页面上所有 turn-summary（整轮过程默认折叠，卡片不在 DOM 里）。
 * 列表是 Virtuoso 虚拟化的（只渲染视口附近的轮次）：可选先把视图滚到顶部，
 * 让早期的轮次进入 DOM；每轮重新查询并按 aria-expanded 判断，避免展开导致的
 * 行高变化让 .nth(i) 指向漂移。 */
async function expandAllTurnSummaries(
	page: import("@playwright/test").Page,
	opts?: { scrollToTop?: boolean },
) {
	if (opts?.scrollToTop) {
		const list = page.getByTestId("message-list");
		if (await list.isVisible().catch(() => false)) {
			await list.hover().catch(() => {});
			await page.mouse.wheel(0, -200_000);
			await page.waitForTimeout(500);
		}
	}
	await expect(page.getByTestId("turn-summary").first()).toBeVisible({ timeout: 30_000 });
	for (let round = 0; round < 10; round++) {
		const n = await page.getByTestId("turn-summary").count();
		let changed = false;
		for (let i = 0; i < n; i++) {
			const s = page.getByTestId("turn-summary").nth(i);
			if (!(await s.isVisible().catch(() => false))) continue;
			if ((await s.getAttribute("aria-expanded")) !== "true") {
				await s.click();
				changed = true;
			}
		}
		if (!changed) return;
	}
}

/** 展开页面上所有委托卡片体（ProcessCard 默认折叠，「查看全部内容」/任务行都在 body 里）。 */
async function expandDelegateCardBodies(page: import("@playwright/test").Page) {
	const headers = page.locator('[data-testid="delegate-card"] [data-testid$="-header"]');
	const n = await headers.count();
	for (let i = 0; i < n; i++) await headers.nth(i).click();
}

/** 在侧栏点开会话（session 行不在当前视图时先点所属项目）。 */
async function openSession(page: import("@playwright/test").Page, sessionId: string) {
	const row = page.getByTestId(`session-${sessionId}`);
	if (!(await row.isVisible().catch(() => false))) {
		// 会话行不在当前侧栏视图 → 先点所属项目展开（点完可能仍未命中：等一拍重试一次）
		await page.getByText(PROJECT_NAME).first().click().catch(() => {});
		await page.waitForTimeout(500);
		if (!(await row.isVisible().catch(() => false))) {
			await page.getByText(PROJECT_NAME).first().click().catch(() => {});
		}
	}
	await expect(row).toBeVisible({ timeout: 20_000 });
	await row.click();
	await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 15_000 });
}

test.describe.serial("子代理转录 E2E", () => {
	let sessionId = process.env.E2E_SESSION_ID ?? "";
	let agentId = "";
	const createdSessions: string[] = [];

	test.beforeAll(async () => {
		await saveProvider({
			id: randomUUID(),
			name: "DeepSeek",
			baseUrl: "https://api.deepseek.com",
			apiKey: readDeepseekKey(),
			api: "openai-completions",
			models: [{ id: "deepseek-v4-flash", contextWindow: 1_000_000, maxTokens: 384_000 }],
		});
		// 专用智能体：tools 为空 → 不启用 --tools 白名单 → 扩展注册的 delegate 工具可见
		await deleteAgentQuiet(AGENT_NAME);
		await createAgent(AGENT_NAME);
	});

	test.afterAll(async () => {
		for (const id of createdSessions) {
			await kernel("DELETE", `/api/sessions/${encodeURIComponent(id)}`).catch(() => {});
		}
		await deleteAgentQuiet(AGENT_NAME);
	});

	test("场景1：委托一次后可打开弹窗看到思考 / 工具 / 正文", async ({ page }) => {
		test.setTimeout(360_000);

		// 1) 触发一次真实委托（REST 建会话 + 发指令，会话 id 由我们指定以便场景 2 复用）
		if (!sessionId) sessionId = "s-e2e-transcript-" + randomUUID().slice(0, 8);
		if (!process.env.E2E_SESSION_ID) {
			await createSessionViaPrompt(PROJECT_ID, {
				agentName: AGENT_NAME,
				text:
					"必须使用 delegate 工具派发一个 Explore 子智能体来完成下面的调查，你自己不要执行任何工具。" +
					"任务内容：先用 ls 列出当前工作目录下的所有文件与目录（必须真的调用 ls），" +
					"再用 read 读取其中任意一个 .md 文件的前 20 行（必须真的调用 read），" +
					"最后用一段中文总结这个目录里有什么。" +
					"派发完成后把子智能体的结论简要转述给我即可。",
				model: MODEL,
				sessionId,
			});
			createdSessions.push(sessionId);
		}

		// 2) 打开会话
		await setUiPrefs(page, "zh");
		await page.goto("/");
		await openSession(page, sessionId);

		// 3) 等整轮结束（过程折叠成 turn-summary）→ 展开摘要 → 展开委托卡
		await expandAllTurnSummaries(page);
		const card = page.getByTestId("delegate-card").first();
		await expect(card).toBeVisible({ timeout: 30_000 });
		await expandDelegateCardBodies(page);

		// 4) 「查看全部内容」只在完成态、门控通过（agentId + jsonlPath 都非空）的行渲染
		const viewBtn = card.getByRole("button", { name: /查看全部内容/ }).first();
		await expect(viewBtn).toBeVisible({ timeout: 60_000 });
		await viewBtn.click();

		// 5) 弹窗内三类块都在（真实转录）
		const modal = page.getByTestId("subagent-transcript-modal");
		await expect(modal).toBeVisible({ timeout: 15_000 });
		await expect(modal.locator('[data-block="thinking"]').first()).toBeVisible({ timeout: 30_000 });
		await expect(modal.locator('[data-block="tool"]').first()).toBeVisible({ timeout: 30_000 });
		await expect(modal.locator('[data-block="text"]').first()).toBeVisible({ timeout: 30_000 });

		// 6) 筛选切换（纯前端过滤：工具块消失、思考块仍在）
		await modal.getByTestId("transcript-filter-thinking").click();
		await expect(modal.locator('[data-block="tool"]')).toHaveCount(0);
		await expect(modal.locator('[data-block="thinking"]').first()).toBeVisible();
		await modal.getByTestId("transcript-filter-all").click();
		await expect(modal.locator('[data-block="tool"]').first()).toBeVisible();

		// 7) 关闭
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("subagent-transcript-modal")).toHaveCount(0);

		// 8) 记录 agentId 供场景 2
		const list = await kernel<{ subagents: Array<{ agentId: string; status: string }> }>(
			"GET",
			`/api/sessions/${encodeURIComponent(sessionId)}/subagents`,
		);
		const done = list.subagents.find((s) => s.status === "completed");
		expect(done, "应有一个已完成的子代理实例").toBeTruthy();
		agentId = done!.agentId;
	});

	test("场景2：resume 复用同一 jsonl 且 resumeCount 递增", async ({}) => {
		test.setTimeout(300_000);
		expect(sessionId, "场景 1 应先建立会话").toBeTruthy();
		expect(agentId, "场景 1 应先建立子代理实例").toBeTruthy();

		const before = await kernel<TranscriptResponse>(
			"GET",
			`/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(agentId)}`,
		);
		const beforeLen = before.messages.length;
		console.log(
			`[e2e] resume 前：status=${before.meta.status} resumeCount=${before.meta.resumeCount} msgs=${beforeLen}`,
		);

		// 触发一次 resume（父代理经 delegate.tasks[].resume 续聊同一实例）
		await createSessionViaPrompt(PROJECT_ID, {
			agentName: AGENT_NAME,
			text:
				`请再次使用 delegate 工具续聊之前的子智能体：tasks 数组只放一项，` +
				`agent 填 "Explore"，resume 字段填 "${agentId}"，` +
				`task 填 "请再补充一句话：你刚才在这个目录里看到了哪几个条目？"。` +
				`不要自己回答，必须用 delegate 的 resume 续聊。`,
			model: MODEL,
			sessionId,
		});

		const after = await waitForResume(sessionId, agentId, 240_000);
		const rawLines = readFileSync(
			join(E2E_WA_PI_DIR, "subagents", sessionId, `${agentId}.jsonl`),
			"utf8",
		)
			.split("\n")
			.filter((l) => l.trim()).length;
		console.log(
			`[e2e] resume 后：status=${after.meta.status} resumeCount=${after.meta.resumeCount} msgs=${after.messages.length} rawJsonlLines=${rawLines}`,
		);
		expect(after.meta.resumeCount, "resume 后 meta.resumeCount 应为 1").toBe(1);
		expect(
			after.messages.length,
			`续聊应往同一份 jsonl 追加消息（前 ${beforeLen} → 后 ${after.messages.length}）`,
		).toBeGreaterThan(beforeLen);
	});

	test("场景3：旧会话（改造前 delegate / fleet 记录）正常渲染且无查看按钮", async ({ page }) => {
		test.setTimeout(120_000);
		const { realSource } = seedLegacySession();
		if (realSource) {
			// 仅真实旧会话需要清理（合成转录的会话记录保留在隔离目录内，teardown 整体清除）
			createdSessions.push(LEGACY_SESSION_ID);
		}
		console.log(`[e2e] 场景3 转录来源: ${realSource ? "真实改造前会话" : "合成旧格式转录"}`);

		await setUiPrefs(page, "zh");
		await page.goto("/");
		await openSession(page, LEGACY_SESSION_ID);
		// 真实旧会话可能有 80+ 条历史（虚拟化只渲染视口附近）：先滚到顶让早期轮次进 DOM
		await expandAllTurnSummaries(page, { scrollToTop: true });
		await expandDelegateCardBodies(page);

		// 旧 delegate / fleet 卡片正常渲染（统一卡片 renderer 兼容历史形状）
		const cards = page.locator('[data-testid="delegate-card"]');
		await expect(cards.first()).toBeVisible({ timeout: 20_000 });
		expect(await cards.count()).toBeGreaterThanOrEqual(1);
		// 任务统计行可见（证明卡片体已展开且有内容）
		await expect(page.getByText(/任务 1：/).first()).toBeVisible({ timeout: 20_000 });

		// 旧记录没有落盘转录 → 绝不应出现「查看全部内容」
		await expect(page.getByRole("button", { name: /查看全部内容/ })).toHaveCount(0);
	});
});
