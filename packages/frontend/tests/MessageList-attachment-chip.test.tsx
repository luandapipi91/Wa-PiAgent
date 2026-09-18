// 用户消息附件 chip（「附件:文件名」）点击行为：
// 图片/视频 → 媒体画廊（MediaPreviewModal）；其余文件 → 文件预览（FilePreviewModal）。
// 两处 chip 来源同一条渲染路径：pi 落盘的 Attachments 尾段、乐观占位的本地附件引用。
import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MessageRow } from "../src/components/MessageList";
import { useSessionStore } from "../src/store/session";
import { useProjectsStore } from "../src/store/projects";

const SID = "s1";

// 消息行组件会走 api-client（复制/导出等），happy-dom 下相对 URL 会抛错：mock 掉
mock.module("../src/api-client", () => ({
	api: {
		get: () => Promise.resolve(null),
		post: () => Promise.resolve({}),
		put: () => Promise.resolve({}),
		del: () => Promise.resolve({}),
	},
}));

/** 最小用户消息行：正文 + 可选本地附件引用 */
function userRow(content: string, attachments?: any[]): any {
	return {
		main: {
			message: { role: "user", content, timestamp: 1 },
			attachments,
		},
		toolResults: new Map(),
	};
}

beforeEach(() => {
	useSessionStore.setState({
		filePreview: null,
		mediaPreview: null,
	} as any);
	useProjectsStore.setState({
		projects: [{ id: "p1", name: "demo", cwd: "/work/demo" } as any],
		sessions: [{ id: SID, projectId: "p1" } as any],
	} as any);
});

afterEach(() => cleanup());

test("点击附件尾段 chip（非图片）→ 打开文件预览", () => {
	render(
		<MessageRow
			row={userRow(
				"看下这个\n\nAttachments:\n[path:/tmp/uploads/pasted-text.txt]",
			)}
			sessionId={SID}
		/>,
	);
	const chip = document.querySelector(".chip-attachment") as HTMLElement;
	expect(chip).toBeTruthy();
	fireEvent.click(chip);
	const st = useSessionStore.getState() as any;
	expect(st.filePreview).toEqual({
		path: "/tmp/uploads/pasted-text.txt",
		sessionId: SID,
	});
	expect(st.mediaPreview).toBeNull();
});

test("点击图片附件 chip → 打开媒体画廊（单媒体，索引 0）", () => {
	render(
		<MessageRow
			row={userRow(
				"看下这个\n\nAttachments:\n[path:/tmp/uploads/shot.png]",
			)}
			sessionId={SID}
		/>,
	);
	const chip = document.querySelector(".chip-attachment") as HTMLElement;
	expect(chip).toBeTruthy();
	fireEvent.click(chip);
	const st = useSessionStore.getState() as any;
	expect(st.filePreview).toBeNull();
	expect(st.mediaPreview?.index).toBe(0);
	expect(st.mediaPreview?.sessionId).toBe(SID);
	expect(st.mediaPreview?.items).toEqual([
		{ src: "/tmp/uploads/shot.png", kind: "image", name: "shot.png" },
	]);
});

test("点击相对路径附件 chip → 按项目 cwd 解析为绝对路径再打开", () => {
	render(
		<MessageRow
			row={userRow("内容\n\nAttachments:\n[path:uploads/plan.pptx]")}
			sessionId={SID}
		/>,
	);
	fireEvent.click(document.querySelector(".chip-attachment") as HTMLElement);
	const st = useSessionStore.getState() as any;
	expect(st.filePreview).toEqual({
		path: "/work/demo/uploads/plan.pptx",
		sessionId: SID,
	});
});

test("乐观占位消息的本地附件引用 chip 同样可点击打开", () => {
	render(
		<MessageRow
			row={userRow("看下这个", [
				{
					kind: "file",
					name: "plan.pptx",
					path: "/tmp/uploads/plan.pptx",
					size: 0,
				},
			])}
			sessionId={SID}
		/>,
	);
	fireEvent.click(document.querySelector(".chip-attachment") as HTMLElement);
	const st = useSessionStore.getState() as any;
	expect(st.filePreview).toEqual({
		path: "/tmp/uploads/plan.pptx",
		sessionId: SID,
	});
});

test("点击气泡内正文文字（非 chip）不触发任何预览", () => {
	render(
		<MessageRow
			row={userRow("看下这个\n\nAttachments:\n[path:/tmp/uploads/a.txt]")}
			sessionId={SID}
		/>,
	);
	const bubble = screen.getByTestId("msg-s1-1");
	fireEvent.click(bubble);
	const st = useSessionStore.getState() as any;
	expect(st.filePreview).toBeNull();
	expect(st.mediaPreview).toBeNull();
});
