// 新建会话默认角色 E2E（第四层）：
// ① 手动选过的角色要持久化（刷新后仍是它），不再被「最近活跃」压过；
// ② 从已有会话进入新建页时沿用该会话的角色（即使 lastAgent 是别的）。
// 回归背景：默认角色只靠「最近发过消息的角色」兜底，未发送的选择永远不记，
// 当前长会话持续活跃就会一直压住用户刚选的角色，看起来像「总选第一个」。
import { test, expect } from "@playwright/test";
import {
	saveProvider,
	createAgent,
	createSessionViaPrompt,
} from "./helpers";

const PROJECT_ID = "e2e-proj-1"; // global-setup 预置的「E2E项目」
const PROJECT_CWD = "/tmp/wa-pi-e2e-default-agent";

/** 幂等建智能体（serial 用例重复确保存在时，POST 已存在会报错，忽略） */
async function ensureAgent(name: string) {
	try {
		await createAgent(name);
	} catch {
		/* 已存在 */
	}
}

test.beforeEach(async () => {
	// 假 provider：避免首启向导弹窗 + 满足发送前置条件
	await saveProvider({
		id: "e2e-agent-memory-provider",
		name: "E2E Agent Memory",
		slug: "e2e-agent-memory",
		baseUrl: "http://localhost:9999/v1",
		apiKey: "sk-e2e",
		api: "openai-completions",
		models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
	});
	await ensureAgent("产品经理");
	await ensureAgent("代码审查员");
});

test("新建页选角色后刷新仍默认该角色（lastAgent 持久化）", async ({
	page,
}) => {
	test.setTimeout(60_000);
	await page.goto("/");
	const pane = page.getByTestId("new-session-pane");
	await expect(pane).toBeVisible({ timeout: 10_000 });

	// 选一个与当前默认不同的角色（初始值可能恰好就是目标角色，同项点击不会触发 onPick）
	const before = (await page.getByTestId("agent-select").textContent()) ?? "";
	const target = before.includes("产品经理") ? "代码审查员" : "产品经理";
	await page.getByTestId("agent-select").click();
	await page.getByTestId(`agent-item-${target}`).click();
	await expect(page.getByTestId("agent-select")).toContainText(target);

	// 持久化到 ui-prefs（zustand persist → localStorage）
	const lastAgent = await page.evaluate(() => {
		const raw = window.localStorage.getItem("wa-pi-ui-prefs");
		return raw ? JSON.parse(raw)?.state?.lastAgent : null;
	});
	expect(lastAgent).toBe(target);

	// 刷新（等同重启应用再进新建页）：默认仍是手动选过的角色
	await page.reload();
	await expect(page.getByTestId("new-session-pane")).toBeVisible({
		timeout: 10_000,
	});
	await expect(page.getByTestId("agent-select")).toContainText(target);
});

test("从已有会话进入新建页时沿用该会话的角色", async ({ page }) => {
	test.setTimeout(60_000);
	// 造一个「代码审查员」的会话（不经真实 LLM：prompt 落盘即返回）
	const session = await createSessionViaPrompt(PROJECT_ID, {
		agentName: "代码审查员",
		text: "旧会话",
		model: "e2e-agent-memory/model-a",
	});

	await page.goto("/");
	// 先把 lastAgent 钉成别的角色，验证「已有会话优先于 lastAgent」
	await page.getByTestId("new-session-pane").waitFor({ timeout: 10_000 });
	await page.getByTestId("agent-select").click();
	await page.getByTestId("agent-item-产品经理").click();

	// 点开那个已有会话
	await page.getByTestId("session-scope-recent").click();
	await page.getByTestId(`session-${session.id}`).click();
	await expect(page.getByTestId("session-view")).toBeVisible({
		timeout: 10_000,
	});

	// 从会话点「＋新建会话」：默认角色 = 该会话的角色
	await page.getByTestId("recent-new-session").click();
	await expect(page.getByTestId("new-session-pane")).toBeVisible({
		timeout: 10_000,
	});
	await expect(page.getByTestId("agent-select")).toContainText("代码审查员");
});
