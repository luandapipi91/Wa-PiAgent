// openFileOrPreview 统一分发测试：html → browser store（BrowserPanel），非 html → session store（文件预览）
import { test, expect, beforeEach } from "bun:test";
import { useBrowserStore } from "../src/store/browser";
import { useSessionStore } from "../src/store/session";
import { openFileOrPreview } from "../src/open-file-preview";

beforeEach(() => {
	useBrowserStore.setState({ open: false, path: null, sessionId: null });
	useSessionStore.setState({ filePreview: null });
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
