import { test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MediaPreviewModal } from "../../src/components/blocks/MediaPreviewModal";
import { useSessionStore } from "../../src/store/session";
import type { MediaItem } from "../../src/components/blocks/media-utils";

const ITEMS: MediaItem[] = [
	{ src: "https://x.com/a.png", kind: "image", name: "a.png" },
	{ src: "https://x.com/b.png", kind: "image", name: "b.png" },
	{ src: "/home/me/proj/v.mp4", kind: "video", name: "v.mp4" },
];

// happy-dom 在 about:blank 下无法解析相对 URL（/file?path=...），同 Task 5/6 测试处理：
// 临时把页面 URL 设为 http://localhost/。
beforeAll(() => (window as any).happyDOM?.setURL?.("http://localhost/"));
afterAll(() => (window as any).happyDOM?.setURL?.("about:blank"));

beforeEach(() => {
	useSessionStore.setState({ mediaPreview: null });
});
afterEach(() => cleanup());

test("无 mediaPreview 时渲染 null", () => {
	const { container } = render(<MediaPreviewModal />);
	expect(container.firstChild).toBeNull();
});

test("多图画廊：计数器 + 右箭头切换", () => {
	useSessionStore.getState().openMediaPreview(ITEMS, 0, "s1");
	render(<MediaPreviewModal />);
	expect(screen.getByTestId("media-counter").textContent).toBe("1 / 3");
	fireEvent.click(screen.getByTestId("media-next"));
	expect(screen.getByTestId("media-counter").textContent).toBe("2 / 3");
});

test("键盘 ←/→ 切换（循环）", () => {
	useSessionStore.getState().openMediaPreview(ITEMS, 0, "s1");
	render(<MediaPreviewModal />);
	fireEvent.keyDown(window, { key: "ArrowLeft" }); // 循环到最后一张
	expect(screen.getByTestId("media-counter").textContent).toBe("3 / 3");
	fireEvent.keyDown(window, { key: "ArrowRight" }); // 循环回第一张
	expect(screen.getByTestId("media-counter").textContent).toBe("1 / 3");
});

test("图片项渲染 ZoomableImage，切到视频项渲染 <video autoplay>", () => {
	useSessionStore.getState().openMediaPreview(ITEMS, 0, "s1");
	render(<MediaPreviewModal />);
	expect(screen.getByTestId("zoomable-image")).toBeTruthy();
	fireEvent.click(screen.getByTestId("media-next"));
	fireEvent.click(screen.getByTestId("media-next"));
	const video = screen.getByTestId("media-video");
	expect(video.hasAttribute("autoplay")).toBe(true);
	// 本地视频 src 走 /file
	expect(video.getAttribute("src")).toBe(
		"/file?path=" + encodeURIComponent("/home/me/proj/v.mp4"),
	);
});

test("底部缩略图条点击跳转", () => {
	useSessionStore.getState().openMediaPreview(ITEMS, 0, "s1");
	render(<MediaPreviewModal />);
	const thumbs = screen.getByTestId("media-thumbs").querySelectorAll("button");
	expect(thumbs.length).toBe(3);
	fireEvent.click(thumbs[2]);
	expect(screen.getByTestId("media-counter").textContent).toBe("3 / 3");
});

test("单媒体退化：隐藏箭头/缩略图条/计数器", () => {
	useSessionStore
		.getState()
		.openMediaPreview([ITEMS[0]], 0, "s1");
	render(<MediaPreviewModal />);
	expect(screen.queryByTestId("media-prev")).toBeNull();
	expect(screen.queryByTestId("media-next")).toBeNull();
	expect(screen.queryByTestId("media-thumbs")).toBeNull();
	expect(screen.queryByTestId("media-counter")).toBeNull();
	expect(screen.getByTestId("zoomable-image")).toBeTruthy();
});

test("ESC 关闭：弹窗消失且 store 清空", () => {
	useSessionStore.getState().openMediaPreview(ITEMS, 0, "s1");
	render(<MediaPreviewModal />);
	fireEvent.keyDown(window, { key: "Escape" });
	expect(screen.queryByTestId("media-preview-modal")).toBeNull();
	expect(useSessionStore.getState().mediaPreview).toBeNull();
});
