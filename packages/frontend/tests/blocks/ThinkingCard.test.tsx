// ThinkingCard 流式节流与 memo 契约（卡顿修复终版，替代停顿降级）：
// 停顿降级（plain↔Linkify 交替）用户实测闪烁，改为流式中始终 Linkify、
// 经 useThrottledValue 节流（每帧 O(全文) 正则 split 降为低频）；memo 挡连坐。
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

test("流式中：始终 Linkify（不闪烁），裸 URL 可点击", () => {
	render(
		<ThinkingCard
			thinking="先看 http://localhost:53213/ 这个接口"
			isStreaming
			throttleMs={10_000}
		/>,
	);
	// 旧降级方案流式中无链接（红灯）；节流方案始终链接化
	const a = screen.getByTestId("thinking-panel-body").querySelector("a");
	expect(a?.getAttribute("href")).toBe("http://localhost:53213/");
});

test("流式中内容增长：节流——窗口内变化不立即重解析，窗口后追上", async () => {
	const t1 = "先想 http://localhost:53213/";
	const { rerender } = render(
		<ThinkingCard thinking={t1} isStreaming throttleMs={20} />,
	);
	// 窗口内（挂载后立刻）变化：DOM 保持旧内容
	const t2 = `${t1} 再想 http://localhost:53214/`;
	rerender(<ThinkingCard thinking={t2} isStreaming throttleMs={20} />);
	// 节流窗口内：新链接尚未出现
	expect(
		screen.getByTestId("thinking-panel-body").querySelector('[href="http://localhost:53214/"]'),
	).toBeNull();
	await act(async () => {
		await new Promise((r) => setTimeout(r, 60));
	});
	expect(
		screen.getByTestId("thinking-panel-body").querySelector('[href="http://localhost:53214/"]'),
	).toBeTruthy();
});

test("非流式（思考完成）：保持 Linkify 行为（点击展开后断言）", () => {
	render(
		<ThinkingCard thinking="先看 http://localhost:53213/ 这个接口" />,
	);
	// 整轮结束后卡片自动折叠（产品预期），点击头部展开后再断言内容
	fireEvent.click(screen.getByTestId("thinking-panel-header"));
	expect(
		screen.getByTestId("thinking-panel-body").querySelector("a"),
	).toBeTruthy();
});
