// E2E 回归：codemode 嵌套子卡的长结果不得横向超出卡片
//
// 背景（bug，用户报告「codemode 调用显示超出边框」）：嵌套子卡（codemode → tools.xxx）
// 挂在 ToolCallNested 根节点里、位于外层 ProcessCard **之外**，继承不到 ProcessCard body
// 上的 overflow-wrap:anywhere 兜底；而 ToolResultText 的 JSON 分支把字段值渲染成
// 无自带兜底的 inline <span>。结果里一旦出现长无断点串（紧凑 JSON / base64 / 长 URL），
// 那一行就不换行、横铺出卡片右边界，被右侧面板裁掉。
//
// 本用例走真实链路：真实模型 → codemode → tools.bash 打印 600 个无空格字符，
// 展开子卡结果后断言子卡与其内部任意元素都不产生横向溢出。
import { test, expect } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { E2E_WA_PI_DIR } from "../playwright.config";
import { saveProvider } from "./helpers";

/** 运行时读 deepseek apiKey（仅测试运行期内存使用，不落盘）。 */
function readDeepseekKey(): string {
	const home = process.env.HOME || process.env.USERPROFILE || ".";
	try {
		const auth = JSON.parse(
			readFileSync(join(home, ".pi", "agent", "auth.json"), "utf8"),
		);
		const key = auth?.deepseek?.key;
		if (key) return key;
	} catch {}
	throw new Error(
		"未找到 deepseek apiKey（~/.pi/agent/auth.json 无 deepseek.key），无法执行 LLM E2E",
	);
}

// 真实模型偶发不按指令走 codemode（可能直接调 bash 工具）→ 允许一次重试（断言不放宽）
test.describe.configure({ retries: 1 });

test("codemode 嵌套子卡长结果不横向溢出", async ({ page }) => {
	test.setTimeout(300_000);

	// 长无断点的 JSON 返回体：紧凑 JSON 里是一个 600 字符无空格值。
	// 它会让 ToolResultText 走 **JSON 分支**（字段值渲染为无兜底的 inline span），
	// 而不是自带 break-words 的 pre 文本分支——这是用户截图里真正出问题的路径。
	const fixture = join(E2E_WA_PI_DIR, "tmp", "nested-longline.json");
	mkdirSync(join(E2E_WA_PI_DIR, "tmp"), { recursive: true });
	writeFileSync(fixture, JSON.stringify({ samples: "x".repeat(600) }));

	const apiKey = readDeepseekKey();
	await page.goto("/");
	await saveProvider({
		id: randomUUID(),
		name: "DeepSeek",
		baseUrl: "https://api.deepseek.com",
		apiKey,
		api: "openai-completions",
		models: [
			{ id: "deepseek-v4-flash", contextWindow: 1000000, maxTokens: 384000 },
		],
	});

	await expect(page.getByTestId("new-session-pane")).toBeVisible({
		timeout: 10_000,
	});
	await page
		.getByTestId("model-selector")
		.selectOption("deepseek/deepseek-v4-flash");

	// 指令化 prompt：必须走 codemode（不是 bash 工具），脚本内部 cat 出单行 JSON fixture
	await page.getByRole("textbox").fill(
		"严格按以下两步执行，不要省略也不要多做：\n" +
			"第一步：调用 codemode 工具（不要用 bash 工具），脚本内容恰好是下面两行（原样照抄）：\n" +
			`const r = await tools.bash({command: "cat '${fixture}'"});\n` +
			"return r;\n" +
			"第二步：只回复两个字：完成",
	);
	await page.getByTestId("composer-send").click();
	await expect(page.getByTestId("session-view")).toBeVisible({
		timeout: 10_000,
	});

	// 嵌套调用事件到达：子卡可见
	const nestedItem = page.locator('[data-testid^="toolcall-nested-item-"]').first();
	await expect(nestedItem).toBeVisible({ timeout: 180_000 });

	// 子卡结果默认折叠：点头部展开入口
	const toggle = page
		.locator('[data-testid^="toolcall-nested-result-toggle-"]')
		.first();
	await expect(toggle).toBeVisible({ timeout: 60_000 });
	await toggle.click();
	// 结果文本已渲染（前置断言：展开生效，否则下面的测量没有意义）
	await expect(nestedItem).toContainText("samples", { timeout: 10_000 });

	const m = await nestedItem.evaluate((el) => {
		const box = el.getBoundingClientRect();
		const overflows = [...el.querySelectorAll<HTMLElement>("*")]
			.map((c) => ({
				tag: c.tagName,
				cls: String(c.className).slice(0, 70),
				overflow: c.scrollWidth - c.clientWidth,
			}))
			.filter((x) => x.overflow > 1);
		return {
			clientW: el.clientWidth,
			scrollW: el.scrollWidth,
			right: Math.round(box.right),
			overflowWrap: getComputedStyle(el).overflowWrap,
			overflows: overflows.slice(0, 5),
		};
	});

	// 1) 子卡自身不得出现横向溢出
	expect(m.scrollW).toBeLessThanOrEqual(m.clientW + 1);
	// 2) 子卡内任何后代都不得横向溢出（长无断点串已按 anywhere 断行）
	expect(m.overflows).toEqual([]);
	// 3) 兜底确实挂在子卡根上（类被移除时这条会先失败，指向根因）
	expect(m.overflowWrap).toBe("anywhere");

	// 数据清理：会话/项目都在 E2E_WA_PI_DIR 隔离目录内，由 global-teardown 整体清除
});
