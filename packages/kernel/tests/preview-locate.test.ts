import { test, expect } from "bun:test";
import { locateElement } from "../src/preview-locate";

const HTML = [
	"<!DOCTYPE html>",              // 1
	"<html>",                       // 2
	"<head><title>t</title></head>",// 3
	"<body>",                       // 4
	'<div id="card">',              // 5
	"  <p>hello</p>",               // 6
	"  <p>world</p>",               // 7
	"</div>",                       // 8
	"<div><span>a</span></div>",    // 9
	"</body>",                      // 10
	"</html>",                      // 11
].join("\n");

test("按 id 定位元素及闭合行", () => {
	expect(locateElement(HTML, "html > body > div#card")).toEqual({
		startLine: 5,
		endLine: 8,
	});
});

test("按 nth-of-type 定位兄弟元素", () => {
	expect(locateElement(HTML, "html > body > div#card > p:nth-of-type(2)")).toEqual({
		startLine: 7,
		endLine: 7,
	});
});

test("无 id 元素用 nth-of-type 段", () => {
	expect(locateElement(HTML, "html > body > div:nth-of-type(2) > span:nth-of-type(1)")).toEqual({
		startLine: 9,
		endLine: 9,
	});
});

test("selector 不匹配返回 null", () => {
	expect(locateElement(HTML, "html > body > ul:nth-of-type(1)")).toBeNull();
});

test("script 内容里的假标签不干扰", () => {
	const html = '<html>\n<body>\n<script>var s = "<div>fake</div>";</script>\n<div id="real">x</div>\n</body>\n</html>';
	expect(locateElement(html, "html > body > div#real")).toEqual({
		startLine: 4,
		endLine: 4,
	});
});

test("void 元素（img）自身起止同行", () => {
	const html = '<html>\n<body>\n<img src="a.png">\n</body>\n</html>';
	expect(locateElement(html, "html > body > img:nth-of-type(1)")).toEqual({
		startLine: 3,
		endLine: 3,
	});
});
