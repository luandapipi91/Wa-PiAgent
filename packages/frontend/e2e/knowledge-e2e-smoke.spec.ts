import { test, expect } from "@playwright/test";
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureProvider, setUiPrefs, getAgentConfig } from "./helpers";

// 知识库前端 E2E 冒烟（任务 B6，合并前验收）：真实 kernel（隔离 WA_PI_DIR）+ 真实浏览器。
//
// 六步冒烟（串行一条流，共享夹具目录与 kbId）：
// 1. 设置 → 知识库 → 新建：文本输入夹具路径（浏览器无 Electron 原生目录对话框的兜底）→
//    扫描预览显示 3 文件 → 创建并索引 → 列表徽章变「就绪」
// 2. 智能体编辑（宫格右键 dev/研发）→ 知识库绑定区勾选该库 → 保存 →
//    REST 校验 knowledgeBaseIds 持久化 + 重开弹窗勾选回显
// 3. 对话提问夹具内容：降级不测——隔离环境无真实 LLM（假 provider 不可达），对话链路需
//    pi 进程真实回答才能观察 knowledge_search 调用；降级证据为步骤 2 的绑定持久化 + 回显
// 4. 修改夹具 md → fs.watch 触发（2s 防抖 + 60s 轮询兜底）自动重索引 →
//    lastIndexedAt 推进 + 块数 UI 变化
// 5. 删除库 → 级联清理：列表空 + 绑定区勾选行消失 + agent config 悬挂引用被清理
//
// embedding 模型（bge-base-zh-v1.5 q8）需预置到 E2E 隔离目录 models/（约 99MB），
// 缺失时索引内嵌阶段会现场从 hf-mirror 下载，ready 轮询超时需相应放宽。

const FIXTURE_DIR = join(tmpdir(), `kb-e2e-fixture-${process.pid}`);

function writeFixture(): void {
	mkdirSync(FIXTURE_DIR, { recursive: true });
	writeFileSync(
		join(FIXTURE_DIR, "定价政策.md"),
		[
			"# 定价政策",
			"",
			"昆仑云 2026 年服务定价如下。",
			"",
			"## 基础版",
			"基础版套餐每月 88 元，包含 10 个项目与 50GB 存储。",
			"",
			"## 专业版",
			"专业版套餐每月 199 元，包含不限项目与 500GB 存储。",
			"",
		].join("\n"),
		"utf8",
	);
	writeFileSync(
		join(FIXTURE_DIR, "功能规格.md"),
		[
			"# 功能规格",
			"",
			"昆仑云控制台支持知识库检索，检索通道包含语义与词法两路。",
			"语义通道使用本地向量模型，词法通道使用 BM25。",
			"",
		].join("\n"),
		"utf8",
	);
	writeFileSync(
		join(FIXTURE_DIR, "退役公告.md"),
		[
			"# 退役公告",
			"",
			"旧版导出工具将于 2026 年 12 月 31 日退役，请迁移到新版控制台。",
			"",
		].join("\n"),
		"utf8",
	);
}

/** REST 调用（helpers 的 api 未导出，这里就地实现同款） */
async function api(method: string, path: string, body?: unknown): Promise<any> {
	const res = await fetch(`http://127.0.0.1:${process.env.WA_PI_E2E_WS_PORT || 9776}${path}`, {
		method,
		headers: body !== undefined ? { "content-type": "application/json" } : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(`REST ${method} ${path} 失败(${res.status}): ${JSON.stringify(data)}`);
	}
	return data;
}

/** REST 读知识库清单（含实时 progress 与 status） */
async function listKbs(): Promise<Array<Record<string, any>>> {
	const data = await api("GET", "/api/knowledge");
	return (data?.kbs ?? []) as Array<Record<string, any>>;
}

/**
 * 读「研发」智能体的 config（按 displayName 定位）。
 * 不写死 dev：seed 的 dev.md 文件名与 displayName 不一致，首次保存会触发 kernel
 * 设计内的归一化 rename（displayName 即身份键，dev.md → 研发.md，绑定随 config 迁移），
 * 之后键不再悬 dev——回读必须按实际键定位；找不到「研发」直接失败（不静默退回 dev，
 * 那会拿到 rename 前的旧键或 default 空 config，掩盖定位失败）。
 */
async function getYanfaConfig(): Promise<any> {
	const list = await api("GET", "/api/agents");
	const target = (list?.agents ?? []).find((a) => a.displayName === "研发");
	if (!target?.displayName) throw new Error("REST 找不到智能体「研发」（定位失败，不回退 dev）");
	return getAgentConfig(String(target.displayName));
}

/** REST 轮询直到条件满足（E2E helper 的 pollUntil 未导出，这里就地实现） */
async function pollRest<T>(
	fn: () => Promise<T | undefined | null | false>,
	timeoutMs: number,
	intervalMs = 500,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > deadline) throw new Error("pollRest 超时");
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}

test.describe
	.serial("知识库前端 E2E 冒烟", () => {
		let kbId = "";

		test.beforeAll(async () => {
			writeFixture();
		});

		test.afterAll(async () => {
			// 夹具清理（AGENTS.md）：库经 UI 步骤删除，此处兜底删夹具目录与残留登记
			rmSync(FIXTURE_DIR, { recursive: true, force: true });
			if (kbId) {
				await api("DELETE", `/api/knowledge/${encodeURIComponent(kbId)}`).catch(
					() => {},
				);
			}
		});

		test("新建库：文本路径 → 扫描预览 3 文件 → 创建并索引 → 就绪", async ({
			page,
		}) => {
			test.setTimeout(180_000);
			await ensureProvider(); // 防 onboarding 向导拦截点击
			await setUiPrefs(page, "zh");
			await page.goto("/", { timeout: 60_000 });

			// 设置 → 知识库
			await page.getByTestId("settings-btn").click();
			await expect(page.getByTestId("settings-modal")).toBeVisible();
			await page.getByTestId("settings-nav-knowledge").click();
			await expect(page.getByTestId("kb-page")).toBeVisible();
			await expect(page.getByTestId("kb-empty")).toBeVisible();

			// 新建弹窗：文本输入路径兜底（浏览器无原生目录对话框）
			await page.getByTestId("kb-add-button").click();
			await expect(page.getByTestId("kb-form-modal")).toBeVisible();
			await page.getByTestId("kb-folder-input").fill(FIXTURE_DIR);

			// 扫描预览：路径选定（回车/失焦）即自动触发，显示 3 个可索引文件
			await page.getByTestId("kb-folder-input").press("Enter");
			await expect(page.getByTestId("kb-preview-indexable")).toContainText(
				"3",
				{ timeout: 15_000 },
			);

			// 创建并索引 → 弹窗关闭（POST 返回即落库，索引进度走 SSE）
			await page.getByTestId("kb-name-input").fill("E2E冒烟库");
			await page.getByTestId("kb-save").click();
			await expect(page.getByTestId("kb-form-modal")).toBeHidden({
				timeout: 15_000,
			});

			// REST 拿动态 kbId 并等索引终态 ready（embedding 走本地模型，预热后秒级）
			const kb = await pollRest(async () => {
				const found = (await listKbs()).find((k) => k.name === "E2E冒烟库");
				return found?.status === "ready" ? found : undefined;
			}, 120_000);
			kbId = kb.id as string;
			expect(kb.fileCount).toBe(3);

			// 列表徽章变「就绪」+ 卡片显示 3 文件
			await expect(page.getByTestId(`kb-status-${kbId}`)).toHaveText("就绪", {
				timeout: 15_000,
			});
			const card = page.getByTestId(`kb-card-${kbId}`);
			await expect(card).toContainText("3 文件");
		});

		test("智能体绑定：勾选 → 保存 → REST 持久化 + 重开回显", async ({
			page,
		}) => {
			test.setTimeout(120_000);
			expect(kbId, "前置：库已创建且就绪").toBeTruthy();
			await ensureProvider();
			await setUiPrefs(page, "zh");
			await page.goto("/", { timeout: 60_000 });

			// 宫格 → 右键 dev（显示名「研发」）→ 编辑智能体 → 详情弹窗
			await page.getByTestId("agent-collapsed").click();
			await expect(page.getByTestId("agent-gallery")).toBeVisible();
			await page
				.getByTestId("gallery-card-研发")
				.click({ button: "right" });
			await page.getByTestId("gallery-ctx-edit").click();
			await expect(page.getByTestId("agent-config")).toBeVisible();

			// 知识库绑定区勾选该库（BasicTab 内）
			const check = page.getByTestId(`kb-bind-check-${kbId}`);
			await expect(check).toBeVisible({ timeout: 15_000 });
			await check.check();
			await expect(check).toBeChecked();
			await page.getByTestId("cfg-save").click();
			await expect(page.getByTestId("agent-config")).toBeHidden({
				timeout: 15_000,
			});

			// 降级证据（对话链路不可达，见文件头说明）：REST 校验绑定已持久化
			const cfg = await getYanfaConfig();
			expect(cfg?.knowledgeBaseIds).toContain(kbId);

			// 重开弹窗回显：宫格（modal-overlay）保存后仍开着（编辑弹窗叠加其上，agents.spec 同坑），
			// 直接在宫格内右键卡片重开编辑弹窗，不能点 agent-collapsed（会被宫格 overlay 拦截）
			await page
				.getByTestId("gallery-card-研发")
				.click({ button: "right" });
			await page.getByTestId("gallery-ctx-edit").click();
			await expect(page.getByTestId("agent-config")).toBeVisible();
			await expect(page.getByTestId(`kb-bind-check-${kbId}`)).toBeChecked({
				timeout: 15_000,
			});
			await page.getByTestId("agent-config-close").click();
		});

		test("修改夹具 md：watcher 自动重索引 → lastIndexedAt 推进 + 块数变化", async ({
			page,
		}) => {
			test.setTimeout(150_000);
			expect(kbId, "前置：库已创建且就绪").toBeTruthy();
			await setUiPrefs(page, "zh");
			await page.goto("/", { timeout: 60_000 });

			// 修改前快照（REST）：块数与上次索引时间
			const before = (await listKbs()).find((k) => k.id === kbId);
			expect(before?.autoWatch, "autoWatch 默认开").toBe(true);
			const beforeChunks = before?.chunkCount ?? 0;
			const beforeTs = before?.lastIndexedAt ?? 0;

			// 打开知识库列表页（观察 UI 变化）
			await page.getByTestId("settings-btn").click();
			await expect(page.getByTestId("settings-modal")).toBeVisible();
			await page.getByTestId("settings-nav-knowledge").click();
			await expect(page.getByTestId(`kb-card-${kbId}`)).toBeVisible();

			// 修改夹具 md：追加大段文本（确保新增切块）
			appendFileSync(
				join(FIXTURE_DIR, "功能规格.md"),
				[
					"",
					"## 检索增强补充说明",
					"",
					"检索结果按相关度排序返回，单次最多返回 8 条。",
					"索引进度通过事件总线广播，前端按库过滤渲染进度徽章。",
					"文件监听采用加速器加兜底轮询的双通道设计，批量变更合并为一轮更新。",
					"块级切分保持标题层级上下文，跨块检索时附带所属标题路径。",
					"",
				].join("\n"),
				"utf8",
			);

			// fs.watch 加速 + 2s 防抖 + 一轮索引；60s 轮询兜底，超时给足
			const kb = await pollRest(async () => {
				const cur = (await listKbs()).find((k) => k.id === kbId);
				if (!cur) return undefined;
				const updated =
					(cur.lastIndexedAt ?? 0) > beforeTs &&
					(cur.chunkCount ?? 0) > beforeChunks;
				return updated ? cur : undefined;
			}, 120_000);
			expect(kb.fileCount).toBe(3); // 文件数不变，内容更新
			expect(kb.chunkCount).toBeGreaterThan(beforeChunks);

			// UI：块数文案变化。watcher 自动重索引无清单 SSE 广播（写操作就地更新仅限用户操作，
			// chunkCount 只随 listKbs 回包刷新），页面快照不会自动变——reload 后重进知识库页断言
			await page.reload({ timeout: 60_000 });
			await page.getByTestId("settings-btn").click();
			await expect(page.getByTestId("settings-modal")).toBeVisible();
			await page.getByTestId("settings-nav-knowledge").click();
			await expect(
				page.getByTestId(`kb-card-${kbId}`).getByText(`${kb.chunkCount} 块`),
			).toBeVisible({ timeout: 15_000 });
		});

		test("删除库：确认弹窗 → 列表清空 → 绑定区勾选行消失 + 悬挂引用清理", async ({
			page,
		}) => {
			test.setTimeout(120_000);
			expect(kbId, "前置：库已创建且就绪").toBeTruthy();
			await ensureProvider();
			await setUiPrefs(page, "zh");
			await page.goto("/", { timeout: 60_000 });

			// 知识库页删除 → 二次确认
			await page.getByTestId("settings-btn").click();
			await expect(page.getByTestId("settings-modal")).toBeVisible();
			await page.getByTestId("settings-nav-knowledge").click();
			await expect(page.getByTestId(`kb-card-${kbId}`)).toBeVisible();
			await page.getByTestId(`kb-delete-${kbId}`).click();
			await expect(page.getByTestId("confirm-dialog")).toBeVisible();
			await page.getByTestId("confirm-ok").click();

			// 列表清空
			await expect(page.getByTestId("kb-empty")).toBeVisible({
				timeout: 15_000,
			});
			const rest = await pollRest(async () => {
				return (await listKbs()).length === 0 ? true : undefined;
			}, 15_000);
			expect(rest).toBe(true);

			// 绑定区：该库的勾选行消失（失效 id 不产生行）。
			// 先关设置弹窗（否则其 modal-overlay 拦截后续点击），再从折叠栏开宫格
			await page.getByTestId("settings-close").click();
			await expect(page.getByTestId("settings-modal")).toBeHidden();
			await page.getByTestId("agent-collapsed").click();
			await page
				.getByTestId("gallery-card-研发")
				.click({ button: "right" });
			await page.getByTestId("gallery-ctx-edit").click();
			await expect(page.getByTestId("agent-config")).toBeVisible();
			await expect(page.getByTestId("kb-binding-section")).toBeVisible();
			await expect(page.getByTestId(`kb-bind-check-${kbId}`)).toHaveCount(0);

			// kernel 悬挂绑定清理：agent config 不再引用已删库 id
			const cfg = await getYanfaConfig();
			expect(cfg?.knowledgeBaseIds ?? []).not.toContain(kbId);
			await page.getByTestId("agent-config-close").click();

			// 本文件已完整走完删除链路，清掉共享 id 防止 afterAll 兜底重复删
			kbId = "";
		});

		test("索引进行中：统一「知识库生成中…」+ 编辑/重建置灰，就绪后恢复可用", async ({
			page,
		}) => {
			test.setTimeout(300_000);
			// 慢夹具：单个大 md 切出上千块 → 嵌入阶段要跑十几秒，留足「索引中」的观测窗口
			const SLOW_DIR = join(tmpdir(), `kb-e2e-slow-${process.pid}`);
			rmSync(SLOW_DIR, { recursive: true, force: true });
			mkdirSync(SLOW_DIR, { recursive: true });
			const sections: string[] = [];
			for (let i = 1; i <= 2000; i++) {
				sections.push(`## 节${i}\n\n第${i}节的正文内容，用于制造足够长的嵌入阶段。`);
			}
			writeFileSync(join(SLOW_DIR, "big.md"), sections.join("\n\n"), "utf8");

			await ensureProvider();
			await setUiPrefs(page, "zh");
			// REST 创建即触发索引（异步），UI 随后打开观察窗口
			const created = await api("POST", "/api/knowledge", {
				folderPath: SLOW_DIR,
				name: "E2E慢库",
			});
			const slowKbId = String(created.kb.id);
			try {
				await page.goto("/", { timeout: 60_000 });
				await page.getByTestId("settings-btn").click();
				await expect(page.getByTestId("settings-modal")).toBeVisible();
				await page.getByTestId("settings-nav-knowledge").click();
				const card = page.getByTestId(`kb-card-${slowKbId}`);
				await expect(card).toBeVisible({ timeout: 15_000 });

				// 进度区：统一文案 + 百分比 + 进度条；不再有阶段名，徽章也不再显示「索引中」
				await expect(card.getByText("知识库生成中…")).toBeVisible({
					timeout: 20_000,
				});
				await expect(card.getByText(/索引中/)).toHaveCount(0);
				await expect(page.getByTestId(`kb-progress-${slowKbId}`)).toBeVisible();

				// 索引进行中：编辑/重建置灰（kernel 会拒绝重建，按钮可点等于没反应）
				await expect(page.getByTestId(`kb-edit-${slowKbId}`)).toBeDisabled();
				await expect(page.getByTestId(`kb-reindex-${slowKbId}`)).toBeDisabled();

				// 就绪后：徽章「就绪」、编辑/重建恢复可用、进度区消失
				await expect(page.getByTestId(`kb-status-${slowKbId}`)).toHaveText(
					"就绪",
					{ timeout: 180_000 },
				);
				await expect(page.getByTestId(`kb-edit-${slowKbId}`)).toBeEnabled();
				await expect(page.getByTestId(`kb-reindex-${slowKbId}`)).toBeEnabled();
				await expect(page.getByTestId(`kb-progress-${slowKbId}`)).toHaveCount(0);
			} finally {
				// 索引若还在跑，先取消再删（kernel 拒绝删除进行中的库）
				await api("POST", `/api/knowledge/${encodeURIComponent(slowKbId)}/cancel`).catch(
					() => {},
				);
				await api("DELETE", `/api/knowledge/${encodeURIComponent(slowKbId)}`).catch(
					() => {},
				);
				rmSync(SLOW_DIR, { recursive: true, force: true });
			}
		});
	});
