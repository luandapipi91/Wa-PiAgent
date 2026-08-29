/**
 * 文件树拖拽文件到输入框：释放后经 wa-pi:insert-mention 派发的文本
 * 必须与手输 # 面板选中插入的格式完全一致：`#[相对路径] `（相对 workspaceDir，
 * 无 path: 锚）。两链路同构保证发送后 expandTokens 展开产物一致（#path:相对路径），
 * 聊天窗/排队区 chip 还原行为一致；不再插入旧版 `#[path:绝对路径]`。
 *
 * 指针链模拟：pointerdown（节点）→ pointermove（>5px 触发拖拽态）→
 * pointerup（落点 elementFromPoint mock 到 contenteditable 编辑器）。
 */
import { test, expect, mock } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

mock.module("../src/fs-client", () => ({
	listDir: () => Promise.resolve([{ name: "a.ts", isDir: false }]),
	revealFile: () => Promise.resolve(),
	openFileWithDefaultApp: () => Promise.resolve(),
}));

import { ExplorerPanel } from "../src/components/ExplorerPanel";

test("拖拽文件树文件到输入框，派发 #[路径] chip token 而非 path: 纯文本", async () => {
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
		render(
			<ExplorerPanel
				workspaceDir="/tmp/proj"
				projectName="proj"
				onOpenFile={() => {}}
			/>,
		);

		// 等 listDir mock 数据渲染出文件节点
		const nodeEl = await screen.findByText("a.ts");

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
		// 与手输 # 面板选中插入格式完全一致：#[相对路径]（相对 workspaceDir，无 path: 锚），
		// 发送时 expandTokens 展开为 #path:相对路径，与手输链路产物同构
		expect(detail.text).toBe("#[a.ts] ");
		// 不携带 editor：ComposerInput 必须走受控 setText 路径——
		// execCommand 只改 DOM，受控同步后 text===DOM 不会重渲染，token 永远无法 chip 化
		expect(detail.editor).toBeUndefined();
	} finally {
		window.removeEventListener("wa-pi:insert-mention", onInsert);
		document.elementFromPoint = origFromPoint;
	}
});
