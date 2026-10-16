/**
 * 文件树拖拽文件/文件夹到输入框：释放后经 wa-pi:insert-mention 派发的文本
 * 必须是**绝对路径**形态 `#[绝对路径] `（文件与文件夹一视同仁）。
 *
 * 与手输 # 面板插入的相对路径解耦：绝对路径不依赖会话 cwd 即可解析，
 * 发送后 expandTokens 展开为 `#path:绝对路径`，聊天窗/排队区 chip 还原一致。
 *
 * 指针链模拟：pointerdown（节点）→ pointermove（>5px 触发拖拽态）→
 * pointerup（落点 elementFromPoint mock 到 contenteditable 编辑器）。
 */
import { test, expect, mock, afterEach } from "bun:test";
import type { ReactElement } from "react";
import {
	render,
	screen,
	fireEvent,
	waitFor,
	cleanup,
} from "@testing-library/react";
import { VirtuosoMockContext } from "react-virtuoso";

// 虚拟化列表在 happy-dom 无布局：用 VirtuosoMockContext 提供视口测量值才渲染行
function renderExplorer(ui: ReactElement) {
	return render(
		<VirtuosoMockContext.Provider
			value={{ viewportHeight: 600, itemHeight: 24 }}
		>
			{ui}
		</VirtuosoMockContext.Provider>,
	);
}

mock.module("../src/fs-client", () => ({
	listDir: () =>
		Promise.resolve([
			{ name: "sub", isDir: true },
			{ name: "a.ts", isDir: false },
		]),
	revealFile: () => Promise.resolve(),
	openFileWithDefaultApp: () => Promise.resolve(),
}));

import { ExplorerPanel } from "../src/components/ExplorerPanel";

afterEach(cleanup);

/** 模拟把文件树中的一行拖到输入框编辑器，返回派发出的 mention 文本 */
async function dragRowToEditor(label: string): Promise<string> {
	// happy-dom 可能未实现指针捕获，桩掉即可（行为断言不依赖它）
	const proto = HTMLElement.prototype as any;
	if (typeof proto.setPointerCapture !== "function") {
		proto.setPointerCapture = () => {};
		proto.releasePointerCapture = () => {};
	}

	// 落点命中 contenteditable 编辑器（closest 匹配自身）
	const editor = document.createElement("div");
	editor.setAttribute("contenteditable", "true");
	const origFromPoint = document.elementFromPoint;
	document.elementFromPoint = () => editor;

	const dispatched: Array<CustomEvent> = [];
	const onInsert = (e: Event) => dispatched.push(e as CustomEvent);
	window.addEventListener("wa-pi:insert-mention", onInsert);

	try {
		renderExplorer(
			<ExplorerPanel
				workspaceDir="/tmp/proj"
				projectName="proj"
				onOpenFile={() => {}}
			/>,
		);

		// 等 listDir mock 数据渲染出节点
		const nodeEl = await screen.findByText(label);

		fireEvent.pointerDown(nodeEl, {
			button: 0,
			pointerId: 1,
			clientX: 10,
			clientY: 10,
		});
		// 位移超 5px 进入拖拽态（创建 ghost）
		fireEvent.pointerMove(nodeEl, { pointerId: 1, clientX: 60, clientY: 60 });
		fireEvent.pointerUp(nodeEl, { pointerId: 1, clientX: 60, clientY: 60 });

		await waitFor(() => expect(dispatched.length).toBe(1));
		const detail = dispatched[0]!.detail as {
			text: string;
			editor?: HTMLElement;
		};
		// 不携带 editor：ComposerInput 必须走受控 setText 路径——
		// execCommand 只改 DOM，受控同步后 text===DOM 不会重渲染，token 永远无法 chip 化
		expect(detail.editor).toBeUndefined();
		return detail.text;
	} finally {
		window.removeEventListener("wa-pi:insert-mention", onInsert);
		document.elementFromPoint = origFromPoint;
	}
}

test("拖拽文件树文件到输入框，派发绝对路径 chip token", async () => {
	expect(await dragRowToEditor("a.ts")).toBe("#[/tmp/proj/a.ts] ");
});

test("拖拽文件树文件夹到输入框，同样派发绝对路径 chip token", async () => {
	expect(await dragRowToEditor("sub")).toBe("#[/tmp/proj/sub] ");
});
