import { test, expect } from "bun:test";
import { parseInspectMessage, sendElementToChat } from "./element-pick";

test("parseInspectMessage：合法消息解析", () => {
	expect(
		parseInspectMessage({
			type: "hiagent:element-picked",
			selector: "html > body:nth-of-type(1) > div#card",
			tagName: "div",
			elLabel: "div.card",
		}),
	).toEqual({
		selector: "html > body:nth-of-type(1) > div#card",
		tagName: "div",
		elLabel: "div.card",
	});
});

test("parseInspectMessage：非法消息一律 null", () => {
	expect(parseInspectMessage(null)).toBeNull();
	expect(parseInspectMessage("x")).toBeNull();
	expect(parseInspectMessage({ type: "other" })).toBeNull();
	expect(
		parseInspectMessage({ type: "hiagent:element-picked", selector: 1 }),
	).toBeNull();
	expect(
		parseInspectMessage({
			type: "hiagent:element-picked",
			selector: "a",
			tagName: "div",
		}),
	).toBeNull(); // 缺 elLabel
});

test("parseInspectMessage：带 srcPath（嵌套 iframe 来源文件）时解析透传", () => {
	expect(
		parseInspectMessage({
			type: "hiagent:element-picked",
			selector: "html > body > h1#inner-title",
			tagName: "h1",
			elLabel: "h1#inner-title",
			srcPath: "/Users/co/proj/www/inner.html",
		}),
	).toEqual({
		selector: "html > body > h1#inner-title",
		tagName: "h1",
		elLabel: "h1#inner-title",
		srcPath: "/Users/co/proj/www/inner.html",
	});
});

test("parseInspectMessage：srcPath 非字符串（如数字）→ null（形状守护）", () => {
	expect(
		parseInspectMessage({
			type: "hiagent:element-picked",
			selector: "a",
			tagName: "div",
			elLabel: "div",
			srcPath: 123,
		}),
	).toBeNull();
});

// srcdoc 型嵌套：about:srcdoc 解析不出磁盘路径，脚本发送 srcPath: null ——
// 这是「解析不出」的合法信号，应视为缺省（回退外层路径），而非非法消息整条丢弃。
// 回归：此前形状守护把 null 误判为非法，导致 srcdoc 内选中后点发送无任何反应。
test("parseInspectMessage：srcPath=null（srcdoc 无磁盘路径）→ 解析成功且不带 srcPath", () => {
	expect(
		parseInspectMessage({
			type: "hiagent:element-picked",
			selector: "html > body > button#allRestore",
			tagName: "button",
			elLabel: "button#allRestore",
			srcPath: null,
		}),
	).toEqual({
		selector: "html > body > button#allRestore",
		tagName: "button",
		elLabel: "button#allRestore",
	});
});

test("sendElementToChat：picked.srcPath=null（srcdoc）回退外层 path", async () => {
	const got = captureInsert();
	await sendElementToChat("/proj/outer.html", {
		selector: "html > body > button",
		tagName: "button",
		elLabel: "button",
		srcPath: null as unknown as undefined,
	});
	expect(await got).toBe(" ![/proj/outer.html||button] ");
});

test("sendElementToChat：picked.srcPath 优先于外层 path（嵌套 iframe 元素定位到实际文件）", async () => {
	const got = captureInsert();
	await sendElementToChat("/proj/outer.html", {
		selector: "html > body > h1",
		tagName: "h1",
		elLabel: "h1",
		srcPath: "/proj/inner.html",
	});
	expect(await got).toBe(" ![/proj/inner.html||h1] ");
});

test("sendElementToChat：无 srcPath 时回退外层 path（单层行为不变）", async () => {
	const got = captureInsert();
	await sendElementToChat("/proj/index.html", {
		selector: "html",
		tagName: "html",
		elLabel: "html",
	});
	expect(await got).toBe(" ![/proj/index.html||html] ");
});

/** 捕获一次 wa-pi:insert-mention 事件的 detail.text */
function captureInsert(): Promise<string> {
	return new Promise((resolve) => {
		const on = (e: Event) => {
			window.removeEventListener("wa-pi:insert-mention", on);
			resolve((e as CustomEvent).detail.text);
		};
		window.addEventListener("wa-pi:insert-mention", on);
	});
}

test("sendElementToChat：行号接口失败降级为无行号 token（测试环境无 kernel）", async () => {
	const got = captureInsert();
	await sendElementToChat("/proj/index.html", {
		selector: "html > body:nth-of-type(1) > div#card",
		tagName: "div",
		elLabel: "div",
	});
	expect(await got).toBe(" ![/proj/index.html||div] ");
});

test("sendElementToChat：elLabel 带类名原样进 token", async () => {
	const got = captureInsert();
	await sendElementToChat("C:\\proj\\dist\\index.html", {
		selector: "html",
		tagName: "div",
		elLabel: "div.card.title",
	});
	expect(await got).toBe(" ![C:\\proj\\dist\\index.html||div.card.title] ");
});
