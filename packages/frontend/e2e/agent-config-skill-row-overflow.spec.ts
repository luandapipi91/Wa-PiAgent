// E2E 回归：技能 tab 的技能行不得横向溢出
//
// 背景（bug）：超长技能描述原先渲染在 inline <span> 上并带 truncate ——
// overflow / text-overflow 对 non-replaced inline 元素不生效，描述按 white-space:nowrap
// 全宽铺开；这些溢出内容被计入 config-tab-content（overflow-y-auto → 隐式 overflow-x:auto）
// 的可滚动溢出区，于是弹窗底部出现横向滚动条，文字穿出右侧被裁。
// 本用例断言：内容区无横向滚动、技能行不超出内容区、超长描述确实被截断（块容器 + 省略号生效）。
import { test, expect } from "@playwright/test";
import { addSkillDir, ensureProvider, removeSkillDir } from "./helpers";

const SKILL = "e2e-skill-overflow";
// 足够长的单行描述：远宽于 80vw 弹窗内的描述可用宽度
const DESC = `超长描述溢出回归 ${"内容重复填充".repeat(60)} 结尾标记`;

test.describe
	.serial("技能行横向溢出回归", () => {
		test.beforeAll(async () => {
			// 无 provider 时首启会弹 onboarding 向导，其 modal-overlay 会拦截点击
			await ensureProvider();
			await addSkillDir(SKILL, DESC);
		});

		test.afterAll(async () => {
			await removeSkillDir(SKILL).catch(() => {});
		});

		test("技能 tab：内容区无横向滚动，超长描述被截断且不超出弹窗", async ({
			page,
		}) => {
			test.setTimeout(120_000);
			await page.goto("/", { timeout: 60_000 });

			// 内置 subagent 面板 → 技能 tab
			await page.getByTestId("agent-collapsed").click();
			await page.getByTestId("gallery-card-general-purpose").click();
			await expect(page.getByTestId("agent-config")).toBeVisible({
				timeout: 10_000,
			});
			await page.getByTestId("tab-skills").click();
			await expect(page.getByTestId(`skill-row-${SKILL}`)).toBeVisible({
				timeout: 10_000,
			});

			const m = await page.getByTestId("config-tab-content").evaluate((c) => {
				const content = c as HTMLElement;
				const contentRect = content.getBoundingClientRect();
				const rows = [...content.querySelectorAll<HTMLElement>(
					'[data-testid^="skill-row-"]',
				)];
				const desc = content.querySelector<HTMLElement>(
					'[data-testid^="skill-desc-"]',
				);
				return {
					contentClientW: content.clientWidth,
					contentScrollW: content.scrollWidth,
					contentRight: contentRect.right,
					maxRowRight: Math.max(
						...rows.map((r) => r.getBoundingClientRect().right),
					),
					rowCount: rows.length,
					desc: desc
						? {
								display: getComputedStyle(desc).display,
								clientW: desc.clientWidth,
								scrollW: desc.scrollWidth,
								right: desc.getBoundingClientRect().right,
								textOverflow: getComputedStyle(desc).textOverflow,
							}
						: null,
				};
			});

			// 1) 内容区不得出现横向滚动（overflow-y-auto 隐式 overflow-x:auto 会暴露横向滚动条）
			expect(m.contentScrollW).toBeLessThanOrEqual(m.contentClientW + 1);
			// 2) 技能行不得超出内容区右边界（视觉溢出）
			expect(m.rowCount).toBeGreaterThan(0);
			expect(m.maxRowRight).toBeLessThanOrEqual(m.contentRight + 1);
			// 3) 超长描述必须被截断：描述元素得是块容器（inline 上 overflow/text-overflow 不生效），
			//    且内容宽 > 可见宽 —— 省略号才会出现
			expect(m.desc).not.toBeNull();
			expect(m.desc?.display).not.toBe("inline");
			expect(m.desc?.textOverflow).toBe("ellipsis");
			expect(m.desc?.scrollW).toBeGreaterThan(m.desc?.clientW ?? 0);
			expect(m.desc?.right).toBeLessThanOrEqual(m.contentRight + 1);
		});
	});
