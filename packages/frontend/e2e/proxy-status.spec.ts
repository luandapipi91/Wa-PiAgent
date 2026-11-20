// 代理不可达提示的真浏览器验证。
//
// 为什么必须有这一层：内核侧的「不回退 + 状态上报」和 store 单测都绿，
// 也不能证明用户真的看得见——事件名拼错、toast 被 3 秒自动收掉、挂载补拉没接上，
// 都只在真实页面里暴露。这里两条路径各自验证：
//   ① 事件路径：注入 proxy:status(unreachable) → 常驻 toast（超过默认 3s 仍在）→ ok 收掉
//   ② 补拉路径：路由桩把 /api/proxy/status 打成 unreachable → 页面挂载后直接弹提示
//      （启动瞬间的不可达事件发生在 SSE 建连之前，只能靠补拉，见 App.refreshProxyStatus）
import { test, expect, type Page } from "@playwright/test";

const UPSTREAM = "http://127.0.0.1:7890";
const REASON = "connect ECONNREFUSED 127.0.0.1:7890";

function emitProxyStatus(page: Page, state: "ok" | "unreachable", upstream = UPSTREAM) {
	return page.evaluate(
		({ state, upstream, reason }) => {
			const emit = (window as any).__PI_E2E_EVENT__;
			if (!emit) throw new Error("__PI_E2E_EVENT__ 未挂载（非 dev 环境？）");
			emit({
				type: "proxy:status",
				state,
				upstream,
				...(state === "unreachable" ? { reason } : {}),
			});
		},
		{ state, upstream, reason: REASON },
	);
}

test("事件路径：unreachable 弹常驻 toast，ok 后收起", async ({ page }) => {
	test.setTimeout(60_000);
	await page.goto("/");
	await page.waitForFunction(
		() => typeof (window as any).__PI_E2E_EVENT__ === "function",
		undefined,
		{ timeout: 20_000 },
	);

	await emitProxyStatus(page, "unreachable");

	const container = page.getByTestId("toast-container");
	await expect(container).toBeVisible({ timeout: 10_000 });
	await expect(container).toContainText("7890");

	// 常驻语义：默认 toast 3s 自动消失，这条必须还在
	await page.waitForTimeout(3500);
	await expect(container).toBeVisible();
	await expect(container).toContainText("7890");

	// 恢复 → 告警被收掉（会短暂出现「代理已恢复」）
	await emitProxyStatus(page, "ok");
	await expect(container).not.toContainText(REASON, { timeout: 5_000 });
	await expect(container).not.toContainText("7890", { timeout: 5_000 });
});

test("补拉路径：页面加载时 /api/proxy/status 已不可达 → 直接弹提示", async ({ page }) => {
	test.setTimeout(60_000);
	await page.route("**/api/proxy/status", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				status: { state: "unreachable", upstream: UPSTREAM, reason: REASON },
			}),
		}),
	);

	await page.goto("/");
	const container = page.getByTestId("toast-container");
	await expect(container).toContainText("7890", { timeout: 20_000 });
});
