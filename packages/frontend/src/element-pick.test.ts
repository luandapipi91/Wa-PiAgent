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
	expect(parseInspectMessage({ type: "hiagent:element-picked", selector: 1 })).toBeNull();
	expect(
		parseInspectMessage({ type: "hiagent:element-picked", selector: "a", tagName: "div" }),
	).toBeNull(); // 缺 elLabel
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
