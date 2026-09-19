import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
	).toEqual({ path: "/Users/co/proj/index.html", sessionId: "s-123", url: null });
});

test("parsePreviewWindowParams：缺省字段回落 null（空窗口而非空串）", () => {
	expect(parsePreviewWindowParams("?wa-preview-win=1")).toEqual({
		path: null,
		sessionId: null,
		url: null,
	});
	expect(parsePreviewWindowParams("?wa-preview-win=1&path=&sid=&url=")).toEqual({
		path: null,
		sessionId: null,
		url: null,
	});
});

test("parsePreviewWindowParams：含空格/中文/加号的路径正确解码", () => {
	expect(
		parsePreviewWindowParams(
			"?wa-preview-win=1&path=%2Ftmp%2Fmy%20dir%2F%E9%A1%B5%E9%9D%A2+a.html",
		).path,
	).toBe("/tmp/my dir/页面 a.html");
});

// ── 外部网址预览：独立窗口也承载网址（agent preview_open / 地址栏输入网址）──
test("parsePreviewWindowParams：解析外部网址 url（带 query/中文需正确解码）", () => {
	expect(
		parsePreviewWindowParams(
			"?wa-preview-win=1&url=https%3A%2F%2Fexample.com%2Fpage%3Fa%3D1&sid=s-1",
		),
	).toEqual({
		path: null,
		sessionId: "s-1",
		url: "https://example.com/page?a=1",
	});
});

test("PREVIEW_WIN_PARAM 与主进程拼接的参数名保持一致（拼写护栏）", () => {
	expect(PREVIEW_WIN_PARAM).toBe("wa-preview-win");
});

// ── 与主进程（packages/desktop/src/main.cjs）的契约护栏 ──
// main.cjs 顶层有 require("electron") 等副作用，无法 import；这里读源码字符串校验
// 「拼 URL query 的键名」「sync 消息字段」与解析端/事件端一致。键名写错不会有类型错误，
// 只会表现为独立窗口内容错位（如永远显示空窗口），故用护栏测试锁住。
const mainSrc = readFileSync(
	join(import.meta.dir, "..", "..", "desktop", "src", "main.cjs"),
	"utf8",
);

test("main.cjs 拼给独立窗口的 URL query 键与 parsePreviewWindowParams 一致（path/sid/url）", () => {
	expect(mainSrc).toContain('params.set("path", String(payload.path))');
	expect(mainSrc).toContain('params.set("sid", String(payload.sessionId))');
	expect(mainSrc).toContain('params.set("url", String(payload.url))');
});

test("main.cjs 已存在窗口时下发的 sync 消息带上 url（切会话/切网址不会显示陈旧内容）", () => {
	expect(mainSrc).toContain('type: "sync"');
	expect(mainSrc).toContain("url: payload.url ?? null");
});
