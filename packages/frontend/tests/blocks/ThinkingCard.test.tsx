// ThinkingCard 流式降级与 memo 契约（卡顿修复）：
// 根因——thinking 往往是回复中最长的部分，流式中每个 delta 都让卡片重渲染，
// Linkify 对全文跑 URL 正则 split 并重建 ReactNode 列表（每帧 O(全文)），且组件
// 未 memo，同消息内其他块更新也连坐重渲染。
// 修复——①流式中未停顿跳过 Linkify（纯文本），停顿 500ms 或结束后恢复链接化；
// ②memo 化，props 不变时整块跳过。
import { test, expect, beforeEach } from "bun:test";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { ThinkingCard } from "../../src/components/blocks/ThinkingCard";
import { useUiPrefsStore } from "../../src/store/ui-prefs";

// 内容区折叠时不渲染（thinking-panel-body 不存在），先关默认折叠让 body 进 DOM
beforeEach(() => {
	useUiPrefsStore.setState({ collapseProcessByDefault: false });
});

test("ThinkingCard 是 memo 组件（props 不变时整块跳过重渲染）", () => {
	expect((ThinkingCard as any).$$typeof).toBe(Symbol.for("react.memo"));
});

test("流式中未停顿：纯文本渲染，Linkify 不跑（无 <a>）", () => {
	render(
		<ThinkingCard
			thinking="先看 http://localhost:53213/ 这个接口"
			isStreaming
			idleMs={10_000}
		/>,
	);
	const panel = screen.getByTestId("thinking-panel-body");
	expect(panel.querySelector("a")).toBeNull();
	expect(panel.textContent).toContain("http://localhost:53213/");
});

test("流式中停顿 idleMs 后：Linkify 恢复，裸 URL 变链接", async () => {
	render(
		<ThinkingCard
			thinking="先看 http://localhost:53213/ 这个接口"
			isStreaming
			idleMs={20}
		/>,
	);
	expect(screen.getByTestId("thinking-panel-body").querySelector("a")).toBeNull();
	await act(async () => {
		await new Promise((r) => setTimeout(r, 60));
	});
	const a = screen.getByTestId("thinking-panel-body").querySelector("a");
	expect(a?.getAttribute("href")).toBe("http://localhost:53213/");
});

test("非流式（思考完成）：保持原有 Linkify 行为", () => {
	render(
		<ThinkingCard thinking="先看 http://localhost:53213/ 这个接口" />, 
	);
	// 整轮结束后卡片自动折叠（产品预期），点击头部展开后再断言内容
	fireEvent.click(screen.getByTestId("thinking-panel-header"));
	expect(
		screen.getByTestId("thinking-panel-body").querySelector("a"),
	).toBeTruthy();
});
