// tests/image-revision.test.tsx — 标注保存后的缓存刷新（任务 5）
// 背景：标注保存覆盖同一路径的图片后，浏览器仍命中旧缓存。约定按 revision 版本号
// 拼 URL（`&v=N`）：pathToUploadUrl / resolveMediaSrc 透传 version，
// ThumbStrip 与 MediaPreviewModal 订阅 useImageRevisionStore，bump 后重新拼 URL。
import { test, expect, beforeEach, afterEach } from "bun:test";
import { render, screen, cleanup, act } from "@testing-library/react";
import {
	pathToUploadUrl,
	_clearFsQueryCache,
	_setFsTransport,
} from "../src/fs-client";
import {
	resolveMediaSrc,
	type MediaItem,
} from "../src/components/blocks/media-utils";
import { ThumbStrip } from "../src/components/blocks/ThumbStrip";
import { MediaPreviewModal } from "../src/components/blocks/MediaPreviewModal";
import { useImageRevisionStore } from "../src/store/image-revision";
import { useSessionStore } from "../src/store/session";
import { useProjectsStore } from "../src/store/projects";
import { makeFakeFsTransport } from "./fs-transport";

// ─── pathToUploadUrl / resolveMediaSrc 的 version 参数 ───

test("pathToUploadUrl：传 version 拼 &v=N", () => {
	expect(pathToUploadUrl("/a/b.png", 3)).toBe(
		"/file?path=" + encodeURIComponent("/a/b.png") + "&v=3",
	);
});

test("pathToUploadUrl：不传 version 或 version=0 保持原样（现有调用方行为不变）", () => {
	const plain = "/file?path=" + encodeURIComponent("/a/b.png");
	expect(pathToUploadUrl("/a/b.png")).toBe(plain);
	expect(pathToUploadUrl("/a/b.png", 0)).toBe(plain);
});

test("resolveMediaSrc：本地路径带 version → /file 带 &v=N", () => {
	expect(resolveMediaSrc("/a/b.png", "s1", 2)).toBe(
		"/file?path=" + encodeURIComponent("/a/b.png") + "&v=2",
	);
	// 不传 version：与既有输出完全一致
	expect(resolveMediaSrc("/a/b.png", "s1")).toBe(
		"/file?path=" + encodeURIComponent("/a/b.png"),
	);
});

test("resolveMediaSrc：远程/内联地址原样返回，不追加 version", () => {
	expect(resolveMediaSrc("https://x.com/a.png", "s1", 2)).toBe(
		"https://x.com/a.png",
	);
	expect(resolveMediaSrc("data:image/png;base64,AAA", "s1", 2)).toBe(
		"data:image/png;base64,AAA",
	);
	expect(resolveMediaSrc("blob:http://x/1", "s1", 2)).toBe("blob:http://x/1");
});

// ─── ThumbStrip 按 revision 刷新 ───

const STRIP_ITEMS: MediaItem[] = [
	{ src: "/d/a.png", kind: "image", name: "a.png" },
	{ src: "/d/b.png", kind: "image", name: "b.png" },
];

function thumbSrcs(): string[] {
	return screen
		.getAllByTestId("media-thumb")
		.map((el) => el.querySelector("img")?.getAttribute("src") ?? "");
}

test("ThumbStrip：revision 变化后对应缩略图 src 带上新版本号", () => {
	render(
		<ThumbStrip items={STRIP_ITEMS} index={0} sessionId="s1" onSelect={() => {}} />,
	);
	// 初始（revision 0）：不带 v 参数
	expect(thumbSrcs()).toEqual([
		"/file?path=" + encodeURIComponent("/d/a.png"),
		"/file?path=" + encodeURIComponent("/d/b.png"),
	]);

	// 只 bump a.png：仅该项 URL 变化，其余项不受影响
	act(() => useImageRevisionStore.getState().bumpImageRevision("/d/a.png"));
	expect(thumbSrcs()).toEqual([
		"/file?path=" + encodeURIComponent("/d/a.png") + "&v=1",
		"/file?path=" + encodeURIComponent("/d/b.png"),
	]);

	act(() => useImageRevisionStore.getState().bumpImageRevision("/d/a.png"));
	expect(thumbSrcs()[0]).toContain("&v=2");
});

// ─── MediaPreviewModal 按 revision 刷新 ───

const DIR = "/work/demo";
const fake = makeFakeFsTransport((evt) => {
	if (evt.type === "fs:listDir") {
		return {
			entries: [
				{ name: "a.png", isDir: false },
				{ name: "b.png", isDir: false },
			],
		};
	}
	return undefined;
});

beforeEach(() => {
	useImageRevisionStore.setState({ revisions: {} });
	useSessionStore.setState({ mediaPreview: null });
	useProjectsStore.setState({
		projects: [{ id: "p1", name: "demo", cwd: DIR } as any],
		sessions: [{ id: "s1", projectId: "p1" } as any],
	});
	_setFsTransport(fake.transport);
	_clearFsQueryCache();
});

afterEach(() => {
	cleanup();
	_setFsTransport(null);
});

test("MediaPreviewModal：bump 后主图与缩略图条都换到新版本 URL", async () => {
	const current = `${DIR}/a.png`;
	useSessionStore
		.getState()
		.openMediaPreview(
			[{ src: current, kind: "image", name: "a.png" }],
			0,
			"s1",
		);
	render(<MediaPreviewModal />);
	// 等画廊重建完成（a.png → b.png 两项）
	await act(async () => {
		await Promise.resolve();
	});

	const imgSrc = () =>
		screen.getByTestId("zoomable-image").querySelector("img")!.getAttribute("src");
	const currentThumbSrc = () =>
		screen
			.getAllByTestId("media-thumb")[0]
			.querySelector("img")!
			.getAttribute("src");

	expect(imgSrc()).toBe("/file?path=" + encodeURIComponent(current));
	expect(currentThumbSrc()).toBe("/file?path=" + encodeURIComponent(current));

	act(() => useImageRevisionStore.getState().bumpImageRevision(current));
	expect(imgSrc()).toBe(
		"/file?path=" + encodeURIComponent(current) + "&v=1",
	);
	expect(currentThumbSrc()).toBe(
		"/file?path=" + encodeURIComponent(current) + "&v=1",
	);
});
