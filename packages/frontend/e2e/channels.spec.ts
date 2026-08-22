import { expect, test } from "@playwright/test";
import { addSkillDir, saveProvider } from "./helpers";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KERNEL = `http://127.0.0.1:${process.env.WA_PI_E2E_WS_PORT ?? 9776}`;

/** 轮询直到 fn 返回真值，超时抛错（仿 helpers.ts 的 pollUntil，但该函数未导出） */
async function pollUntil<T>(
	fn: () => Promise<T | undefined | null | false>,
	timeoutMs = 10_000,
	intervalMs = 200,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > deadline) throw new Error("pollUntil 超时");
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}

test.describe
	.serial("IM 渠道机器人", () => {
		let channelId: string;

		test("设置页创建机器人（企微表单，假凭据）", async ({ page, request }) => {
			// 无供应商时 App 首启会弹 onboarding 向导遮挡点击，预置假 provider 规避
			await saveProvider({
				id: "e2e-channels-setup",
				name: "E2E Channels Setup",
				slug: "e2e-channels-setup",
				baseUrl: "http://localhost:9999/v1",
				apiKey: "sk-e2e",
				api: "openai-completions",
				models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
			});
			await page.goto("/");
			await page.getByTestId("settings-btn").click();
			await page.getByTestId("settings-nav-bots").click();
			await page.getByTestId("bots-new-btn").click();
			// 置灰项不可点
			await expect(page.getByTestId("channel-chip-feishu")).toHaveAttribute(
				"data-disabled",
				"true",
			);
			await page.getByTestId("channel-chip-wecom").click();
			await page.getByTestId("bot-name-input").fill("E2E机器人");
			await page.getByTestId("bot-botid-input").fill("ww-e2e-fake");
			await page.getByTestId("bot-secret-input").fill("fake-secret");
			await page.getByTestId("bot-save-btn").click();
			// 假凭据连接不上：卡片出现即可
			await expect(page.getByText("E2E机器人")).toBeVisible({ timeout: 5000 });
			// 立即删除该 wecom 渠道：假凭据会令 WecomAdapter 反复重连企微 WS，
			// 其重连噪音会阻塞后续 mock 渠道的进站处理（事件循环拥塞）。
			// 注意：必须按「本用例创建的渠道 id」删除——曾有按 type 查找误删用户真实渠道的事故。
			const list = await request.get(`${KERNEL}/api/channels`);
			const channels = ((await list.json()) as any).channels as any[];
			const created = channels.find(
				(c) => c.name === "E2E机器人" && c.credentials?.botId === "ww-e2e-fake",
			);
			if (created) await request.delete(`${KERNEL}/api/channels/${created.id}`);
		});

		test("设置页表单交互：智能体搜索下拉 / $技能弹层不截断 / 保存失败 toast 居中", async ({
			page,
		}) => {
			// 预置技能目录：E2E 用隔离 WA_PI_DIR，内置技能目录初始为空，$ 弹层将无数据
			const e2eSkillDir = join(tmpdir(), "wa-pi-e2e-channels-skill");
			mkdirSync(join(e2eSkillDir, "e2e-channel-skill"), { recursive: true });
			writeFileSync(
				join(e2eSkillDir, "e2e-channel-skill", "SKILL.md"),
				`---\nname: e2e-channel-skill\ndescription: 渠道测试技能\n---\n# e2e-channel-skill`,
			);
			await addSkillDir(e2eSkillDir);

			await page.goto("/");
			await page.getByTestId("settings-btn").click();
			await page.getByTestId("settings-nav-bots").click();
			await page.getByTestId("bots-new-btn").click();
			await page.getByTestId("channel-chip-wecom").click();

			// 1) 关联智能体：通用带搜索下拉（pill 展开 → 搜索框 → 过滤 → 选择生效）
			await page.getByTestId("bot-agent-select").click();
			await expect(page.getByTestId("bot-agent-search")).toBeVisible();
			const agentItems = page.locator(
				'[data-testid^="bot-agent-item-"]:not([data-testid="bot-agent-item-default"])',
			);
			await expect(agentItems.first()).toBeVisible();
			const total = await agentItems.count();
			// 搜索过滤：输入不匹配的关键词 → 列表收敛为空态
			await page.getByTestId("bot-agent-search").fill("zz-none-match");
			await expect(agentItems).toHaveCount(0);
			// 清空搜索 → 列表恢复，选择第一个智能体
			await page.getByTestId("bot-agent-search").fill("");
			await expect(agentItems).toHaveCount(total);
			await agentItems.first().click();
			// 选择后下拉关闭
			await expect(page.getByTestId("bot-agent-search")).not.toBeVisible();

			// 2) $ 技能补全弹层：portal 到 body，限高且不超出视口（不被设置弹窗裁剪）
			await page.getByTestId("bot-prompt-textarea").click();
			await page.getByTestId("bot-prompt-textarea").pressSequentially("$");
			const suggest = page.getByTestId("skill-suggest-list");
			await expect(suggest).toBeVisible();
			await expect(
				page.getByTestId("skill-suggest-item-e2e-channel-skill"),
			).toBeVisible();
			const box = (await suggest.boundingBox())!;
			const viewport = page.viewportSize()!;
			expect(box.height).toBeLessThanOrEqual(241); // 限高 240 + border
			expect(box.y).toBeGreaterThanOrEqual(0);
			expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
			await page.keyboard.press("Escape");

			// 3) 保存失败（缺 Bot ID）→ error toast 出现在屏幕中上方（水平居中，top: 10vh）
			await page.getByTestId("bot-name-input").fill("x");
			await page.getByTestId("bot-save-btn").click();
			const toast = page.getByTestId("toast-container");
			await expect(toast).toBeVisible();
			await expect(toast).toContainText("Bot ID");
			const tbox = (await toast.boundingBox())!;
			expect(Math.abs(tbox.x + tbox.width / 2 - viewport.width / 2)).toBeLessThan(
				60,
			);
			expect(Math.abs(tbox.y - viewport.height * 0.1)).toBeLessThan(60);
		});

		test("mock 渠道消息全链路：进站 → 回复 → 侧边栏 IM 页签 → 打开会话", async ({
			page,
		}) => {
			// 假 provider 的连接失败会走内核自动重试（指数退避），追问回包可能要等几十秒
			test.setTimeout(120_000);
			// 先打开页面并保持常驻：后续进站消息应通过 SSE 实时反映到侧边栏/会话详情
			await page.goto("/");
			// REST 建 mock 渠道（enabled，model 跟随智能体；E2E 环境无真实 provider，
			// 回复为错误提示也算链路通）
			const res = await page.request.post(`${KERNEL}/api/channels`, {
				data: {
					channel: {
						type: "mock",
						name: "E2E-Mock",
						enabled: true,
						credentials: { botId: "mock-b", secret: "mock-s" },
						agentName: "dev",
						model: null,
						extraSystemPrompt: "",
						replyGranularity: "standard",
					},
				},
			});
			expect(res.ok()).toBeTruthy();
			channelId = ((await res.json()) as any).channels[0].id;

			// 注入进站消息（页面保持打开，不刷新——验证 SSE 实时同步链路：
			// channel-conversations:changed 让 IM 页签出现会话，session:created 让会话详情可打开）
			await page.request.post(`${KERNEL}/api/channels/${channelId}/mock-inbound`, {
				data: { chatId: "u-e2e", text: "你好" },
			});
			// outbox 出现回复（无真实模型 → 错误提示回复，链路通即可）
			await pollUntil(async () => {
				const r = await page.request.get(
					`${KERNEL}/api/channels/${channelId}/mock-outbox`,
				);
				const body = (await r.json()) as any;
				return body.messages?.length > 0 ? body : null;
			});

			// 侧边栏 IM 页签出现会话，点击打开（不刷新页面，回归「运行中点开详情空白」问题）
			await page.getByTestId("sidebar-tab-im").click();
			await expect(page.getByTestId("im-conv-list")).toBeVisible({
				timeout: 5000,
			});
			// 用 testid 前缀 + button 限定定位会话项（容器 div 也带 im-conv- 前缀；
			// getByText 会同时命中会话标题「IM · u-e2e」等元素）
			await page
				.locator('button[data-testid^="im-conv-"]', { hasText: "u-e2e" })
				.click();
			await expect(page.getByTestId("session-view")).toBeVisible({
				timeout: 5000,
			});
			// IM 来源文案拼在 header 状态行末尾
			await expect(page.getByTestId("session-view")).toContainText(
				"经「E2E-Mock」接入",
			);
			// 回归「点击 IM 会话详情空白」：修复前前端 sessions 列表无此会话，SessionView 返回 null，
			// session-view 根本不出现。消息内容在此环境无法断言——「Model not found」错误在 prompt
			// 入口处抛出，pi 未持久化任何消息（已核实 /messages 为空），真实模型下才有消息可显示。

			// 界面追问：在会话视图直接发消息，走与 IM 侧相同的 prompt 链路，
			// agent_end 后 MockAdapter 应收到第二条回复。
			// （E2E 环境无真实模型，回复为「处理出错：…」错误文案即证明链路闭环；
			//  按粒度组装的正文/文件变更汇总由 kernel 单测 reply-composer 覆盖）
			await saveProvider({
				id: "e2e-channels-provider",
				name: "E2E Channels",
				slug: "e2e-channels",
				baseUrl: "http://localhost:9999/v1",
				apiKey: "sk-e2e",
				api: "openai-completions",
				models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
			});
			await page
				.getByTestId("model-selector")
				.selectOption({ label: "E2E Channels/model-a" });
			// 思考强度调 off：假 provider 不可达，pi 自动重试链在 thinking=high 下 settle 需 ~90s，
			// off 下 ~15s；本步验证的是链路闭环而非重试时长
			await page.getByTestId("thinking-selector").selectOption("disabled");
			await page
				.locator('[data-testid="composer-input"] [role="textbox"]')
				.fill("界面追问一条");
			await page.getByTestId("composer-send").click();
			// 假 provider 连接失败会走内核自动重试（退避），留足 90s
			await pollUntil(async () => {
				const r = await page.request.get(
					`${KERNEL}/api/channels/${channelId}/mock-outbox`,
				);
				const body = (await r.json()) as any;
				return body.messages?.length >= 2 ? body : null;
			}, 90_000);

			// ---- /new 保留历史 + 右键删除 ----
			// 记录当前（第一个）会话 id，发 /new 后它应作为历史会话继续可见
			const firstConvItems = await page
				.locator('button[data-testid^="im-conv-"]', { hasText: "u-e2e" })
				.all();
			expect(firstConvItems.length).toBeGreaterThanOrEqual(1);
			const firstConvTestId = await firstConvItems[0].getAttribute("data-testid");
			const firstSessionId = firstConvTestId!.replace("im-conv-", "");

			// /new 归档当前会话（指令不走智能体，立即返回）
			await page.request.post(`${KERNEL}/api/channels/${channelId}/mock-inbound`, {
				data: { chatId: "u-e2e", text: "/new" },
			});
			await pollUntil(async () => {
				const r = await page.request.get(
					`${KERNEL}/api/channels/${channelId}/mock-outbox`,
				);
				const body = (await r.json()) as any;
				return body.messages?.at(-1)?.text?.includes("新会话") ? body : null;
			});

			// 再发一条消息触发新会话建立；新会话落盘后前端 IM 列表刷新出现两条
			await page.request.post(`${KERNEL}/api/channels/${channelId}/mock-inbound`, {
				data: { chatId: "u-e2e", text: "新话题" },
			});
			// IM 列表出现两个 u-e2e 会话项（历史 + 当前）
			await pollUntil(async () => {
				const items = await page
					.locator('button[data-testid^="im-conv-"]', { hasText: "u-e2e" })
					.all();
				return items.length >= 2 ? items.length : null;
			}, 30_000);

			// 右键历史会话 → 删除聊天 → 确认 → 列表只剩当前会话
			await page
				.locator(`button[data-testid="im-conv-${firstSessionId}"]`)
				.click({ button: "right" });
			await expect(page.getByTestId("im-conv-context-menu")).toBeVisible();
			await page.getByTestId("im-menu-delete").click();
			await expect(page.getByTestId("confirm-dialog")).toBeVisible();
			await page.getByTestId("confirm-ok").click();
			// 历史会话从列表消失（onSessionDeleted 清理 mapping + 前端刷新）
			await pollUntil(async () => {
				const gone = await page
					.locator(`button[data-testid="im-conv-${firstSessionId}"]`)
					.count();
				return gone === 0 ? true : null;
			}, 10_000);
		});

		test("IM 会话顶部铅笔编辑通讯录备注名（自动补建 + 持久化）", async ({
			page,
		}) => {
			// 假 provider 的连接失败会走内核自动重试，留足超时
			test.setTimeout(120_000);
			// 无供应商时 App 首启会弹 onboarding 向导遮挡点击，预置假 provider 规避
			await saveProvider({
				id: "e2e-rename-provider",
				name: "E2E Rename",
				slug: "e2e-rename",
				baseUrl: "http://localhost:9999/v1",
				apiKey: "sk-e2e",
				api: "openai-completions",
				models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
			});
			await page.goto("/");
			// 建独立 mock 渠道
			const res = await page.request.post(`${KERNEL}/api/channels`, {
				data: {
					channel: {
						type: "mock",
						name: "E2E-Rename",
						enabled: true,
						credentials: { botId: "mock-r", secret: "mock-s" },
						agentName: "dev",
						model: null,
						extraSystemPrompt: "",
						replyGranularity: "standard",
					},
				},
			});
			expect(res.ok()).toBeTruthy();
			const renameChannelId = ((await res.json()) as any).channels[0].id;

			try {
				// 注入进站消息（单聊 u-rename），触发会话 + 通讯录采集
				await page.request.post(
					`${KERNEL}/api/channels/${renameChannelId}/mock-inbound`,
					{ data: { chatId: "u-rename", text: "你好" } },
				);
				await pollUntil(async () => {
					const r = await page.request.get(
						`${KERNEL}/api/channels/${renameChannelId}/mock-outbox`,
					);
					const body = (await r.json()) as any;
					return body.messages?.length > 0 ? body : null;
				});

				// 打开会话：顶部显示技术标题 + 铅笔图标
				await page.getByTestId("sidebar-tab-im").click();
				await expect(page.getByTestId("im-conv-list")).toBeVisible({
					timeout: 5000,
				});
				await page
					.locator('button[data-testid^="im-conv-"]', { hasText: "u-rename" })
					.click();
				await expect(page.getByTestId("session-view")).toBeVisible({
					timeout: 5000,
				});
				await expect(page.getByTestId("session-view")).toContainText(
					"IM · u-rename",
				);
				await expect(page.getByTestId("im-session-title-edit")).toBeVisible();

				// 点铅笔 → 输入框 → 输入备注名 → Enter 保存
				await page.getByTestId("im-session-title-edit").click();
				const input = page.getByTestId("im-session-title-input");
				await expect(input).toBeVisible();
				// 断言回填了原始标识（单聊标题同源 chatId = u-rename，而非空）
				await expect(input).toHaveValue("u-rename");
				await input.fill("李四");
				await input.press("Enter");
				// 顶部标题变为 IM · 备注名
				await expect(page.getByTestId("session-view")).toContainText("IM · 李四");

				// 刷新验证持久化（remark 已落盘，重新打开会话仍显示备注名）
				await page.reload();
				await page.getByTestId("sidebar-tab-im").click();
				await expect(page.getByTestId("im-conv-list")).toBeVisible({
					timeout: 5000,
				});
				await page
					.locator('button[data-testid^="im-conv-"]', { hasText: "李四" })
					.click();
				await expect(page.getByTestId("session-view")).toContainText("IM · 李四");
			} finally {
				await page.request.delete(`${KERNEL}/api/channels/${renameChannelId}`);
			}
		});

		test("群聊隔离：同群不同用户 → IM 列表出现两个独立会话，标题可区分", async ({
			page,
		}) => {
			// 假 provider 的连接失败会走内核自动重试，留足超时
			test.setTimeout(120_000);
			await page.goto("/");
			// 建独立的 mock 渠道（与上一用例隔离），用 group 类型 + 显式 fromUserId
			const res = await page.request.post(`${KERNEL}/api/channels`, {
				data: {
					channel: {
						type: "mock",
						name: "E2E-Group",
						enabled: true,
						credentials: { botId: "mock-g", secret: "mock-s" },
						agentName: "dev",
						model: null,
						extraSystemPrompt: "",
						replyGranularity: "standard",
					},
				},
			});
			expect(res.ok()).toBeTruthy();
			const groupChannelId = ((await res.json()) as any).channels[0].id;

			// 同一群 roomA，用户 alice 发消息
			await page.request.post(
				`${KERNEL}/api/channels/${groupChannelId}/mock-inbound`,
				{
					data: {
						chatId: "roomA",
						fromUserId: "alice",
						chatType: "group",
						text: "你好",
					},
				},
			);
			// 同一群 roomA，用户 bob 发消息
			await page.request.post(
				`${KERNEL}/api/channels/${groupChannelId}/mock-inbound`,
				{
					data: {
						chatId: "roomA",
						fromUserId: "bob",
						chatType: "group",
						text: "在吗",
					},
				},
			);
			// 等两条进站消息各自的回复入 outbox（假 provider 下回复为错误提示，链路通即可）
			await pollUntil(async () => {
				const r = await page.request.get(
					`${KERNEL}/api/channels/${groupChannelId}/mock-outbox`,
				);
				const body = (await r.json()) as any;
				return body.messages?.length >= 2 ? body : null;
			}, 90_000);

			// 侧边栏 IM 页签：同群两个用户应出现两个独立会话，标题含发送者可区分
			await page.getByTestId("sidebar-tab-im").click();
			await expect(page.getByTestId("im-conv-list")).toBeVisible({
				timeout: 5000,
			});
			// 群聊标题格式「群聊(roomA前8位) · 发送者」——两个用户各自一项
			await expect(page.getByText("群聊(roomA) · alice")).toBeVisible({
				timeout: 5000,
			});
			await expect(page.getByText("群聊(roomA) · bob")).toBeVisible({
				timeout: 5000,
			});

			// 清理本用例渠道
			await page.request.delete(`${KERNEL}/api/channels/${groupChannelId}`);
		});

		test.afterAll(async ({ request }) => {
			if (channelId) await request.delete(`${KERNEL}/api/channels/${channelId}`);
			rmSync(join(tmpdir(), "wa-pi-e2e-channels-skill"), {
				recursive: true,
				force: true,
			});
		});
	});
