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

/** 临时 stub fetch，让 api.get 返回指定 body；用后恢复 */
async function withLocateBody(body: unknown, fn: () => Promise<void>) {
	const origFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
	try {
		await fn();
	} finally {
		globalThis.fetch = origFetch;
	}
}

test("handleElementPicked：行号接口返回合法行号时 chip 带行号", async () => {
	await withLocateBody({ startLine: 3, endLine: 5 }, async () => {
		const r = await handleElementPicked(
			"/proj/index.html",
			{ selector: "html", tagName: "html", elLabel: "html" },
			"s1",
		);
		expect(r).toBe("ok");
		const atts = useComposerPrefsStore.getState().bySession["s1"]!.attachments;
		const a = atts[0];
		if (a.kind !== "element") throw new Error("期望 element 附件");
		expect(a.name).toBe("index.html:3 <html>");
		expect(a.startLine).toBe(3);
		expect(a.endLine).toBe(5);
	});
});

test("handleElementPicked：行号接口返回异常形状按无行号降级", async () => {
	await withLocateBody({ startLine: "abc", endLine: {} }, async () => {
		const r = await handleElementPicked(
			"/proj/index.html",
			{ selector: "html", tagName: "html", elLabel: "html" },
			"s1",
		);
		expect(r).toBe("ok");
		const atts = useComposerPrefsStore.getState().bySession["s1"]!.attachments;
		const a = atts[0];
		if (a.kind !== "element") throw new Error("期望 element 附件");
		expect(a.name).toBe("index.html <html>");
		expect(a.startLine).toBeNull();
		expect(a.endLine).toBeNull();
	});
});
