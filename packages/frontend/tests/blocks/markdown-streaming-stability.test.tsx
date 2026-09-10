// 流式渲染稳定性契约：text 增长（模拟流式 delta）时，已渲染的文件 chip / 图片
// 必须保持同一 DOM 节点。重挂载 = 图片重新解码白闪、视频重载黑闪、FilePill 反复
// 跑 statFile（chip→文本→chip 三态闪）——用户可见的「闪烁」即此机制。
// 根因背景：mdComponents 的 useMemo 依赖含 mediaItems（流式每帧新引用），
// 导致 createMarkdownComponents 每帧返回全新内联组件 → React 按 type 变化整树 remount。
import {
	describe,
	test,
	expect,
	beforeEach,
	beforeAll,
	afterAll,
} from "bun:test";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MarkdownBlock } from "../../src/components/MessageList";
import { collectMediaItems } from "../../src/components/blocks/media-utils";
import { _setFsTransport } from "../../src/fs-client";

// happy-dom 在 about:blank 下无法解析相对 URL（/file?path=...），img 插入时同步 fire
// error 导致本地图片直接降级 FilePill（MarkdownImage.test.tsx 同款处理）：
// 把页面 URL 临时设为 http://localhost/ 让相对 URL 可解析（不真实加载），跑完恢复。
beforeAll(() => (window as any).happyDOM?.setURL?.("http://localhost/"));
afterAll(() => (window as any).happyDOM?.setURL?.("about:blank"));

// FilePill 挂载即 statFile 探测；mock 成存在，让 chip 处于稳定态（不被回退成纯文本干扰）
beforeEach(() => {
	_setFsTransport({
		get: async () => ({}),
		post: async () => ({ exists: true }),
		del: async () => ({}),
	});
});

describe("MarkdownBlock 流式增长不重挂载", () => {
	test("text 增长时文件 chip 与图片卡片保持同一 DOM 节点", async () => {
		const t1 = "先看 `src/App.tsx`：\n\n![截图](C:/x/shot-a.png)";
		const t2 = `${t1}\n\n继续流式输出的后续段落。`;
		const t3 = `${t2} 追加更多文字。`;

		const { rerender, container } = render(
			<MarkdownBlock
				text={t1}
				sessionId="s1"
				mediaItems={collectMediaItems(t1)}
			/>,
		);
		// 等 FilePill 的 statFile 异步落定，进入稳定态再取基准节点
		await waitFor(() => expect(screen.getByTestId("file-pill")).toBeTruthy());
		const pill1 = container.querySelector('[data-testid="file-pill"]');
		const card1 = container.querySelector('[data-testid="md-image-card"]');
		expect(pill1).toBeTruthy();
		expect(card1).toBeTruthy();

		// 模拟流式：text 增长 + mediaItems 每帧新引用（与生产 TextContent 行为一致）
		rerender(
			<MarkdownBlock
				text={t2}
				sessionId="s1"
				mediaItems={collectMediaItems(t2)}
			/>,
		);
		rerender(
			<MarkdownBlock
				text={t3}
				sessionId="s1"
				mediaItems={collectMediaItems(t3)}
			/>,
		);

		const pill2 = container.querySelector('[data-testid="file-pill"]');
		const card2 = container.querySelector('[data-testid="md-image-card"]');
		// 同一 DOM 节点 = 未重挂载 = 不闪
		expect(pill2).toBe(pill1);
		expect(card2).toBe(card1);
		// 内容仍在（不是靠卸载重挂渲染出来的）
		expect(screen.getByTestId("file-pill")).toBeTruthy();
		expect(screen.getByTestId("md-image-card")).toBeTruthy();
	});

	// 用户报告：流式输出长代码时点「展开」无效——展开是 CodeBlockCard 本地 state，
	// 一旦每帧重挂载就重置回折叠。锁：展开后继续流式必须保持展开。
	const fenceOf = (n: number, closed = true) =>
		"```js\n" +
		Array.from({ length: n }, (_, i) => `const v${i} = ${i};`).join("\n") +
		(closed ? "\n```" : "");
	const shownLines = (container: HTMLElement) =>
		container.querySelectorAll("[data-testid='code-block-card'] pre > div")
			.length;

	test("闭合围栏：展开后流式增长不回折叠", () => {
		const { rerender, container } = render(
			<MarkdownBlock
				text={fenceOf(25)}
				sessionId="s1"
				mediaItems={collectMediaItems(fenceOf(25))}
			/>,
		);
		// 超 20 行默认折叠：只显示 20 行
		expect(shownLines(container)).toBe(20);
		fireEvent.click(screen.getByTestId("code-expand"));
		expect(shownLines(container)).toBe(25);

		// 流式继续：代码增长 + mediaItems 每帧新引用 → 不得重置回折叠
		rerender(
			<MarkdownBlock
				text={fenceOf(30)}
				sessionId="s1"
				mediaItems={collectMediaItems(fenceOf(30))}
			/>,
		);
		expect(shownLines(container)).toBe(30);
	});

	test("未闭合围栏（流式尾巴）：展开后增长同样保持展开", () => {
		const { rerender, container } = render(
			<MarkdownBlock
				text={fenceOf(25, false)}
				sessionId="s1"
				mediaItems={collectMediaItems(fenceOf(25, false))}
			/>,
		);
		expect(shownLines(container)).toBe(20);
		fireEvent.click(screen.getByTestId("code-expand"));
		expect(shownLines(container)).toBe(25);

		rerender(
			<MarkdownBlock
				text={fenceOf(28, false)}
				sessionId="s1"
				mediaItems={collectMediaItems(fenceOf(28, false))}
			/>,
		);
		expect(shownLines(container)).toBe(28);
	});
});
