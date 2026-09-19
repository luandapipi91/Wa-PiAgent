// 预热占位会话 E2E（第四层）：新建会话页挂载时 getCommands 兜底会创建
// placeholder 预热记录（空标题、无消息）。用户未发送就离开/重启后，
// 该「幽灵会话」不得出现在侧栏。回归「莫名其妙的空会话」bug。
//
// 数据准备：直接向 E2E 隔离 WA_PI_DIR 的 projects.json 写入 placeholder 记录
// （kernel 的 projectStore 每次请求重新 load，文件改动即生效）。
import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_WA_PI_DIR } from "../playwright.config";

const GHOST_ID = "s-e2e-placeholder-001";
const NORMAL_ID = "s-e2e-normal-001";

function seedSessions() {
	const projPath = join(E2E_WA_PI_DIR, "projects.json");
	const data = JSON.parse(readFileSync(projPath, "utf8"));
	data.sessions = data.sessions.filter(
		(s: any) => s.id !== GHOST_ID && s.id !== NORMAL_ID,
	);
	// 幽灵：getCommands 兜底创建的预热占位记录（空标题 + placeholder 标记）
	data.sessions.push({
		id: GHOST_ID,
		projectId: "e2e-proj-1",
		primaryAgent: "dev",
		title: "",
		createdAt: 1,
		lastActivity: 1,
		piSessionFile: join(E2E_WA_PI_DIR, "sessions", `${GHOST_ID}.jsonl`),
		placeholder: true,
	});
	// 对照：正常会话必须仍可见（防止 loadActive 误伤）
	data.sessions.push({
		id: NORMAL_ID,
		projectId: "e2e-proj-1",
		primaryAgent: "dev",
		title: "E2E正常会话",
		createdAt: 2,
		lastActivity: 2,
		piSessionFile: join(E2E_WA_PI_DIR, "sessions", `${NORMAL_ID}.jsonl`),
	});
	writeFileSync(projPath, JSON.stringify(data, null, 2), "utf8");
}

test("预热占位会话（无消息幽灵）不出现在侧栏，正常会话不受影响", async ({
	page,
}) => {
	test.setTimeout(60_000);
	seedSessions();

	await page.goto("/");
	// 侧栏加载完成锚点：项目行可见（会话列表默认展开，无需点击 toggle）
	await expect(page.getByTestId("project-e2e-proj-1")).toBeVisible({
		timeout: 10_000,
	});
	// 对照组：正常会话可见
	await expect(page.getByTestId(`session-${NORMAL_ID}`)).toBeVisible({
		timeout: 10_000,
	});
	// 幽灵会话不出现
	await expect(page.getByTestId(`session-${GHOST_ID}`)).toHaveCount(0);
});
