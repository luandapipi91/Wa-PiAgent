import { test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { InlineVideo } from "../../src/components/blocks/InlineVideo";
import { useSessionStore } from "../../src/store/session";
import type { MediaItem } from "../../src/components/blocks/media-utils";

const ITEMS: MediaItem[] = [
	{ src: "/home/me/proj/out/clip.mp4", kind: "video", name: "clip.mp4" },
];

// happy-dom 在 about:blank 下无法解析相对 URL（/file?path=...），video 插入时同步 fire
// error 导致直接降级。同 Task 5 测试处理：临时把页面 URL 设为 http://localhost/。
beforeAll(() => (window as any).happyDOM?.setURL?.("http://localhost/"));
afterAll(() => (window as any).happyDOM?.setURL?.("about:blank"));

beforeEach(() => {
	useSessionStore.setState({ mediaPreview: null });
});
afterEach(() => cleanup());

test("渲染 <video controls preload=metadata>，本地路径 src 走 /file", () => {
	render(
		<InlineVideo
			src="/home/me/proj/out/clip.mp4"
			name="clip.mp4"
			sessionId="s1"
			items={ITEMS}
		/>,
	);
	const video = screen.getByTestId("inline-video").querySelector("video")!;
	expect(video.hasAttribute("controls")).toBe(true);
	expect(video.getAttribute("preload")).toBe("metadata");
	expect(video.getAttribute("src")).toBe(
		"/file?path=" + encodeURIComponent("/home/me/proj/out/clip.mp4"),
	);
});

test("点击放大按钮打开画廊（视频项）", () => {
	render(
		<InlineVideo
			src="/home/me/proj/out/clip.mp4"
			name="clip.mp4"
			sessionId="s1"
			items={ITEMS}
		/>,
	);
	fireEvent.click(screen.getByTestId("inline-video-zoom"));
	expect(useSessionStore.getState().mediaPreview).toMatchObject({
		items: ITEMS,
		index: 0,
		sessionId: "s1",
	});
});

test("加载失败降级（video 消失，路径文本保留）", async () => {
	render(
		<InlineVideo
			src="/home/me/proj/out/clip.mp4"
			name="clip.mp4"
			sessionId="s1"
			items={ITEMS}
		/>,
	);
	fireEvent.error(screen.getByTestId("inline-video").querySelector("video")!);
	await waitFor(() =>
		expect(screen.queryByTestId("inline-video")).toBeNull(),
	);
	expect(document.body.textContent).toContain("clip.mp4");
});

test("items 中找不到自身时以单媒体打开（兜底）", () => {
	render(
		<InlineVideo src="https://x.com/v.mp4" name="v.mp4" sessionId="s1" items={[]} />,
	);
	fireEvent.click(screen.getByTestId("inline-video-zoom"));
	expect(useSessionStore.getState().mediaPreview?.items).toEqual([
		{ src: "https://x.com/v.mp4", kind: "video", name: "v.mp4" },
	]);
});
