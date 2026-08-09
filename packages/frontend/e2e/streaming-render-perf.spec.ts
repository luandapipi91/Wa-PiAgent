// 流式渲染性能优化 E2E（task-6 审查 Important-2）：react-virtuoso 虚拟化后的滚动行为
// 在真实浏览器中的覆盖。happy-dom 无真实滚动几何，无法测 followOutput/atBottomStateChange/
// scrollToIndex 的实际滚动效果——这些行为仅 E2E 可覆盖。
//
// 覆盖被删的 13 个滚动行为测试的核心子集：
//   1. 进入长会话 → 自动定位到最新回复（Important-1 回归点：异步历史加载后定位到末行）
//   2. 上滑离开底部 → 「滚动到底部」浮钮出现、跟随停止
//   3. 点击浮钮 → 回到底部、浮钮消失、恢复跟随
//
// 数据准备：向 E2E 隔离 WA_PI_DIR 写 projects.json 会话记录 + 足够长的 pi 会话 jsonl
// （内容高度显著超过视口），kernel 的 projectStore 每次请求重新 load，文件改动即生效。
import { test, expect } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { E2E_WA_PI_DIR } from "../playwright.config";
import { createProject, saveProvider, createSessionViaPrompt } from "./helpers";

const SESSION_ID = "s-e2e-virt-scroll-001";

/** 预置一个长会话（60 轮 user+assistant，正文较长确保整体高度远超视口）。 */
function seedLongSession() {
	const projPath = join(E2E_WA_PI_DIR, "projects.json");
	const data = JSON.parse(readFileSync(projPath, "utf8"));
	if (!data.sessions.some((s: any) => s.id === SESSION_ID)) {
		data.sessions.push({
			id: SESSION_ID,
			projectId: "e2e-proj-1",
			primaryAgent: "dev",
			title: "E2E虚拟化滚动",
			createdAt: 1,
			lastActivity: 1,
			piSessionFile: join(E2E_WA_PI_DIR, "sessions", `${SESSION_ID}.jsonl`),
		});
		writeFileSync(projPath, JSON.stringify(data, null, 2), "utf8");
	}
	mkdirSync(join(E2E_WA_PI_DIR, "sessions"), { recursive: true });

	const line = (id: string, parentId: string | null, role: string, text: string, ts: number) =>
		JSON.stringify({
			type: "message",
			id,
			parentId,
			message: { role, content: [{ type: "text", text }], timestamp: ts },
		});

	const lines: string[] = [
		JSON.stringify({ type: "session", version: 3, id: "e2e-virt-scroll-uuid" }),
	];
	let id = 1;
	let parentId: string | null = null;
	for (let i = 0; i < 60; i++) {
		const uId = `m${id++}`;
		lines.push(
			line(
				uId,
				parentId,
				"user",
				`这是第 ${i + 1} 个用户问题，用于测试虚拟化列表进入会话的滚动定位与浮钮行为。`,
				i * 2 + 1,
			),
		);
		parentId = uId;
		const aId = `m${id++}`;
		lines.push(
			line(
				aId,
				parentId,
				"assistant",
				`回答 ${i + 1}：这是一段较长的助手回复正文，确保整体内容高度显著超过浏览器视口，从而可以观察到滚动条与「滚动到底部」浮钮。当前是第 ${i + 1} 轮。`,
				i * 2 + 2,
			),
		);
		parentId = aId;
	}
	writeFileSync(
		join(E2E_WA_PI_DIR, "sessions", `${SESSION_ID}.jsonl`),
		lines.join("\n"),
		"utf8",
	);
}

/** 读取 virtuoso 滚动容器的 scrollTop/scrollHeight/clientHeight。 */
async function scrollMetrics(page: import("@playwright/test").Page) {
	return page.evaluate(() => {
		const el = document.querySelector(
			'[data-testid="message-list"]',
		) as HTMLElement | null;
		if (!el) return null;
		return {
			scrollTop: el.scrollTop,
			scrollHeight: el.scrollHeight,
			clientHeight: el.clientHeight,
		};
	});
}

test("长会话虚拟化：进入即定位最新 → 上滑浮钮 → 点浮钮回底", async ({ page }) => {
	test.setTimeout(90_000);
	seedLongSession();
	// 预置模型供应商：隔离环境默认无 provider，App 首启会弹出 onboarding 向导
	// （modal-overlay）拦截点击。配一个 provider 让向导不弹（同 composer.spec.ts 模式）。
	await saveProvider({
		id: "e2e-virt-scroll-provider",
		name: "E2E VirtScroll",
		slug: "e2e-virt-scroll",
		baseUrl: "http://localhost:9999/v1",
		apiKey: "sk-e2e",
		api: "openai-completions",
		models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
	});

	await page.goto("/");
	const row = page.getByTestId(`session-${SESSION_ID}`);
	await expect(row).toBeVisible({ timeout: 10_000 });
	await row.click();

	await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 10_000 });
	// 末轮回复渲染（定位到底部后末行可见）
	await expect(page.getByText("回答 60：")).toBeVisible({ timeout: 15_000 });

	// 1) 进入即定位到底部：scrollTop 接近 scrollHeight - clientHeight（距底 ≤ 40px）
	await expect
		.poll(
			async () => {
				const m = await scrollMetrics(page);
				if (!m) return 9999;
				return Math.round(m.scrollHeight - m.clientHeight - m.scrollTop);
			},
			{ timeout: 15_000, message: "进入会话应定位到最新回复（底部）" },
		)
		.toBeLessThanOrEqual(40);

	// 2) 上滑到顶部 → 浮钮出现、跟随停止
	await page.evaluate(() => {
		const el = document.querySelector(
			'[data-testid="message-list"]',
		) as HTMLElement;
		el.scrollTop = 0;
		// 派发原生 scroll 事件触发 Virtuoso 的 atBottomStateChange（→ stickBottom=false）
		el.dispatchEvent(new Event("scroll", { bubbles: true }));
	});
	const floatBtn = page.getByTestId(`scroll-bottom-${SESSION_ID}`);
	await expect(floatBtn).toBeVisible({ timeout: 8_000 });
	// 上滑后 scrollTop 应在顶部附近（确认确实离开了底部）
	const afterUp = await scrollMetrics(page);
	expect(afterUp!.scrollTop).toBeLessThan(80);
	// 首轮用户问题在顶部可见（虚拟化在顶部窗口渲染）
	await expect(page.getByText("这是第 1 个用户问题")).toBeVisible({ timeout: 8_000 });

	// 3) 点浮钮 → 回到底部、浮钮消失
	await floatBtn.click();
	await expect
		.poll(
			async () => {
				const m = await scrollMetrics(page);
				if (!m) return 9999;
				return Math.round(m.scrollHeight - m.clientHeight - m.scrollTop);
			},
			{ timeout: 10_000, message: "点击浮钮后应回到底部" },
		)
		.toBeLessThanOrEqual(40);
	await expect(floatBtn).toBeHidden({ timeout: 5_000 });
	// 回底后末轮回复再次可见
	await expect(page.getByText("回答 60：")).toBeVisible({ timeout: 5_000 });
});

// ============================================================================
// 任务 7 新增：流式渲染性能优化三场景验收（Layer 4 E2E）
//   场景 1：流式对话 message_start → 多个 message_update（同帧合帧）→ message_end 定稿，
//           断言流式中内容增长（合帧提交）、定稿后代码块高亮卡片出现；
//   场景 2：delegate 子代理 progress 运行中纯文本预览、result 到达后完整 markdown；
//   场景 3：长会话（200 条）虚拟化：DOM 消息行数远小于总数、上滑出浮钮、点浮钮回底。
//
// 与上方「长会话虚拟化滚动」用例的关系（避免重复）：
//   - 上方用例用 jsonl 文件 seed（60 条）验证【历史加载器路径】的滚动定位 + 浮钮回归
//     （任务 6 审查 Important-1/2 回归点）；
//   - 场景 3 用 store 直接注入 200 条，验证【虚拟化渲染路径】下 DOM 行数受限的性能证据
//     （200 条是性能边界，DOM 行数 < 60 是 react-virtuoso 生效的直接断言）。
//   两者数据准备路径不同、互补：上方覆盖异步历史加载定位，场景 3 覆盖大批量虚拟化 DOM 收益。
//
// 不依赖真实 LLM：createSessionViaPrompt 建会话壳 + 浏览器侧 store 注入 SDK 事件
// （与 fleet-same-agent.spec.ts 同款模式）。本 spec 不落盘任何截图/临时文件。
// ============================================================================

test.describe("流式渲染性能优化验收", () => {
	// 注：3 个场景各自在 beforeEach 独立建 project/session，互不共享状态，
	// 故用普通 describe（非 serial）——避免单场景失败中断其他场景的独立验收。
	// config 已 workers:1，仍顺序执行。
	let projectId = "";
	let projectName = "";

	test.beforeEach(async () => {
		projectName = `e2e-stream-perf-${randomUUID().slice(0, 8)}`;
		const project = await createProject(projectName, `/tmp/${projectName}`);
		projectId = project.id;
		await saveProvider({
			id: "e2e-sp-provider",
			name: "E2E SP",
			slug: "e2e-sp",
			baseUrl: "http://localhost:9999/v1",
			apiKey: "sk-e2e",
			api: "openai-completions",
			models: [{ id: "sp-model", contextWindow: 128000, maxTokens: 4096 }],
		});
	});

	// 进入会话视图（REST 建会话 → 侧栏点项目名 → 点会话行），与 fleet-same-agent 同款
	async function enterSession(
		page: import("@playwright/test").Page,
		text: string,
	): Promise<string> {
		await page.goto("/");
		await page.waitForTimeout(500);
		const sessionId = "s-e2e-sp-" + randomUUID().slice(0, 8);
		await createSessionViaPrompt(projectId, {
			agentName: "dev",
			text,
			model: "e2e-sp/sp-model",
			sessionId,
		});
		await page.getByText(projectName).first().click();
		await page.getByTestId(`session-${sessionId}`).click();
		return sessionId;
	}

	// 等历史加载完成，避免历史回声覆盖注入的 store 状态
	async function waitHistoryReady(
		page: import("@playwright/test").Page,
		sessionId: string,
	) {
		await page.evaluate(async (sid) => {
			const { useSessionStore } = await import("/src/store/session.ts");
			const deadline = Date.now() + 8000;
			while (useSessionStore.getState().historyLoadingBySession[sid]) {
				if (Date.now() > deadline) break;
				await new Promise((r) => setTimeout(r, 100));
			}
		}, sessionId);
	}

	// 滚动 message-list 到指定 scrollTop 并派发原生 scroll 事件（触发 virtuoso atBottomStateChange）
	async function scrollTo(
		page: import("@playwright/test").Page,
		top: number,
	) {
		await page
			.locator('[data-testid="message-list"]')
			.evaluate((el, t) => {
				el.scrollTop = t;
				el.dispatchEvent(new Event("scroll", { bubbles: true }));
			}, top);
	}

	test("流式对话：合帧更新 → 定稿后代码块高亮", async ({ page }) => {
		test.setTimeout(30_000);
		const sessionId = await enterSession(page, "流式对话测试");
		await waitHistoryReady(page, sessionId);

		// message_start 建流式占位 + 同步连发 20 个 text_delta（同一帧 → batcher 合帧后一次性提交）
		await page.evaluate(async (sid) => {
			const { useSessionStore } = await import("/src/store/session.ts");
			const h = useSessionStore.getState().handleSDKEvent;
			const now = Date.now();
			h(sid, { event: { type: "message_start", message: { role: "assistant", content: [], model: "m", timestamp: now } }, agentName: "dev" } as any);
			for (let i = 0; i < 20; i++) {
				h(sid, { event: { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `片段${i} ` } }, agentName: "dev" } as any);
			}
		}, sessionId);

		// 流式中：合帧提交后累积文本可见（最后一个 delta 内容在 DOM 中）
		await expect(page.getByText(/片段19/)).toBeVisible({ timeout: 5000 });

		// 定稿：权威消息含闭合代码块 → message_end 定稿覆盖 streaming
		await page.evaluate(async (sid) => {
			const { useSessionStore } = await import("/src/store/session.ts");
			useSessionStore.getState().handleSDKEvent(sid, {
				event: {
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "完整回复\n\n```js\nconst x = 1;\n```" }],
						model: "m", stopReason: "end_turn", timestamp: Date.now(),
					},
				},
				agentName: "dev",
			} as any);
		}, sessionId);

		// 定稿后代码块高亮卡片出现（llm-ui 块边界 → CodeBlockCard）
		await expect(page.getByTestId("code-block-card")).toBeVisible({ timeout: 5000 });
	});

	test("delegate 子代理：运行中纯文本预览，完成后 markdown", async ({ page }) => {
		test.setTimeout(30_000);
		const sessionId = await enterSession(page, "delegate 测试");
		await waitHistoryReady(page, sessionId);

		// 注入 delegate toolCall + running progress（output 含 markdown 源文）
		await page.evaluate(async (sid) => {
			const { useSessionStore } = await import("/src/store/session.ts");
			useSessionStore.getState().append(sid, {
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "tc-sp-1", name: "delegate", arguments: { agent: "pm", task: "调研" } }],
					model: "m", stopReason: "tool_use", timestamp: Date.now(),
				},
				agentName: "dev",
				sessionId: sid,
			} as any);
			useSessionStore.getState().handleSubagentProgress(sid, "tc-sp-1", {
				agent: "pm", status: "running", output: "**加粗** 中", tools: [], elapsedMs: 100,
			});
		}, sessionId);

		// 运行中：纯文本预览（StreamingOutput streaming=true && !settled），markdown 源文原样、无 <strong>
		const plain = page.getByTestId("streaming-output-plain");
		await expect(plain).toBeVisible({ timeout: 5000 });
		await expect(plain.locator("strong")).toHaveCount(0);

		// 完成：注入 toolResult → DelegateCard 切换 result，streaming=false → 完整 markdown
		await page.evaluate(async (sid) => {
			const { useSessionStore } = await import("/src/store/session.ts");
			useSessionStore.getState().append(sid, {
				message: {
					role: "toolResult", toolCallId: "tc-sp-1",
					content: [{ type: "text", text: "**加粗** 结果" }],
					isError: false, timestamp: Date.now(),
				},
				agentName: "dev",
				sessionId: sid,
			} as any);
		}, sessionId);

		// 完成态：result 到达后 DelegateCard 回复区默认折叠（有 progress 时 showReply=!hasProgress||progressExpanded），
		// 点击 progressSummary 的展开按钮（progressExpanded toggle）才显示回复区
		await page
			.locator('[data-testid="delegate-progress-tc-sp-1"] button')
			.click();
		// 展开后回复区渲染 StreamingOutput md（streaming=!result=false → markdown），<strong> 出现
		const md = page.getByTestId("streaming-output-md");
		await expect(md.locator("strong")).toBeVisible({ timeout: 5000 });
	});

	test("长会话虚拟化：DOM 行数受限，上滑浮钮、点浮钮回底", async ({ page }) => {
		test.setTimeout(30_000);
		const sessionId = await enterSession(page, "长会话测试");
		await waitHistoryReady(page, sessionId);

		// store 直接注入 200 条消息（user/assistant 交替，timestamp 唯一）
		await page.evaluate(async (sid) => {
			const { useSessionStore } = await import("/src/store/session.ts");
			const msgs = [];
			for (let i = 0; i < 200; i++) {
				msgs.push({
					message: i % 2 === 0
						? { role: "user", content: `问题 ${i}`, timestamp: 1000 + i }
						: { role: "assistant", content: [{ type: "text", text: `回答 ${i}` }], model: "m", stopReason: "end_turn", timestamp: 1000 + i },
					agentName: i % 2 === 0 ? undefined : "dev",
				});
			}
			useSessionStore.setState((s: any) => ({
				messagesBySession: { ...s.messagesBySession, [sid]: msgs },
			}));
		}, sessionId);

		// 进入定位到底部：末轮可见（virtuoso followOutput / 主动滚底）
		await scrollTo(page, 999999);
		await expect(page.getByText("回答 199")).toBeVisible({ timeout: 8000 });

		// 虚拟化：DOM 中消息行数远少于 200（react-virtuoso 仅渲染可见窗口 + overscan）
		const domRows = await page.locator('[data-testid^="msg-"]').count();
		expect(domRows).toBeLessThan(60);

		// 滚到顶部 → 浮钮出现、首轮可见（虚拟化窗口切换到顶部）
		await scrollTo(page, 0);
		const floatBtn = page.getByTestId(`scroll-bottom-${sessionId}`);
		await expect(floatBtn).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("问题 0")).toBeVisible({ timeout: 5000 });

		// 点浮钮回底 → 末轮再次可见、浮钮消失
		await floatBtn.click();
		await expect(page.getByText("回答 199")).toBeVisible({ timeout: 5000 });
		await expect(floatBtn).toBeHidden();
	});
});
