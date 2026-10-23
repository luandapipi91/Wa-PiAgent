// @im-push-to(ch_xxx,ct_xxx) chip 渲染测试：
// chip-im 正常渲染 / 未注册灰化 / expandTokens 原样保留 / segments 往返
import { beforeEach, expect, test } from "bun:test";
import {
	clearContactMeta,
	ensureChipStyles,
	expandTokens,
	formatElementToken,
	parseElementPayload,
	registerContactMeta,
	segmentsToText,
	textToSegments,
	textToHtml,
} from "./tokens";

beforeEach(() => {
	clearContactMeta();
	ensureChipStyles();
});

test("textToSegments 把 @im-push-to 标记解析为 im segment", () => {
	const segs = textToSegments("汇报 @im-push-to(ch_abc,ct_123) 给老板");
	expect(segs).toEqual([
		{ type: "text", value: "汇报 " },
		{ type: "im", value: "@im-push-to(ch_abc,ct_123)" },
		{ type: "text", value: " 给老板" },
	]);
});

test("textToHtml 渲染已注册联系人为 chip-im（含发送给前缀与显示名）", () => {
	registerContactMeta("ct_123", { label: "张三", kind: "person" });
	const html = textToHtml("@im-push-to(ch_abc,ct_123)");
	expect(html).toContain("chip chip-im");
	expect(html).not.toContain("chip-im-invalid");
	expect(html).toContain('data-token="@im-push-to(ch_abc,ct_123)"');
	expect(html).toContain("发送给：");
	expect(html).toContain("张三");
	expect(html).toContain('contenteditable="false"');
});

test("textToHtml 未注册联系人 → chip-im-invalid 灰化显示 contactId", () => {
	const html = textToHtml("@im-push-to(ch_abc,ct_gone)");
	expect(html).toContain("chip-im-invalid");
	expect(html).toContain("ct_gone");
});

test("group 联系人 chip 用 users 图标", () => {
	registerContactMeta("ct_g1", { label: "周报群", kind: "group" });
	const html = textToHtml("@im-push-to(ch_abc,ct_g1)");
	expect(html).toContain("周报群");
	expect(html).toContain("<svg"); // iconSvg("users")
});

test("expandTokens 不展开 @im-push-to（原样保留给 kernel 解析）", () => {
	const text = "做完推送 @im-push-to(ch_abc,ct_123)";
	expect(expandTokens(text)).toBe(text);
});

test("segmentsToText 往返还原 im token", () => {
	const text = "汇报 @im-push-to(ch_abc,ct_123) 完";
	expect(segmentsToText(textToSegments(text))).toBe(text);
});

// ── 元素 token（预览 inspect 选中元素，![路径|起-止行|标签]）──

test("元素 token：textToSegments 解析 + segmentsToText 往返", () => {
	const text = "改这个 ![/proj/dist/index.html|5-7|div.card] 元素";
	const segs = textToSegments(text);
	expect(segs).toEqual([
		{ type: "text", value: "改这个 " },
		{ type: "element", value: "/proj/dist/index.html|5-7|div.card" },
		{ type: "text", value: " 元素" },
	]);
	expect(segmentsToText(segs)).toBe(text);
});

test("元素 token：expandTokens 展开为定位文本（含行号）", () => {
	expect(expandTokens("改 ![/proj/dist/index.html|5-7|div.card] 这里")).toBe(
		"改 /proj/dist/index.html [line: 5-7] [el: div.card] 这里",
	);
});

test("元素 token：无行号省略 line 段", () => {
	expect(expandTokens("![/proj/index.html||p]")).toBe(
		"/proj/index.html [el: p]",
	);
});

test("元素 token：textToHtml 渲染 chip-element（文件名:起始行 <标签>）", () => {
	const html = textToHtml("![/proj/dist/index.html|5-7|div.card]");
	expect(html).toContain("chip chip-element");
	expect(html).toContain('contenteditable="false"');
	expect(html).toContain('data-token="![/proj/dist/index.html|5-7|div.card]"');
	expect(html).toContain("index.html:5 &lt;div.card&gt;");
	expect(html).toContain("<svg"); // iconSvg("element")
});

test("formatElementToken：endLine 缺省用 startLine，行号缺失 lines 段为空", () => {
	expect(
		formatElementToken({ path: "/a/b.html", startLine: 7, endLine: null, elLabel: "img" }),
	).toBe("![/a/b.html|7-7|img]");
	expect(
		formatElementToken({ path: "/a/b.html", startLine: null, endLine: null, elLabel: "p" }),
	).toBe("![/a/b.html||p]");
});

test("parseElementPayload：合法/非法", () => {
	expect(parseElementPayload("/a/b.html|5-7|div")).toEqual({
		path: "/a/b.html",
		lines: "5-7",
		elLabel: "div",
	});
	expect(parseElementPayload("/a/b.html||p")).toEqual({
		path: "/a/b.html",
		lines: "",
		elLabel: "p",
	});
	expect(parseElementPayload("no-separator")).toBeNull();
	expect(parseElementPayload("|1-2|div")).toBeNull(); // 缺 path
	expect(parseElementPayload("/a|1-2|")).toBeNull(); // 缺 elLabel
});

test("定位文本（展开形态）回显时重新 chip 化", () => {
	// expandTokens 的产物在消息列表里应渲染为 chip 而非纯文本
	const sent = expandTokens("改 ![/proj/dist/index.html|5-7|div.card] 这里");
	expect(sent).toBe("改 /proj/dist/index.html [line: 5-7] [el: div.card] 这里");
	const html = textToHtml(sent, { hideTrigger: true });
	expect(html).toContain("chip chip-element");
	expect(html).toContain("index.html:5 &lt;div.card&gt;");
});

test("定位文本无行号形态也 chip 化", () => {
	const html = textToHtml("/proj/index.html [el: p]", { hideTrigger: true });
	expect(html).toContain("chip chip-element");
	expect(html).toContain("index.html &lt;p&gt;");
});

test("textToSegments：定位文本还原为 element segment", () => {
	const segs = textToSegments("改 /proj/index.html [line: 5-7] [el: div] 这里");
	expect(segs).toEqual([
		{ type: "text", value: "改 " },
		{ type: "element", value: "/proj/index.html|5-7|div" },
		{ type: "text", value: " 这里" },
	]);
});
