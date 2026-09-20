import { test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
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
	// 位置记录跨用例残留会让下一个用例的弹窗叠在旧位置上，逐例清干净
	localStorage.clear();
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

// 图片预览窗位置拖动：按住标题栏（文件名行）移动窗口，位置持久化，关闭重开保持。
test("拖标题栏移动窗口：位置持久化，关闭重开保持上次位置", () => {
	localStorage.removeItem("hiagent.mediaPreview.pos");
	useSessionStore.getState().openMediaPreview(ITEMS, 0, "s1");
	const { unmount } = render(<MediaPreviewModal />);
	const card = screen.getByTestId("media-preview-modal") as HTMLElement;
	card.getBoundingClientRect = () =>
		({ left: 60, top: 40, width: 500, height: 400 }) as DOMRect;
	// Modal 走 createPortal 渲染到 body，查询用 document
	const handle = document.querySelector(
		"[data-modal-drag-handle]",
	) as HTMLElement;
	expect(handle).toBeTruthy(); // 头部行必须标出拖动把手
	fireEvent.mouseDown(handle, { clientX: 100, clientY: 60 });
	fireEvent.mouseMove(window, { clientX: 160, clientY: 100 });
	expect(card.style.left).toBe("120px");
	expect(card.style.top).toBe("80px");
	fireEvent.mouseUp(window);
	expect(JSON.parse(localStorage.getItem("hiagent.mediaPreview.pos")!)).toEqual({
		left: 120,
		top: 80,
	});

	unmount();
	render(<MediaPreviewModal />);
	const card2 = screen.getByTestId("media-preview-modal") as HTMLElement;
	expect(card2.style.position).toBe("fixed");
	expect(card2.style.left).toBe("120px");
	expect(card2.style.top).toBe("80px");
});

test("头部按钮（复制/关闭）点击不受拖动影响", () => {
	useSessionStore.getState().openMediaPreview(ITEMS, 0, "s1");
	render(<MediaPreviewModal />);
	const card = screen.getByTestId("media-preview-modal") as HTMLElement;
	card.getBoundingClientRect = () =>
		({ left: 60, top: 40, width: 500, height: 400 }) as DOMRect;
	// 在关闭按钮上按下并移动：不应把窗口拖走，按钮自身点击仍生效
	fireEvent.mouseDown(screen.getByTestId("media-copy"), {
		clientX: 100,
		clientY: 60,
	});
	fireEvent.mouseMove(window, { clientX: 200, clientY: 160 });
	expect(card.style.left).toBe("");
	expect(card.style.position).toBe("relative");
	fireEvent.mouseUp(window);
});

// 真实使用路径：MediaPreviewModal 常驻挂载在 App 根（App.tsx:771），关闭只是 return null。
// 位置必须在每次打开时重新读取，否则用户拖过位置后关闭重开会回到居中。
test("常驻挂载（不重挂组件）：关闭重开保持上次位置", async () => {
	localStorage.clear();
	render(<MediaPreviewModal />);
	useSessionStore.getState().openMediaPreview(ITEMS, 0, "s1");
	await waitFor(() =>
		expect(screen.getByTestId("media-preview-modal")).toBeTruthy(),
	);
	const card = screen.getByTestId("media-preview-modal") as HTMLElement;
	card.getBoundingClientRect = () =>
		({ left: 60, top: 40, width: 500, height: 400 }) as DOMRect;
	const handle = document.querySelector(
		"[data-modal-drag-handle]",
	) as HTMLElement;
	fireEvent.mouseDown(handle, { clientX: 100, clientY: 60 });
	fireEvent.mouseMove(window, { clientX: 160, clientY: 100 });
	fireEvent.mouseUp(window);
	expect(card.style.left).toBe("120px");

	// 关闭（组件仍在树上，只是 return null）→ 重开
	useSessionStore.getState().closeMediaPreview();
	await waitFor(() =>
		expect(screen.queryByTestId("media-preview-modal")).toBeNull(),
	);
	useSessionStore.getState().openMediaPreview(ITEMS, 0, "s1");
	await waitFor(() =>
		expect(screen.getByTestId("media-preview-modal")).toBeTruthy(),
	);
	const reopened = screen.getByTestId("media-preview-modal") as HTMLElement;
	expect(reopened.style.left).toBe("120px");
	expect(reopened.style.top).toBe("80px");
});

// 图片预览窗尺寸调整：拖右下角手柄改大小，尺寸持久化，常驻挂载下关闭重开保持。
test("常驻挂载：拖手柄改大小，关闭重开保持尺寸（与位置同）", async () => {
	localStorage.clear();
	render(<MediaPreviewModal />);
	useSessionStore.getState().openMediaPreview(ITEMS, 0, "s1");
	await waitFor(() =>
		expect(screen.getByTestId("media-preview-modal")).toBeTruthy(),
	);
	const card = screen.getByTestId("media-preview-modal") as HTMLElement;
	card.getBoundingClientRect = () =>
		({ left: 60, top: 40, width: 500, height: 400 }) as DOMRect;
	const resizeHandle = screen.getByTestId("modal-resize-handle");
	fireEvent.mouseDown(resizeHandle, { clientX: 560, clientY: 440 });
	fireEvent.mouseMove(window, { clientX: 660, clientY: 540 });
	fireEvent.mouseUp(window);
	expect(card.style.width).toBe("600px");
	expect(card.style.height).toBe("500px");

	// 关闭（组件仍在树上，只是 return null）→ 重开
	useSessionStore.getState().closeMediaPreview();
	await waitFor(() =>
		expect(screen.queryByTestId("media-preview-modal")).toBeNull(),
	);
	useSessionStore.getState().openMediaPreview(ITEMS, 0, "s1");
	await waitFor(() =>
		expect(screen.getByTestId("media-preview-modal")).toBeTruthy(),
	);
	const reopened = screen.getByTestId("media-preview-modal") as HTMLElement;
	expect(reopened.style.width).toBe("600px");
	expect(reopened.style.height).toBe("500px");
});
