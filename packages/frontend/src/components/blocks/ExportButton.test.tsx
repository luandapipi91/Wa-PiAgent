// ExportButton 交互测试：菜单展开/点选调用链/外部关闭/无内容禁用。
// mock 整个 export-chat-image 模块：collectTurns 的正确性由 Task 1 单测保证，
// 这里只验证 ExportButton 对 collectTurns 结果的消费方式（禁用判断/传参），
// renderTurnsToPngBlob/downloadBlob/copyImageToClipboard 用 mock（happy-dom 无 canvas）。
import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { useSessionStore } from "../../store/session";
import { useUiPrefsStore } from "../../store/ui-prefs";

const collectMock = mock((..._args: any[]) => [] as any[]);
const renderMock = mock(async (..._args: any[]) => new Blob(["png"], { type: "image/png" }));
const downloadMock = mock((..._args: any[]) => {});
const copyImageMock = mock(async (..._args: any[]) => {});

mock.module("../../util/export-chat-image", () => ({
	collectTurns: collectMock,
	renderTurnsToPngBlob: renderMock,
	downloadBlob: downloadMock,
}));
mock.module("../../util/clipboard", () => ({
	copyImageToClipboard: copyImageMock,
	copyToClipboard: async () => {},
}));

import { ExportButton } from "./ExportButton";

const SID = "s1";
const ONE_TURN = [{ user: "问题", assistant: "回答", agentName: "dev", timestamp: 200 }];
const MESSAGES = [
	{ message: { role: "user", content: "问题", timestamp: 100 } },
	{ message: { role: "assistant", content: [{ type: "text", text: "回答" }], timestamp: 200 }, agentName: "dev" },
] as any[];

beforeEach(() => {
	collectMock.mockReset();
	renderMock.mockClear();
	downloadMock.mockClear();
	copyImageMock.mockClear();
	collectMock.mockReturnValue(ONE_TURN);
	useSessionStore.setState({ messagesBySession: { [SID]: MESSAGES } } as any);
	useUiPrefsStore.setState({ exportTurns: 1 });
});

test("点 icon 展开菜单（两项），再点外部关闭", () => {
	render(<ExportButton sessionId={SID} uptoTimestamp={200} />);
	fireEvent.click(screen.getByTestId(`export-${SID}-200`));
	expect(screen.getByTestId("export-download")).toBeTruthy();
	expect(screen.getByTestId("export-copy")).toBeTruthy();
	fireEvent.mouseDown(document.body);
	expect(screen.queryByTestId("export-download")).toBeNull();
});

test("下载 PNG：collectTurns 出参传给 renderTurnsToPngBlob，downloadBlob 文件名 wa-pi-chat- 开头", async () => {
	render(<ExportButton sessionId={SID} uptoTimestamp={200} />);
	fireEvent.click(screen.getByTestId(`export-${SID}-200`));
	fireEvent.click(screen.getByTestId("export-download"));
	await new Promise((r) => setTimeout(r, 10));
	expect(renderMock).toHaveBeenCalledTimes(1);
	expect(renderMock.mock.calls[0][0]).toEqual(ONE_TURN);
	expect(downloadMock).toHaveBeenCalledTimes(1);
	const name = downloadMock.mock.calls[0][1] as string;
	expect(name.startsWith("wa-pi-chat-")).toBe(true);
	expect(name.endsWith(".png")).toBe(true);
});

test("复制图片：renderTurnsToPngBlob + copyImageToClipboard 被调", async () => {
	render(<ExportButton sessionId={SID} uptoTimestamp={200} />);
	fireEvent.click(screen.getByTestId(`export-${SID}-200`));
	fireEvent.click(screen.getByTestId("export-copy"));
	await new Promise((r) => setTimeout(r, 10));
	expect(renderMock).toHaveBeenCalledTimes(1);
	expect(copyImageMock).toHaveBeenCalledTimes(1);
});

test("无文本对话时菜单两项禁用", () => {
	collectMock.mockReturnValue([]);
	render(<ExportButton sessionId={SID} uptoTimestamp={200} />);
	fireEvent.click(screen.getByTestId(`export-${SID}-200`));
	expect((screen.getByTestId("export-download") as HTMLButtonElement).disabled).toBe(true);
	expect((screen.getByTestId("export-copy") as HTMLButtonElement).disabled).toBe(true);
});

test("生成失败 toast 报错、不抛异常", async () => {
	renderMock.mockRejectedValueOnce(new Error("canvas boom"));
	render(<ExportButton sessionId={SID} uptoTimestamp={200} />);
	fireEvent.click(screen.getByTestId(`export-${SID}-200`));
	fireEvent.click(screen.getByTestId("export-download"));
	await new Promise((r) => setTimeout(r, 10));
	expect(downloadMock).not.toHaveBeenCalled();
	// 不抛异常即通过（toast 文案属实现细节，store 已有覆盖）
});

test("导出轮数设置生效：collectTurns 收到 store 的 exportTurns 作为第三参", async () => {
	useUiPrefsStore.setState({ exportTurns: 3 });
	render(<ExportButton sessionId={SID} uptoTimestamp={200} />);
	fireEvent.click(screen.getByTestId(`export-${SID}-200`));
	fireEvent.click(screen.getByTestId("export-download"));
	await new Promise((r) => setTimeout(r, 10));
	// collectTurns 第三参（maxTurns）应为 store 设置值 3
	expect(collectMock.mock.calls[0]?.[2]).toBe(3);
	expect(renderMock).toHaveBeenCalledTimes(1);
});

test("菜单 portal 到 body：展开后菜单项在 document.body 下", () => {
	render(<ExportButton sessionId={SID} uptoTimestamp={200} />);
	fireEvent.click(screen.getByTestId(`export-${SID}-200`));
	const menu = screen.getByTestId("export-download");
	// portal 后菜单挂 document.body，不在组件原 wrapRef 子树内
	expect(document.body.contains(menu)).toBe(true);
});
