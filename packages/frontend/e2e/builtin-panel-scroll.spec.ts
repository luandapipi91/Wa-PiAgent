// E2E 回归：内置 subagent 面板「只读」≠「不可滚动」
//
// 根因（bug）：面板内容区 config-tab-content 上挂了 pointer-events-none 来实现只读，
// 于是内部一切内容的鼠标命中都穿透到 Modal 的包装层（滚动容器的非后代元素），
// 滚轮事件永远到不了滚动容器 —— 技能/工具列表再长也滚不动，观感「整个面板像只读的」。
// 本用例断言：滚轮能把内容区滚起来，且只读语义不变（技能开关点击无效）。
import { test, expect } from "@playwright/test";
import { addSkillDir, ensureProvider, removeSkillDir } from "./helpers";

const PREFIX = "e2e-scroll-skill-";
const NAMES = Array.from({ length: 20 }, (_, i) => `${PREFIX}${i}`);

test.describe
	.serial("内置面板滚动（只读≠不可滚动）", () => {
		test.beforeAll(async () => {
			// 无 provider 时首启会弹 onboarding 向导，其 modal-overlay 会拦截点击
			await ensureProvider();
			for (const n of NAMES) await addSkillDir(n, `滚动回归技能 ${n}`);
		});

		test.afterAll(async () => {
			for (const n of NAMES) await removeSkillDir(n).catch(() => {});
		});

		test("技能 tab：滚轮可滚动内容区；技能开关仍只读", async ({ page }) => {
			test.setTimeout(120_000);
			await page.setViewportSize({ width: 1024, height: 600 });
			await page.goto("/", { timeout: 60_000 });

			// 内置 subagent 面板（只读）→ 技能 tab
			await page.getByTestId("agent-collapsed").click();
			await page.getByTestId("gallery-card-general-purpose").click();
			await expect(page.getByTestId("agent-config")).toBeVisible({
				timeout: 10_000,
			});
			await page.getByTestId("tab-skills").click();
			await expect(page.getByTestId(`skill-row-${NAMES[0]}`)).toBeVisible({
				timeout: 10_000,
			});

			const content = page.getByTestId("config-tab-content");
			// 前提：内容确实溢出（否则滚动断言无意义）
			const overflow = await content.evaluate(
				(el) => el.scrollHeight - el.clientHeight,
			);
			expect(overflow).toBeGreaterThan(20);

			const box = (await content.boundingBox())!;
			await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
			await page.mouse.wheel(0, 300);
			await expect
				.poll(() => content.evaluate((el) => el.scrollTop), { timeout: 5_000 })
				.toBeGreaterThan(0);

			// 只读语义不变：内置面板的技能开关点击不生效（不翻转 data-on）
			const sw = page.getByTestId(`skill-switch-${NAMES[0]}`);
			const on = await sw.getAttribute("data-on");
			await sw.click({ force: true, timeout: 3_000 }).catch(() => {});
			expect(await sw.getAttribute("data-on")).toBe(on);
		});
	});
