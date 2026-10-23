// 流式节流默认窗口契约：所有流式渲染入口（统一 hook + 三个消费方组件）的默认窗口
// 必须一致，当前为 20ms（2026-09-20 由 50ms 下调，流式内容跟手优先）。
// 默认参数散落在 5 处、最容易漏改，故用源码级断言把「统一且等于 20ms」钉住。
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FRONTEND_SRC = join(import.meta.dir, "..", "..", "src");

const DEFAULTS: Array<[string, RegExp]> = [
	["components/blocks/useThrottledValue.ts", /throttleMs = 20,/],
	["components/blocks/Markdown.tsx", /throttleMs = 20,/],
	["components/blocks/StreamingOutput.tsx", /throttleMs = 20,/],
	["components/blocks/ThinkingCard.tsx", /throttleMs = 20,/],
	["components/MessageList.tsx", /throttleMs = 20,/],
];

test("流式节流默认窗口：5 个入口统一为 20ms", () => {
	for (const [rel, pattern] of DEFAULTS) {
		const src = readFileSync(join(FRONTEND_SRC, rel), "utf8");
		expect(src, `${rel} 的默认节流窗口应为 20ms`).toMatch(pattern);
	}
});
