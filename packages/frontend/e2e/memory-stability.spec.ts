// 浏览器内存基线 E2E：回退 llm-ui 后，真实 Chromium 中应用加载 + 空闲观察，JS 堆内存应稳定。
//
// 背景：llm-ui 的 useLLMOutput rAF 循环 cleanup bug 曾在长流式渲染中把 AI 回复文本复制数万份
// （内存快照实测 744MB 字符串被 V8 Context/scope 持有）。回退到自实现渲染后根因已移除。
// 本测试不依赖 kernel 消息回声（测试环境无真实 LLM），只验证：真实浏览器中应用加载完成后，
// 空闲 6 秒内 JS 堆内存增量可控——若存在 rAF 循环泄漏，空闲期间内存会持续增长。
import { test, expect } from "@playwright/test";
import { saveProvider } from "./helpers";

test.describe.serial("浏览器内存基线", () => {
	test("应用加载后 JS 堆内存稳定（无 rAF 循环持续泄漏）", async ({ page }) => {
		test.setTimeout(90_000);

		// 打开页面，注入 provider 避免初始化向导
		await page.goto("/");
		await saveProvider({
			id: "e2e-mem-base",
			name: "E2E-MemBase",
			baseUrl: "http://localhost:9999/v1",
			apiKey: "sk-e2e",
			api: "openai-completions",
			models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
		});
		await page.goto("/");
		await expect(page.getByTestId("sidebar")).toBeVisible({ timeout: 15000 });

		// 等待应用完全空闲（React 初始渲染 + 事件绑定完成）
		await page.waitForTimeout(3000);

		const sample = () =>
			page.evaluate(() =>
				(performance as any).memory
					? (performance as any).memory.usedJSHeapSize / 1024 / 1024
					: 0,
			);

		const baseline = await sample();
		expect(baseline).toBeGreaterThan(0);

		// 空闲观察 6 秒：若存在 rAF 循环持续分配（llm-ui 式泄漏），内存会线性增长；
		// 无泄漏时 V8 自适应堆在 GC 后趋于平稳，增量很小。
		await page.waitForTimeout(6000);
		const after = await sample();

		const growth = after - baseline;
		// eslint-disable-next-line no-console
		console.log(
			`[memory] baseline=${baseline.toFixed(1)}MB after=${after.toFixed(1)}MB growth=${growth.toFixed(1)}MB`,
		);
		// 6 秒空闲增量 < 30MB（V8 堆自适应 + 基础开销）。llm-ui rAF 循环泄漏时
		// 每秒分配大量字符串副本，6 秒可增长数十 MB，此阈值足以区分。
		expect(growth).toBeLessThan(30);
	});
});
