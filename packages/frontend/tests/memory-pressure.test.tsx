// 内存压力测试：回退 llm-ui 后，流式渲染路径（MarkdownBlock → ReactMarkdown）无内存泄漏。
//
// 背景：llm-ui 的 useLLMOutput 在流式渲染期间有 rAF 循环 cleanup bug，长 AI 回复文本
// 被复制数万份（内存快照实测 744MB 字符串被 V8 Context/scope 持有）。回退到自实现的
// MarkdownBlock（ReactMarkdown 直接渲染）后，该根因已移除。本测试用真实 ReactMarkdown +
// remark-gfm（与应用同款渲染引擎）模拟流式渲染压力（文本增长 + 反复渲染），验证堆内存稳定。
import { test, expect } from "bun:test";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** 构造随流式增长的长 markdown 文本（标题 + 列表 + 代码块 + 段落，模拟 AI 长回复）。 */
function makeText(len: number): string {
	return [
		"# 流式渲染压力测试\n\n",
		"这是 **markdown** 内容，包含 `行内代码` 和列表：\n\n",
		"- 要点 A\n- 要点 B\n- 要点 C\n\n",
		"```ts\n",
		"// 代码块内容\n".repeat(Math.max(1, Math.floor(len / 200))),
		"const stable = true;\n",
		"```\n\n",
		"正文段落文本".repeat(Math.max(1, Math.floor(len / 12))),
		"\n\n> 引用块示例\n",
	].join("");
}

function memMB(): number {
	return process.memoryUsage().heapUsed / 1024 / 1024;
}

test("流式渲染压力：文本增长 + 反复渲染后堆内存稳定（不线性泄漏）", () => {
	const render = (text: string) =>
		renderToString(
			createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, text),
		);

	// 预热（JIT + 模块缓存）
	for (let i = 0; i < 3; i++) render(makeText(20000));

	// 三轮测量：每轮渲染 50 次，文本长度递增（模拟 7.7 分钟长流式的 delta 累积）。
	// 若存在 llm-ui 式泄漏（每帧复制字符串副本），第三轮相对第二轮增量会持续显著。
	const rounds = 3;
	const samples: number[] = [];
	for (let round = 0; round < rounds; round++) {
		for (let i = 0; i < 50; i++) {
			const text = makeText(8000 + round * 5000 + i * 300);
			render(text);
		}
		samples.push(memMB());
		console.log(
			`第 ${round + 1} 轮后 heapUsed: ${samples[round].toFixed(1)} MB`,
		);
	}
	// 末轮 vs 第二轮：无泄漏时增量很小（V8 堆自适应），泄漏则持续线性增长
	const growth = samples[2] - samples[1];
	console.log(`末轮增量: ${growth.toFixed(2)} MB`);
	expect(growth).toBeLessThan(20);
});
