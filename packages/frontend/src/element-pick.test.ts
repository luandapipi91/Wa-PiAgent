import { test, expect, beforeEach } from "bun:test";
import {
	parseInspectMessage,
	buildElementDraft,
	handleElementPicked,
} from "./element-pick";
import { useComposerPrefsStore } from "./store/composer-prefs";

beforeEach(() => {
	useComposerPrefsStore.setState({ bySession: {} });
});

test("parseInspectMessage：合法消息解析", () => {
	expect(
		parseInspectMessage({
			type: "hiagent:element-picked",
			selector: "html > body > div#card",
			tagName: "div",
			elLabel: "div.card",
		}),
	).toEqual({ selector: "html > body > div#card", tagName: "div", elLabel: "div.card" });
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

test("buildElementDraft：有行号 name 带行号", () => {
	const d = buildElementDraft(
		"/proj/dist/index.html",
		{ selector: "html > body > div#card", tagName: "div", elLabel: "div" },
		{ startLine: 5, endLine: 8 },
	);
	expect(d).toEqual({
		kind: "element",
		name: "index.html:5 <div>",
		path: "/proj/dist/index.html",
		selector: "html > body > div#card",
		elLabel: "div",
		startLine: 5,
		endLine: 8,
	});
});

test("buildElementDraft：无行号 name 省略行号", () => {
	const d = buildElementDraft(
		"C:\\proj\\index.html",
		{ selector: "html > body > p:nth-of-type(1)", tagName: "p", elLabel: "p" },
		{ startLine: null, endLine: null },
	);
	expect(d.name).toBe("index.html <p>");
});

test("handleElementPicked：无会话返回 no-session，不落 chip", async () => {
	const r = await handleElementPicked(
		"/proj/index.html",
		{ selector: "html", tagName: "html", elLabel: "html" },
		null,
	);
	expect(r).toBe("no-session");
	expect(useComposerPrefsStore.getState().bySession).toEqual({});
});

test("handleElementPicked：行号接口失败降级为无行号 chip", async () => {
	// 接口请求必然失败（测试环境无 kernel），验证降级路径
	const r = await handleElementPicked(
		"/proj/index.html",
		{ selector: "html > body > div#card", tagName: "div", elLabel: "div" },
		"s1",
	);
	expect(r).toBe("ok");
	const atts = useComposerPrefsStore.getState().bySession["s1"]?.attachments;
	expect(atts?.length).toBe(1);
	expect(atts?.[0].kind).toBe("element");
	expect(atts?.[0].name).toBe("index.html <div>");
});

test("handleElementPicked：chip 追加到已有附件之后", async () => {
	useComposerPrefsStore.setState({
		bySession: {
			s1: {
				model: null,
				attachments: [{ kind: "snippet", name: "x", content: "y" }],
			},
		},
	});
	await handleElementPicked(
		"/proj/index.html",
		{ selector: "html", tagName: "html", elLabel: "html" },
		"s1",
	);
	const atts = useComposerPrefsStore.getState().bySession["s1"]!.attachments;
	expect(atts.length).toBe(2);
	expect(atts[1].kind).toBe("element");
});
