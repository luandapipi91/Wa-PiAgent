import { test, expect } from "bun:test";
import { formatElementRef } from "../src/prompt-attachments";

test("element 附件序列化：带行号", () => {
	const s = formatElementRef(
		{ path: "/proj/dist/index.html", elLabel: "div.card", startLine: 33, endLine: 35 },
		"/proj",
	);
	expect(s).toBe("dist/index.html [line: 33-35] [el: div.card]");
});

test("element 附件序列化：无行号省略 line 段", () => {
	const s = formatElementRef(
		{ path: "/proj/index.html", elLabel: "p", startLine: null, endLine: null },
		"/proj",
	);
	expect(s).toBe("index.html [el: p]");
});

test("element 附件序列化：endLine 缺失时用 startLine", () => {
	const s = formatElementRef(
		{ path: "/proj/index.html", elLabel: "img", startLine: 7, endLine: null },
		"/proj",
	);
	expect(s).toBe("index.html [line: 7-7] [el: img]");
});

test("element 附件序列化：无 cwd 原样输出", () => {
	const s = formatElementRef(
		{ path: "C:\\proj\\index.html", elLabel: "div", startLine: 1, endLine: 2 },
	);
	expect(s).toBe("C:\\proj\\index.html [line: 1-2] [el: div]");
});
