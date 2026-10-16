import { test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MediaPreviewModal } from "../../src/components/blocks/MediaPreviewModal";
import { useSessionStore } from "../../src/store/session";
import { useProjectsStore } from "../../src/store/projects";
import { _clearFsQueryCache, _setFsTransport } from "../../src/fs-client";
import { makeFakeFsTransport } from "../fs-transport";
import type { MediaItem } from "../../src/components/blocks/media-utils";

const ITEMS: MediaItem[] = [
	{ src: "https://x.com/a.png", kind: "image", name: "a.png" },
	{ src: "https://x.com/b.png", kind: "image", name: "b.png" },
	{ src: "/home/me/proj/v.mp4", kind: "video", name: "v.mp4" },
];

// 同目录画廊：项目工作区 /work/demo 下的媒体（图片 + 视频），文件名自然序（shot-2 在 shot-10 前）
const DIR = "/work/demo";
const DIR_ENTRIES = [
	{ name: "shot-a.png", isDir: false },
	{ name: "shot-10.png", isDir: false },
	{ name: "clip.mp4", isDir: false },
	{ name: "shot-2.png", isDir: false },
	{ name: "sub", isDir: true },
	{ name: "notes.txt", isDir: false },
];

const fake = makeFakeFsTransport((evt) => {
	if (evt.type === "fs:listDir") {
		const path = (evt as { path?: string }).path ?? "";
		const dirs: Record<string, { name: string; isDir: boolean }[]> = {
			[DIR]: DIR_ENTRIES,
			[`${DIR}/solo`]: [{ name: "only.png", isDir: false }],
			[`${DIR}/empty`]: [{ name: "notes.txt", isDir: false }],
		};
		return { entries: dirs[path] ?? [] };
	}
	return undefined;
});

// happy-dom 在 about:blank 下无法解析相对 URL（/file?path=...），同 Task 5/6 测试处理：
// 临时把页面 URL 设为 http://localhost/。
beforeAll(() => (window as any).happyDOM?.setURL?.("http://localhost/"));
afterAll(() => (window as any).happyDOM?.setURL?.("about:blank"));

beforeEach(() => {
	useSessionStore.setState({ mediaPreview: null });
	// 位置记录跨用例残留会让下一个用例的弹窗叠在旧位置上，逐例清干净
	localStorage.clear();
	useProjectsStore.setState({
		projects: [{ id: "p1", name: "demo", cwd: DIR } as any],
		sessions: [{ id: "s1", projectId: "p1" } as any],
	});
	_setFsTransport(fake.transport);
	_clearFsQueryCache();
	fake.calls.length = 0;
	fake.sent.length = 0;
});
afterEach(() => {
	cleanup();
	_setFsTransport(null);
});

test("无 mediaPreview 时渲染 null", () => {
	const { container } = render(<MediaPreviewModal />);
	expect(container.firstChild).toBeNull();
});

// ─── 同目录画廊（打开后按当前文件所在目录重建 items） ───

test("同目录画廊：打开相对路径图片 → 列出同目录图片与视频（自然序），当前项定位正确", async () => {
	useSessionStore
		.getState()
		.openMediaPreview([{ src: "shot-10.png", kind: "image", name: "shot-10.png" }], 0, "s1");
	render(<MediaPreviewModal />);
	// 目录项：clip.mp4, shot-2.png, shot-10.png, shot-a.png（notes.txt 与目录被过滤）
	await waitFor(() =>
		expect(screen.getByTestId("media-counter").textContent).toBe("3 / 4"),
	);
	const names = screen
		.getAllByTestId("media-thumb")
		.map((el) => el.getAttribute("title"));
	expect(names).toEqual(["clip.mp4", "shot-2.png", "shot-10.png", "shot-a.png"]);
	// 只列了同目录：请求打到当前文件所在目录
	expect(
		fake.calls.filter((c) => c.type === "fs:listDir").map((c) => c.body),
	).toEqual([{ path: DIR, showHidden: undefined }]);
});

test("同目录画廊：右箭头在同一目录内循环切换", async () => {
	useSessionStore
		.getState()
		.openMediaPreview([{ src: "shot-a.png", kind: "image", name: "shot-a.png" }], 0, "s1");
	render(<MediaPreviewModal />);
	await waitFor(() =>
		expect(screen.getByTestId("media-counter").textContent).toBe("4 / 4"),
	);
	fireEvent.click(screen.getByTestId("media-next")); // 循环回第一项
	expect(screen.getByTestId("media-counter").textContent).toBe("1 / 4");
});

test("同目录画廊：键盘 ←/→ 在同一目录内循环", async () => {
	useSessionStore
		.getState()
		.openMediaPreview([{ src: "shot-10.png", kind: "image", name: "shot-10.png" }], 0, "s1");
	render(<MediaPreviewModal />);
	await waitFor(() =>
		expect(screen.getByTestId("media-counter").textContent).toBe("3 / 4"),
	);
	fireEvent.keyDown(window, { key: "ArrowLeft" });
	expect(screen.getByTestId("media-counter").textContent).toBe("2 / 4");
	fireEvent.keyDown(window, { key: "ArrowLeft" });
	fireEvent.keyDown(window, { key: "ArrowLeft" }); // 循环到最后一个
	expect(screen.getByTestId("media-counter").textContent).toBe("4 / 4");
	fireEvent.keyDown(window, { key: "ArrowRight" });
	expect(screen.getByTestId("media-counter").textContent).toBe("1 / 4");
});

test("同目录画廊：切到视频项渲染 <video autoplay>（本地路径走 /file）", async () => {
	useSessionStore
		.getState()
		.openMediaPreview([{ src: "shot-a.png", kind: "image", name: "shot-a.png" }], 0, "s1");
	render(<MediaPreviewModal />);
	await waitFor(() =>
		expect(screen.getByTestId("media-counter").textContent).toBe("4 / 4"),
	);
	expect(screen.getByTestId("zoomable-image")).toBeTruthy();
	// 点第一张缩略图 → clip.mp4
	fireEvent.click(screen.getAllByTestId("media-thumb")[0]);
	const video = screen.getByTestId("media-video");
	expect(video.hasAttribute("autoplay")).toBe(true);
	expect(video.getAttribute("src")).toBe(
		"/file?path=" + encodeURIComponent(DIR + "/clip.mp4"),
	);
});

test("同目录画廊：缩略图条点击跳转到对应项", async () => {
	useSessionStore
		.getState()
		.openMediaPreview([{ src: "shot-a.png", kind: "image", name: "shot-a.png" }], 0, "s1");
	render(<MediaPreviewModal />);
	await waitFor(() =>
		expect(screen.getByTestId("media-counter").textContent).toBe("4 / 4"),
	);
	fireEvent.click(screen.getAllByTestId("media-thumb")[2]);
	expect(screen.getByTestId("media-counter").textContent).toBe("3 / 4");
});

test("同目录画廊：目录里只有一个媒体 → 单张退化（无箭头/缩略图条/计数器）", async () => {
	useSessionStore
		.getState()
		.openMediaPreview([{ src: "solo/only.png", kind: "image", name: "only.png" }], 0, "s1");
	render(<MediaPreviewModal />);
	await waitFor(() =>
		expect(fake.calls.some((c) => c.type === "fs:listDir")).toBe(true),
	);
	await waitFor(() =>
		expect(screen.queryByTestId("media-thumbs")).toBeNull(),
	);
	expect(screen.queryByTestId("media-prev")).toBeNull();
	expect(screen.queryByTestId("media-next")).toBeNull();
	expect(screen.queryByTestId("media-counter")).toBeNull();
	expect(screen.getByTestId("zoomable-image")).toBeTruthy();
});

// ─── 回退：没有可列目录时只显当前一张 ───

test("回退：远程 URL 图片无同目录 → 只显当前一张，且不发 listDir", async () => {
	useSessionStore.getState().openMediaPreview(ITEMS, 0, "s1");
	render(<MediaPreviewModal />);
	await waitFor(() =>
		expect(useSessionStore.getState().mediaPreview!.items.length).toBe(1),
	);
	expect(fake.calls.some((c) => c.type === "fs:listDir")).toBe(false);
	expect(screen.queryByTestId("media-thumbs")).toBeNull();
	expect(screen.queryByTestId("media-counter")).toBeNull();
	expect(screen.getByTestId("zoomable-image")).toBeTruthy();
});

test("回退：目录不在项目工作区内 → 只显当前一张，且不发 listDir", async () => {
	useSessionStore
		.getState()
		.openMediaPreview([{ src: "/outside/a.png", kind: "image", name: "a.png" }], 0, "s1");
	render(<MediaPreviewModal />);
	await waitFor(() =>
		expect(useSessionStore.getState().mediaPreview!.items.length).toBe(1),
	);
	expect(fake.calls.some((c) => c.type === "fs:listDir")).toBe(false);
	expect(screen.queryByTestId("media-thumbs")).toBeNull();
	// 仍能渲染当前这张（/file 会由内核白名单决定，前端不做裁剪）
	expect(screen.getByTestId("zoomable-image")).toBeTruthy();
});

test("回退：目录里没有媒体 → 保留当前这一张（不出现空画廊）", async () => {
	useSessionStore
		.getState()
		.openMediaPreview([{ src: "empty/a.png", kind: "image", name: "a.png" }], 0, "s1");
	render(<MediaPreviewModal />);
	await waitFor(() =>
		expect(fake.calls.some((c) => c.type === "fs:listDir")).toBe(true),
	);
	await waitFor(() =>
		expect(screen.getByTestId("zoomable-image")).toBeTruthy(),
	);
	expect(useSessionStore.getState().mediaPreview!.items.length).toBe(1);
});

test("ESC 关闭：弹窗消失且 store 清空", async () => {
	useSessionStore.getState().openMediaPreview(ITEMS, 0, "s1");
	render(<MediaPreviewModal />);
	fireEvent.keyDown(window, { key: "Escape" });
	expect(screen.queryByTestId("media-preview-modal")).toBeNull();
	expect(useSessionStore.getState().mediaPreview).toBeNull();
});

// ─── 窗口拖动 / 尺寸（与画廊数据源无关） ───

test("拖标题栏移动窗口：位置持久化，关闭重开保持上次位置", () => {
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

// ─── 顶部栏缩放控件（− 100% + ，仅图片项） ───

/** 顶部栏（拖动把手）内 [data-testid] 元素的文档顺序，用于断言控件位置 */
function topbarTestIds(): string[] {
	const topbar = document.querySelector("[data-modal-drag-handle]");
	if (!topbar) throw new Error("顶部栏未渲染");
	return Array.from(topbar.querySelectorAll("[data-testid]")).map(
		(el) => (el as HTMLElement).dataset.testid ?? "",
	);
}

test("图片项：顶部栏在计数之后渲染 − 100% + 缩放控件", async () => {
	useSessionStore
		.getState()
		.openMediaPreview([{ src: "shot-10.png", kind: "image", name: "shot-10.png" }], 0, "s1");
	render(<MediaPreviewModal />);
	await waitFor(() =>
		expect(screen.getByTestId("media-counter").textContent).toBe("3 / 4"),
	);
	// 顺序：计数 → 缩小 → 百分比 → 放大 → 复制（关闭按钮无 testid）
	expect(topbarTestIds()).toEqual([
		"media-counter",
		"media-zoom-out",
		"media-zoom-percent",
		"media-zoom-in",
		"media-copy",
	]);
	expect(screen.getByTestId("media-zoom-percent").textContent).toBe("100%");
});

test("图片项：点击放大/缩小，百分比与图片 scale 同步变化", async () => {
	useSessionStore
		.getState()
		.openMediaPreview([{ src: "shot-10.png", kind: "image", name: "shot-10.png" }], 0, "s1");
	render(<MediaPreviewModal />);
	await waitFor(() =>
		expect(screen.getByTestId("media-counter").textContent).toBe("3 / 4"),
	);
	const img = () =>
		screen.getByTestId("zoomable-image").querySelector("img") as HTMLImageElement;
	const percent = () => screen.getByTestId("media-zoom-percent").textContent;

	fireEvent.click(screen.getByTestId("media-zoom-in"));
	expect(percent()).toBe("125%");
	expect(img().style.transform).toContain("scale(1.25)");

	fireEvent.click(screen.getByTestId("media-zoom-out"));
	expect(percent()).toBe("100%");
	fireEvent.click(screen.getByTestId("media-zoom-out"));
	expect(percent()).toBe("80%");
	expect(img().style.transform).toContain("scale(0.8)");
});

test("图片项：键盘 + / - / 0 缩放与重置", async () => {
	useSessionStore
		.getState()
		.openMediaPreview([{ src: "shot-10.png", kind: "image", name: "shot-10.png" }], 0, "s1");
	render(<MediaPreviewModal />);
	await waitFor(() =>
		expect(screen.getByTestId("media-counter").textContent).toBe("3 / 4"),
	);
	const percent = () => screen.getByTestId("media-zoom-percent").textContent;

	fireEvent.keyDown(window, { key: "+" });
	expect(percent()).toBe("125%");
	fireEvent.keyDown(window, { key: "+" });
	expect(percent()).toBe("156%"); // 1.25² = 1.5625
	fireEvent.keyDown(window, { key: "-" });
	expect(percent()).toBe("125%");
	fireEvent.keyDown(window, { key: "0" });
	expect(percent()).toBe("100%");
	// 美式键盘上 + 需 Shift，主键位是 "="（同样视为放大）
	fireEvent.keyDown(window, { key: "=" });
	expect(percent()).toBe("125%");
	// 键盘缩放不影响 ←/→ 翻页
	fireEvent.keyDown(window, { key: "ArrowRight" });
	expect(screen.getByTestId("media-counter").textContent).toBe("4 / 4");
});

test("视频项：不渲染缩放控件（复制与关闭仍在）", async () => {
	useSessionStore
		.getState()
		.openMediaPreview([{ src: "clip.mp4", kind: "video", name: "clip.mp4" }], 0, "s1");
	render(<MediaPreviewModal />);
	await waitFor(() =>
		expect(screen.getByTestId("media-counter").textContent).toBe("1 / 4"),
	);
	expect(screen.getByTestId("media-video")).toBeTruthy();
	expect(screen.queryByTestId("media-zoom-out")).toBeNull();
	expect(screen.queryByTestId("media-zoom-percent")).toBeNull();
	expect(screen.queryByTestId("media-zoom-in")).toBeNull();
	expect(screen.getByTestId("media-copy")).toBeTruthy();
});

test("单张图片（无同目录画廊）也渲染缩放控件", () => {
	useSessionStore
		.getState()
		.openMediaPreview([{ src: "https://x.com/a.png", kind: "image", name: "a.png" }], 0, "s1");
	render(<MediaPreviewModal />);
	expect(screen.queryByTestId("media-counter")).toBeNull(); // count=1 无计数
	expect(screen.getByTestId("media-zoom-percent").textContent).toBe("100%");
	fireEvent.click(screen.getByTestId("media-zoom-in"));
	expect(screen.getByTestId("media-zoom-percent").textContent).toBe("125%");
});
