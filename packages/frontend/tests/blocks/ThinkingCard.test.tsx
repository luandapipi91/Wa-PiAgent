// ThinkingCard 流式节流与 memo 契约：
// 思考过程正文与聊天正文一致走 Markdown 渲染（此前是纯文本 + Linkify，导致 `**粗体**`、
// 反引号代码原样显示）；解析节流由 Markdown 的 streaming/throttleMs 承担，memo 挡连坐。
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

test("非流式：思考过程的 Markdown 被渲染（加粗 / 行内代码 / 列表不再是原始标记）", () => {
	render(
		<ThinkingCard thinking={"**关键矛盾**：`root/inst/vnode` 都是 true\n\n- 第一点\n- 第二点"} />,
	);
	// 整轮结束后卡片自动折叠（产品预期），点击头部展开后再断言内容
	fireEvent.click(screen.getByTestId("thinking-panel-header"));
	const body = screen.getByTestId("thinking-panel-body");
	expect(body.querySelector("strong")?.textContent).toBe("关键矛盾");
	expect(body.querySelector("code")?.textContent).toBe("root/inst/vnode");
	expect(body.querySelectorAll("li")).toHaveLength(2);
	// 原始标记不得泄漏到可见文本
	expect(body.textContent).not.toContain("**");
	expect(body.textContent).not.toContain("`");
});

test("单换行保留为软换行（同一段落内的 <br>），不靠容器 pre-wrap 撑出空行", () => {
	render(<ThinkingCard thinking={"第一行\n第二行"} />);
	fireEvent.click(screen.getByTestId("thinking-panel-header"));
	const body = screen.getByTestId("thinking-panel-body");
	// 单换行不属于分段：仍是一个段落
	expect(body.querySelectorAll("p")).toHaveLength(1);
	// 但换行本身要保留（模型思考常一行一个短句）
	expect(body.querySelector("br")).toBeTruthy();
});

test("loose list：不使用容器级 pre-wrap（否则 react-markdown 插入的换行文本会占整行，圆点与正文分离）", () => {
	render(<ThinkingCard thinking={"说明：\n\n- 原因一\n\n- 原因二"} />);
	fireEvent.click(screen.getByTestId("thinking-panel-header"));
	const body = screen.getByTestId("thinking-panel-body");
	const md = body.querySelector(".md-body") as HTMLElement | null;
	expect(md).toBeTruthy();
	// 换行已由 remark 软换行插件转成 <br>，容器不需要（也不能）再 pre-wrap
	expect(md!.className).not.toContain("whitespace-pre-wrap");
	// loose list 仍正常成段（每项一个 p）
	expect(body.querySelectorAll("li > p")).toHaveLength(2);
});

test("流式中：Markdown 同样生效，且裸 URL 可点击", () => {
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

test("非流式（思考完成）：裸 URL 保持可点击（点击展开后断言）", () => {
	render(
		<ThinkingCard thinking="先看 http://localhost:53213/ 这个接口" />,
	);
	// 整轮结束后卡片自动折叠（产品预期），点击头部展开后再断言内容
	fireEvent.click(screen.getByTestId("thinking-panel-header"));
	expect(
		screen.getByTestId("thinking-panel-body").querySelector("a"),
	).toBeTruthy();
});
