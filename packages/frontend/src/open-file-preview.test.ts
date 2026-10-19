// openFileOrPreview 统一分发测试：html → browser store（BrowserPanel），非 html → session store（文件预览）
import { test, expect, beforeEach } from "bun:test";
import { useBrowserStore } from "../src/store/browser";
import { useSessionStore } from "../src/store/session";
import { openFileOrPreview } from "../src/open-file-preview";

beforeEach(() => {
	useBrowserStore.setState({ open: false, path: null, sessionId: null });
	useSessionStore.setState({ filePreview: null, mediaPreview: null });
});

test("html 文件 → 打开 BrowserPanel（browser store），不打开文件预览", () => {
	openFileOrPreview("/work/demo/dist/index.html", "s1");
	expect(useBrowserStore.getState().open).toBe(true);
	expect(useBrowserStore.getState().path).toBe("/work/demo/dist/index.html");
	expect(useBrowserStore.getState().sessionId).toBe("s1");
	expect(useSessionStore.getState().filePreview).toBeNull();
});

test("非 html 文件 → 打开内置文件预览器（session store）", () => {
	openFileOrPreview("/work/demo/src/index.ts", "s1");
	expect(useBrowserStore.getState().open).toBe(false);
	expect(useSessionStore.getState().filePreview).toEqual({
		path: "/work/demo/src/index.ts",
		sessionId: "s1",
	});
});

test("htm 扩展名同样走浏览器预览", () => {
	openFileOrPreview("/work/demo/page.htm", "s2");
	expect(useBrowserStore.getState().open).toBe(true);
	expect(useSessionStore.getState().filePreview).toBeNull();
});

test("大写 .HTML 扩展名同样走浏览器预览", () => {
	openFileOrPreview("/work/demo/DIST/INDEX.HTML", "s1");
	expect(useBrowserStore.getState().open).toBe(true);
	expect(useSessionStore.getState().filePreview).toBeNull();
});

// 图片/视频走媒体画廊：与消息里的图片同一个窗（自带同目录缩略图条与左右切换），
// 而不是文件预览窗的图片分支（后者保留作兜底，如 markdown 链接直接打开图片）。

test("图片文件 → 打开媒体画廊（不进文件预览窗）", () => {
	openFileOrPreview("/work/demo/pics/cat.png", "s1");
	expect(useSessionStore.getState().filePreview).toBeNull();
	const mp = useSessionStore.getState().mediaPreview!;
	expect(mp.items).toEqual([
		{ src: "/work/demo/pics/cat.png", kind: "image", name: "cat.png" },
	]);
	expect(mp.index).toBe(0);
	expect(mp.sessionId).toBe("s1");
});

test("视频文件 → 打开媒体画廊（kind=video，播放交给画廊）", () => {
	openFileOrPreview("/work/demo/pics/clip.mp4", "s1");
	expect(useSessionStore.getState().filePreview).toBeNull();
	expect(useSessionStore.getState().mediaPreview!.items).toEqual([
		{ src: "/work/demo/pics/clip.mp4", kind: "video", name: "clip.mp4" },
	]);
});

test("大写图片扩展名 .PNG 同样走媒体画廊", () => {
	openFileOrPreview("C:\\work\\demo\\PIC.PNG", "s1");
	expect(useSessionStore.getState().filePreview).toBeNull();
	expect(useSessionStore.getState().mediaPreview!.items[0]).toEqual({
		src: "C:\\work\\demo\\PIC.PNG",
		kind: "image",
		name: "PIC.PNG",
	});
});

test("html 优先：图片扩展名之外的 html 仍走浏览器预览", () => {
	openFileOrPreview("/work/demo/pics/page.html", "s1");
	expect(useBrowserStore.getState().open).toBe(true);
	expect(useSessionStore.getState().mediaPreview).toBeNull();
});

test("非媒体文件不受影响：仍走内置文件预览", () => {
	openFileOrPreview("/work/demo/notes.md", "s1");
	expect(useSessionStore.getState().mediaPreview).toBeNull();
	expect(useSessionStore.getState().filePreview).toMatchObject({
		path: "/work/demo/notes.md",
		sessionId: "s1",
	});
});
