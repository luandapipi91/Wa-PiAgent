/**
 * 文件树拖拽文件到输入框：释放后经 wa-pi:insert-mention 派发的文本
 * 必须是文件 chip token `#[路径] `（输入框渲染绿色 chip-file 胶囊，
 * 发送时 expandTokens 展开为 #路径），而非旧的 `path:路径 ` 纯文本。
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
		const detail = dispatched[0]!.detail as { text: string };
		// 文件 chip token（value 带 path: 引用标记）：输入框渲染 .chip-file 胶囊，
		// 发送时 expandTokens 展开为 #path:/tmp/proj/a.ts
		expect(detail.text).toBe("#[path:/tmp/proj/a.ts] ");
	} finally {
		window.removeEventListener("wa-pi:insert-mention", onInsert);
		document.elementFromPoint = origFromPoint;
	}
});
