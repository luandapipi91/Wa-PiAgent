import { test, expect } from "bun:test";
import { buildPreviewUrl, isHtmlPath, toExternalUrl } from "./preview-url";

test("isHtmlPath 命中 .html / .htm", () => {
	expect(isHtmlPath("/a/b/index.html")).toBe(true);
	expect(isHtmlPath("/a/b/page.htm")).toBe(true);
	expect(isHtmlPath("/a/b/style.css")).toBe(false);
	expect(isHtmlPath("/a/b/readme.md")).toBe(false);
});

test("buildPreviewUrl 编码目录、编码文件名", () => {
	expect(buildPreviewUrl("/a/b/dist/index.html")).toBe(
		`/preview/${encodeURIComponent("/a/b/dist")}/${encodeURIComponent("index.html")}`,
	);
});

test("buildPreviewUrl 处理中文与空格", () => {
	const url = buildPreviewUrl("/我的 项目/dist/index.html");
	expect(url.startsWith("/preview/")).toBe(true);
	expect(url.endsWith("/index.html")).toBe(true);
	expect(url.includes(encodeURIComponent("/我的 项目/dist"))).toBe(true);
});

test("buildPreviewUrl 编码中文/空格文件名", () => {
	const url = buildPreviewUrl("/a/b/dist/报告 2026.html");
	expect(url).toBe(
		`/preview/${encodeURIComponent("/a/b/dist")}/${encodeURIComponent("报告 2026.html")}`,
	);
});

test("buildPreviewUrl 处理 Windows 反斜杠", () => {
	expect(buildPreviewUrl("C:\\proj\\dist\\index.html")).toBe(
		`/preview/${encodeURIComponent("C:\\proj\\dist")}/${encodeURIComponent("index.html")}`,
	);
});

test("toExternalUrl 保留 http/https 原样", () => {
	expect(toExternalUrl("http://example.com/a")).toBe("http://example.com/a");
	expect(toExternalUrl("https://www.baidu.com/s?wd=x")).toBe(
		"https://www.baidu.com/s?wd=x",
	);
});

test("toExternalUrl 域名自动补 https://", () => {
	expect(toExternalUrl("baidu.com")).toBe("https://baidu.com");
	expect(toExternalUrl("www.taobao.com/path")).toBe("https://www.taobao.com/path");
});

test("toExternalUrl 识别 localhost / IP（含端口，回环补 http://）", () => {
	expect(toExternalUrl("localhost:3000")).toBe("http://localhost:3000");
	expect(toExternalUrl("127.0.0.1:9776")).toBe("http://127.0.0.1:9776");
});

test("toExternalUrl 无协议 .html 单段（index.html）视为本地文件返回 null", () => {
	expect(toExternalUrl("index.html")).toBeNull();
	expect(toExternalUrl("foo.htm")).toBeNull();
});

test("toExternalUrl 域名 + .html 路径是合法外部 URL", () => {
	expect(toExternalUrl("example.com/page.html")).toBe(
		"https://example.com/page.html",
	);
});

test("toExternalUrl 非 URL 形态返回 null", () => {
	expect(toExternalUrl("/a/b/index.html")).toBeNull();
	expect(toExternalUrl("C:\\proj\\dist\\index.html")).toBeNull();
	expect(toExternalUrl("随便文字")).toBeNull();
	expect(toExternalUrl("")).toBeNull();
});

test("toExternalUrl 畸形 scheme（空 host）返回 null", () => {
	expect(toExternalUrl("https://")).toBeNull();
	expect(toExternalUrl("http://")).toBeNull();
});
