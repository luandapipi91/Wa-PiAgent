import { test, expect } from "bun:test";
import {
	isPreviewWindow,
	parsePreviewWindowParams,
	PREVIEW_WIN_PARAM,
} from "./preview-window";

test("isPreviewWindow：只有 wa-preview-win=1 才判定为独立预览窗口", () => {
	expect(isPreviewWindow("?wa-preview-win=1")).toBe(true);
	expect(isPreviewWindow("?wa-preview-win=1&path=%2Fa%2Findex.html")).toBe(true);
	// 主窗口入口：无参数 / 其他参数
	expect(isPreviewWindow("")).toBe(false);
	expect(isPreviewWindow("?foo=1")).toBe(false);
	// 值必须为 1（防 `?wa-preview-win` 这类空值误判）
	expect(isPreviewWindow("?wa-preview-win")).toBe(false);
	expect(isPreviewWindow("?wa-preview-win=0")).toBe(false);
});

test("parsePreviewWindowParams：解析 path 与 sid", () => {
	expect(
		parsePreviewWindowParams(
			"?wa-preview-win=1&path=%2FUsers%2Fco%2Fproj%2Findex.html&sid=s-123",
		),
	).toEqual({ path: "/Users/co/proj/index.html", sessionId: "s-123" });
});

test("parsePreviewWindowParams：缺省字段回落 null（空窗口而非空串）", () => {
	expect(parsePreviewWindowParams("?wa-preview-win=1")).toEqual({
		path: null,
		sessionId: null,
	});
	expect(parsePreviewWindowParams("?wa-preview-win=1&path=&sid=")).toEqual({
		path: null,
		sessionId: null,
	});
});

test("parsePreviewWindowParams：含空格/中文/加号的路径正确解码", () => {
	expect(
		parsePreviewWindowParams(
			"?wa-preview-win=1&path=%2Ftmp%2Fmy%20dir%2F%E9%A1%B5%E9%9D%A2+a.html",
		).path,
	).toBe("/tmp/my dir/页面 a.html");
});

test("PREVIEW_WIN_PARAM 与主进程拼接的参数名保持一致（拼写护栏）", () => {
	expect(PREVIEW_WIN_PARAM).toBe("wa-preview-win");
});
