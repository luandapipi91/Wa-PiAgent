// 复制功能组件测试：FileViewer 文字「复制内容」/ 图片「复制图片」/ MediaPreviewModal 视频「复制路径」。
// util/clipboard 整模块 mock（含新增的 imageUrlToPngBlob），断言三个出口函数的调用参数。
import { test, expect, beforeEach, afterEach, mock } from "bun:test";

const writeTextMock = mock(async (_text: string) => {});
const copyImageMock = mock(async (_blob: Blob) => {});
const pngBlobMock = mock(async (_src: string) => new Blob(["png"], { type: "image/png" }));

mock.module("../../src/share-client", () => ({
	shareSettings: async () => ({ hasToken: true, channel: "edgeone" }),
	shareUpload: async () => ({}),
	saveShareSettings: async () => {},
}));

mock.module("../../src/util/clipboard", () => ({
	copyToClipboard: writeTextMock,
	copyImageToClipboard: copyImageMock,
	imageUrlToPngBlob: pngBlobMock,
}));

import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { FileViewer } from "../../src/components/blocks/FileViewer";
import { MediaPreviewModal } from "../../src/components/blocks/MediaPreviewModal";
import { _setFsTransport } from "../../src/fs-client";
import { makeFakeFsTransport } from "../fs-transport";
import { useSessionStore } from "../../src/store/session";
import { useToastStore } from "../../src/store/toast";

const fake = makeFakeFsTransport();

beforeEach(() => {
	_setFsTransport(fake.transport);
	fake.calls.length = 0;
	fake.sent.length = 0;
	fake.responses.clear();
	useToastStore.setState({ toasts: [] });
	useSessionStore.setState({ mediaPreview: null });
	writeTextMock.mockClear();
	copyImageMock.mockClear();
	pngBlobMock.mockClear();
});
afterEach(() => cleanup());

test("文字文件：工具栏「复制」按钮复制完整内容", async () => {
	fake.setResponse("fs:readFile", {
		content: btoa("hello full content"),
		mimeType: "text/plain",
	});
	render(<FileViewer path="/work/demo/a.ts" onClose={() => {}} />);
	await waitFor(() => screen.getByTestId("file-viewer"));
	fireEvent.click(screen.getByTestId("fv-copy-content"));
	await waitFor(() =>
		expect(writeTextMock).toHaveBeenCalledWith("hello full content"),
	);
});

test("markdown 文件：工具栏同样有「复制」按钮", async () => {
	// 注：happy-dom 的 btoa 仅支持 Latin1，用例内容用 ASCII（原 brief 的「# 标题」会抛 InvalidCharacterError）
	fake.setResponse("fs:readFile", {
		content: btoa("# Title"),
		mimeType: "text/markdown",
	});
	render(<FileViewer path="/work/demo/a.md" onClose={() => {}} />);
	await waitFor(() => screen.getByTestId("file-viewer"));
	fireEvent.click(screen.getByTestId("fv-copy-content"));
	await waitFor(() =>
		expect(writeTextMock).toHaveBeenCalledWith("# Title"),
	);
});

test("图片文件：工具栏「复制图片」走 canvas 转 PNG 后写剪贴板", async () => {
	const b64 = "iVBORw0KGgo=";
	fake.setResponse("fs:readFile", { content: b64, mimeType: "image/png" });
	render(<FileViewer path="/work/demo/logo.png" onClose={() => {}} />);
	await waitFor(() => screen.getByTestId("image-viewer"));
	fireEvent.click(screen.getByTestId("fv-copy-image"));
	await waitFor(() => expect(copyImageMock).toHaveBeenCalledTimes(1));
	// imageUrlToPngBlob 收到的是 data URI（FileViewer 图片分支的 imageSrc）
	expect(pngBlobMock).toHaveBeenCalledWith(`data:image/png;base64,${b64}`);
});

test("MediaPreviewModal 图片项：复制图片", async () => {
	useSessionStore
		.getState()
		.openMediaPreview(
			[{ src: "https://x.com/a.png", kind: "image", name: "a.png" }],
			0,
			"s1",
		);
	render(<MediaPreviewModal />);
	fireEvent.click(screen.getByTestId("media-copy"));
	await waitFor(() => expect(copyImageMock).toHaveBeenCalledTimes(1));
	expect(pngBlobMock).toHaveBeenCalledWith("https://x.com/a.png");
});

test("MediaPreviewModal 视频项：复制路径（本地路径解析为绝对路径）", async () => {
	useSessionStore
		.getState()
		.openMediaPreview(
			[{ src: "/home/me/proj/v.mp4", kind: "video", name: "v.mp4" }],
			0,
			"s1",
		);
	render(<MediaPreviewModal />);
	fireEvent.click(screen.getByTestId("media-copy"));
	await waitFor(() =>
		expect(writeTextMock).toHaveBeenCalledWith("/home/me/proj/v.mp4"),
	);
	expect(copyImageMock).not.toHaveBeenCalled();
});
