import { test, expect } from "bun:test";
import { locateElement } from "../src/preview-locate";

const HTML = [
	"<!DOCTYPE html>", // 1
	"<html>", // 2
	"<head><title>t</title></head>", // 3
	"<body>", // 4
	'<div id="card">', // 5
	"  <p>hello</p>", // 6
	"  <p>world</p>", // 7
	"</div>", // 8
	"<div><span>a</span></div>", // 9
	"</body>", // 10
	"</html>", // 11
].join("\n");

test("按 id 定位元素及闭合行", () => {
	expect(locateElement(HTML, "html > body:nth-of-type(1) > div#card")).toEqual({
		startLine: 5,
		endLine: 8,
	});
});

test("按 nth-of-type 定位兄弟元素", () => {
	expect(
		locateElement(
			HTML,
			"html > body:nth-of-type(1) > div#card > p:nth-of-type(2)",
		),
	).toEqual({
		startLine: 7,
		endLine: 7,
	});
});

test("无 id 元素用 nth-of-type 段", () => {
	expect(
		locateElement(
			HTML,
			"html > body:nth-of-type(1) > div:nth-of-type(2) > span:nth-of-type(1)",
		),
	).toEqual({
		startLine: 9,
		endLine: 9,
	});
});

test("selector 不匹配返回 null", () => {
	expect(
		locateElement(HTML, "html > body:nth-of-type(1) > ul:nth-of-type(1)"),
	).toBeNull();
});

test("script 内容里的假标签不干扰", () => {
	const html =
		'<html>\n<body>\n<script>var s = "<div>fake</div>";</script>\n<div id="real">x</div>\n</body>\n</html>';
	expect(locateElement(html, "html > body:nth-of-type(1) > div#real")).toEqual({
		startLine: 4,
		endLine: 4,
	});
});

test("void 元素（img）自身起止同行", () => {
	const html = '<html>\n<body>\n<img src="a.png">\n</body>\n</html>';
	expect(
		locateElement(html, "html > body:nth-of-type(1) > img:nth-of-type(1)"),
	).toEqual({
		startLine: 3,
		endLine: 3,
	});
});

test("按 data-testid 段定位", () => {
	const html = [
		"<html>",
		"<body>",
		'<button data-testid="submit">Go</button>',
		"</body>",
		"</html>",
	].join("\n");
	expect(
		locateElement(
			html,
			'html > body:nth-of-type(1) > button[data-testid="submit"]',
		),
	).toEqual({ startLine: 3, endLine: 3 });
});

test("按 role 段定位", () => {
const html = [
"<html>",
"<body>",
'<input role="textbox">',
"</body>",
"</html>",
].join("\n");
expect(
locateElement(html, 'html > body:nth-of-type(1) > input[role="textbox"]'),
).toEqual({ startLine: 3, endLine: 3 });
});

test("按 nth-of-type 定位同标签多个兄弟（取第 2 个）", () => {
// 现有 HTML：body 下两个 div（div#card 为第 1 个、无 id div 为第 2 个）
expect(
locateElement(HTML, "html > body:nth-of-type(1) > div:nth-of-type(2)"),
).toEqual({ startLine: 9, endLine: 9 });
});

test("按 data-testid 定位嵌套子元素", () => {
const html = [
"<html>",
"<body>",
'<div id="card">',
'<input data-testid="email">',
"</div>",
"</body>",
"</html>",
].join("\n");
expect(
locateElement(
html,
'html > body:nth-of-type(1) > div#card > input[data-testid="email"]',
),
).toEqual({ startLine: 4, endLine: 4 });
});

test("style 内容里的假标签不干扰", () => {
const html =
'<html>\n<body>\n<style>.x{content:"<div>fake</div>"}</style>\n<div id="real">x</div>\n</body>\n</html>';
expect(locateElement(html, "html > body:nth-of-type(1) > div#real")).toEqual({
startLine: 4,
endLine: 4,
});
});

test("不同标签交错时 nth-of-type 只数同标签兄弟", () => {
const html = [
"<html>",
"<body>",
"<div>a</div>",
"<span>b</span>",
"<div>c</div>",
"</body>",
"</html>",
].join("\n");
// body 下 div 第 1、2 个（span 不参与 div 计数），div:nth-of-type(2) 是第 5 行 <div>c</div>
expect(
locateElement(html, "html > body:nth-of-type(1) > div:nth-of-type(2)"),
).toEqual({ startLine: 5, endLine: 5 });
});

test("动态渲染元素在源码里不存在 → 返回 null（源码兜底场景）", () => {
const html = ["<html>", "<body>", '<div id="real">x</div>', "</body>", "</html>"].join("\n");
// 源码里没有 button[data-testid=dynamic]（由 JS 动态插入），静态解析匹配不到
expect(
locateElement(html, 'html > body:nth-of-type(1) > button[data-testid="dynamic"]'),
).toBeNull();
});
