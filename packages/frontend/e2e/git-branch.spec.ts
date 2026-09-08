// Git 分支管理 E2E：真实 kernel + 真 git 仓库（beforeAll 在隔离 WA_PI_DIR 下 init）
// 覆盖：GitToolbar 渲染、分支下拉搜索/切换、创建并检出新分支、Git 图谱提交行、无上游 pull 错误提示
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_WA_PI_DIR, E2E_WS_PORT } from "../playwright.config";
import { createProject, createSessionViaPrompt, saveProvider } from "./helpers";

const REPO = join(E2E_WA_PI_DIR, "git-e2e-repo");
const PROJECT_NAME = "GitE2E项目";
const API = `http://127.0.0.1:${E2E_WS_PORT}`;

function git(args: string): string {
	return execSync(`git ${args}`, { cwd: REPO, encoding: "utf-8" }).trim();
}

/** 造仓库：3 个提交 + 一个既有分支 feat/e2e-existing */
function seedRepo(): void {
	mkdirSync(REPO, { recursive: true });
	git("init -b master -q");
	git("config user.email e2e@test.local");
	git("config user.name e2e");
	writeFileSync(join(REPO, "a.txt"), "v1\n");
	git("add .");
	git('commit -qm "feat: e2e 初始提交"');
	writeFileSync(join(REPO, "b.txt"), "v2\n");
	git("add .");
	git('commit -qm "fix: e2e 第二个提交"');
	writeFileSync(join(REPO, "c.txt"), "v3\n");
	git("add .");
	git('commit -qm "docs: e2e 第三个提交"');
	git("tag v0.1.0");
	git("branch feat/e2e-existing");
}

let projectId = "";

/** 进入该项目的会话视图并返回 sessionId */
async function openSession(page: import("@playwright/test").Page) {
	await page.goto("/");
	await page.waitForTimeout(2000);
	const session = await createSessionViaPrompt(projectId, {
		agentName: "dev",
		text: "e2e",
		model: "test-model",
		sessionId: "s-git-" + Math.random().toString(36).slice(2),
	});
	await page.getByText(PROJECT_NAME).first().click();
	await page.getByTestId(`session-${session.id}`).click();
	await expect(page.getByTestId("session-view")).toBeVisible({
		timeout: 8000,
	});
	// git status 需一次 HTTP 拉取，给足余量
	await expect(page.getByTestId("git-toolbar")).toBeVisible({
		timeout: 10000,
	});
	return session.id as string;
}

test.describe
	.serial("Git 分支管理", () => {
		test.beforeAll(async () => {
			try {
				execSync("git --version", { stdio: "pipe" });
			} catch {
				test.skip(true, "系统无 git，跳过 Git E2E");
			}
			// 预置假 provider 规避首启 onboarding 向导（explorer.spec 同款）
			await saveProvider({
				id: "e2e-git-provider",
				name: "E2E Git",
				slug: "e2e_git",
				baseUrl: "http://localhost:9999/v1",
				apiKey: "sk-e2e",
				api: "openai-completions",
				models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
			});
			seedRepo();
			const project = await createProject(PROJECT_NAME, REPO);
			projectId = project.id;
		});

		test.afterAll(async () => {
			// 清理测试项目（仓库目录由 global-teardown 随 WA_PI_DIR 整体删除）
			if (projectId) {
				await fetch(`${API}/api/projects/${projectId}`, {
					method: "DELETE",
				}).catch(() => {});
			}
		});

		test("Git 工具栏渲染 + 分支下拉搜索与切换", async ({ page }) => {
			test.setTimeout(60_000);
			await openSession(page);

			// 工具栏：仅分支 chip（当前 master）
			await expect(page.getByTestId("git-toolbar")).toBeVisible();
			await expect(page.getByTestId("btn-git-pull")).toHaveCount(0);
			await expect(page.getByTestId("git-project-chip")).toHaveCount(0);
			await expect(page.getByTestId("branch-chip")).toContainText("master");

			// 打开分支下拉：两个分支都在
			await page.getByTestId("branch-chip").click();
			await expect(page.getByTestId("branch-menu")).toBeVisible();
			await expect(
				page.getByTestId("branch-item-feat/e2e-existing"),
			).toBeVisible();

			// 搜索过滤：输入 feat 后 master 被过滤掉
			await page.getByTestId("branch-search").fill("feat");
			await expect(page.getByTestId("branch-item-master")).toHaveCount(0);
			await page.getByTestId("branch-search").fill("");

			// 底部入口存在：拉取/刷新/创建分支/Git 图谱
			await expect(page.getByTestId("menu-git-pull")).toBeVisible();
			await expect(page.getByTestId("menu-git-refresh")).toBeVisible();
			await expect(page.getByTestId("btn-create-branch")).toBeVisible();
			await expect(page.getByTestId("btn-git-graph")).toBeVisible();

			// 切换到 feat/e2e-existing → chip 文案更新
			await page.getByTestId("branch-item-feat/e2e-existing").click();
			await expect(page.getByTestId("branch-chip")).toContainText(
				"feat/e2e-existing",
				{ timeout: 8000 },
			);
		});

		test("创建并检出新分支（非法名禁用提交）", async ({ page }) => {
			test.setTimeout(60_000);
			await openSession(page);

			await page.getByTestId("branch-chip").click();
			await page.getByTestId("btn-create-branch").click();
			await expect(page.getByTestId("create-branch-dialog")).toBeVisible();

			// 非法名：确认按钮禁用
			await page.getByTestId("branch-name-input").fill("bad name");
			await expect(page.getByTestId("btn-create-branch-confirm")).toBeDisabled();

			// 合法名：创建并立即切换
			await page.getByTestId("branch-name-input").fill("feat/e2e-new");
			await page.getByTestId("btn-create-branch-confirm").click();
			await expect(page.getByTestId("branch-chip")).toContainText("feat/e2e-new", {
				timeout: 8000,
			});
		});

		test("Git 图谱展示提交历史与装饰标签", async ({ page }) => {
			test.setTimeout(60_000);
			await openSession(page);

			await page.getByTestId("branch-chip").click();
			await page.getByTestId("btn-git-graph").click();
			const modal = page.getByTestId("git-graph-modal");
			await expect(modal).toBeVisible({ timeout: 8000 });

			// SVG 泳道 + 至少 3 条提交行 + 描述/作者/短 hash 列
			await expect(page.getByTestId("git-graph-svg").first()).toBeVisible();
			await expect(modal.locator('[data-testid^="git-log-row-"]')).toHaveCount(3, {
				timeout: 8000,
			});
			await expect(modal).toContainText("docs: e2e 第三个提交");
			await expect(modal).toContainText("feat: e2e 初始提交");
			await expect(modal).toContainText("e2e");
			// 当前分支所在行应有 HEAD 装饰
			await expect(modal.getByText("HEAD").first()).toBeVisible();

			// 列不错位：首行（带 HEAD/分支/tag 装饰 chip）描述列右缘不得越过日期列左缘
			const firstRow = modal.locator('[data-testid^="git-log-row-"]').first();
			const tds = firstRow.locator("td");
			const descBox = await tds.nth(1).boundingBox();
			const dateBox = await tds.nth(2).boundingBox();
			expect(descBox && dateBox).toBeTruthy();
			expect(descBox!.x + descBox!.width).toBeLessThanOrEqual(dateBox!.x + 1);

			await page.getByTestId("git-graph-close").click();
			await expect(modal).toHaveCount(0);
		});

		test("无上游仓库 pull 失败给出错误提示", async ({ page }) => {
			test.setTimeout(60_000);
			await openSession(page);

			// 菜单路径拉取：无 origin/上游 → kernel 返回 git.pullFailed → toast 容器出现错误提示
			await page.getByTestId("branch-chip").click();
			await page.getByTestId("menu-git-pull").click();
			await expect(page.getByTestId("toast-container")).toBeVisible({
				timeout: 10000,
			});
		});

		test("外部切换分支后界面动态刷新（git:changed 监听）", async ({ page }) => {
			test.setTimeout(60_000);
			await openSession(page);

			// 当前分支来自前面用例的操作结果（feat/e2e-new）
			const chip = page.getByTestId("branch-chip");
			await expect(chip).toContainText("feat/e2e-new", { timeout: 10000 });

			// 模拟「在别的地方切换了分支」：不经 UI，直接改仓库
			git("checkout master");

			// 不做任何界面操作，watcher → SSE git:changed → 前端自动刷新
			await expect(chip).toContainText("master", { timeout: 10000 });

			// 再切回来验证双向都灵
			git("checkout feat/e2e-new");
			await expect(chip).toContainText("feat/e2e-new", { timeout: 10000 });
		});

		test("新建会话页同样展示 Git 工具栏并随项目切换显隐", async ({ page }) => {
			test.setTimeout(60_000);
			await page.goto("/");
			await page.waitForTimeout(2000);

			// 点击侧栏项目名即进入该项目的新建会话页（App.onSelectProject → new-session 视图）
			await page.getByTestId(`project-name-${projectId}`).click();
			await expect(page.getByTestId("new-session-pane")).toBeVisible({
				timeout: 8000,
			});

			// 工具栏渲染（仅分支 chip 单入口）
			await expect(page.getByTestId("git-toolbar")).toBeVisible({
				timeout: 10000,
			});
			await expect(page.getByTestId("btn-git-pull")).toHaveCount(0);
			await expect(page.getByTestId("git-project-chip")).toHaveCount(0);
			await expect(page.getByTestId("branch-chip")).toBeVisible();

			// 与会话页一致靠右放置：工具栏中心应在面板右半区
			const paneBox = await page.getByTestId("new-session-pane").boundingBox();
			const barBox = await page.getByTestId("git-toolbar").boundingBox();
			expect(paneBox && barBox).toBeTruthy();
			expect(barBox!.x + barBox!.width / 2).toBeGreaterThan(
				paneBox!.x + paneBox!.width / 2,
			);

			// 项目下拉切到默认工作区 → 工具栏消失；切回 → 重新出现
			await page.getByTestId("project-select").selectOption("__system__");
			await expect(page.getByTestId("git-toolbar")).toHaveCount(0);
			await page.getByTestId("project-select").selectOption(projectId);
			await expect(page.getByTestId("git-toolbar")).toBeVisible({
				timeout: 10000,
			});
		});
	});
