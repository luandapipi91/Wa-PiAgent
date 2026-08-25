import { test, expect } from "bun:test";
import {
	injectInspectScript,
	INSPECT_SCRIPT_TAG,
} from "../src/preview-inspect";

// UMD：node/bun 下 require 拿到纯函数 buildSelector
const { buildSelector } = require("../src/assets/preview-inspect.js");

test("注入：有 </head> 插在其前", () => {
	const out = injectInspectScript(
		"<html><head><title>t</title></head><body></body></html>",
	);
	expect(out).toBe(
		`<html><head><title>t</title>${INSPECT_SCRIPT_TAG}</head><body></body></html>`,
	);
});

test("注入：无 head 则插到最前", () => {
	expect(injectInspectScript("<p>hi</p>")).toBe(
		`${INSPECT_SCRIPT_TAG}<p>hi</p>`,
	);
});

test("注入：</HEAD> 大小写不敏感", () => {
	const out = injectInspectScript("<HTML><HEAD></HEAD><BODY></BODY></HTML>");
	expect(out).toContain(`${INSPECT_SCRIPT_TAG}</HEAD>`);
});

// ── buildSelector（fake DOM：仅需 tagName/id/parentElement/children）──
function el(
	tag: string,
	opts: {
		id?: string;
		children?: any[];
		classes?: string[];
		attrs?: Record<string, string>;
	} = {},
): any {
	const node: any = {
		tagName: tag.toUpperCase(),
		id: opts.id ?? "",
		classList: opts.classes ?? [],
		children: opts.children ?? [],
		parentElement: null,
		getAttribute: (name: string) => opts.attrs?.[name] ?? null,
	};
	for (const c of node.children) c.parentElement = node;
	return node;
}

test("buildSelector：无 id 逐层 nth-of-type 回溯到根", () => {
	const p1 = el("p");
	const p2 = el("p");
	const div = el("div", { children: [p1, p2] });
	const body = el("body", { children: [div] });
	el("html", { children: [body] });
	expect(buildSelector(p2)).toBe(
		"html > body:nth-of-type(1) > div:nth-of-type(1) > p:nth-of-type(2)",
	);
});

test("buildSelector：有 id 的段用 tag#id", () => {
	const span = el("span");
	const div = el("div", { id: "card", children: [span] });
	const body = el("body", { children: [div] });
	el("html", { children: [body] });
	expect(buildSelector(span)).toBe(
		"html > body:nth-of-type(1) > div#card > span:nth-of-type(1)",
	);
});

test("displayLabel：有 id 用 tag#id，否则 tag.类名（最多 3 个）", () => {
	const { displayLabel } = require("../src/assets/preview-inspect.js");
	expect(displayLabel({ tagName: "DIV", id: "card", classList: ["a"] })).toBe(
		"div#card",
	);
	expect(
		displayLabel({ tagName: "P", id: "", classList: ["x", "y", "z", "w"] }),
	).toBe("p.x.y.z");
	expect(displayLabel({ tagName: "SPAN", id: "", classList: [] })).toBe("span");
});

test("buildSelector：有 data-testid 用 tag[data-testid]", () => {
	const btn = el("button", { attrs: { "data-testid": "submit" } });
	const div = el("div", { children: [btn] });
	const body = el("body", { children: [div] });
	el("html", { children: [body] });
	expect(buildSelector(btn)).toBe(
		'html > body:nth-of-type(1) > div:nth-of-type(1) > button[data-testid="submit"]',
	);
});

test("elLabel：语义标签 id/data-testid/role 优先", () => {
	const { elLabel } = require("../src/assets/preview-inspect.js");
	expect(
		elLabel({
			tagName: "BUTTON",
			id: "submit",
			classList: [],
			getAttribute: () => null,
		}),
	).toBe("button#submit");
	expect(
		elLabel({
			tagName: "DIV",
			id: "",
			classList: [],
			getAttribute: (n: string) => (n === "data-testid" ? "card" : null),
		}),
	).toBe("div[data-testid=card]");
	expect(
		elLabel({
			tagName: "INPUT",
			id: "",
			classList: [],
			getAttribute: (n: string) => (n === "role" ? "textbox" : null),
		}),
	).toBe("input[role=textbox]");
});

test("buildSelector：元素同时有 id 与 data-testid 时用 id（优先级）", () => {
	const btn = el("button", {
		id: "submit",
		attrs: { "data-testid": "x", role: "btn" },
	});
	const div = el("div", { children: [btn] });
	const body = el("body", { children: [div] });
	el("html", { children: [body] });
	expect(buildSelector(btn)).toBe(
		"html > body:nth-of-type(1) > div:nth-of-type(1) > button#submit",
	);
});

test("buildSelector：外层 id + 内层 role 混合路径", () => {
	const input = el("input", { attrs: { role: "textbox" } });
	const div = el("div", { id: "card", children: [input] });
	const body = el("body", { children: [div] });
	el("html", { children: [body] });
	expect(buildSelector(input)).toBe(
		'html > body:nth-of-type(1) > div#card > input[role="textbox"]',
	);
});

test("elLabel：无 id/testid/role 时回退到 aria-label", () => {
	const { elLabel } = require("../src/assets/preview-inspect.js");
	expect(
		elLabel({
			tagName: "BUTTON",
			id: "",
			classList: [],
			getAttribute: (n: string) => (n === "aria-label" ? "提交" : null),
		}),
	).toBe("button(提交)");
});

test("elLabel：无语义时回退到类名 / 裸标签", () => {
	const { elLabel } = require("../src/assets/preview-inspect.js");
	expect(
		elLabel({
			tagName: "DIV",
			id: "",
			classList: ["a"],
			getAttribute: () => null,
		}),
	).toBe("div.a");
	expect(
		elLabel({
			tagName: "SPAN",
			id: "",
			classList: [],
			getAttribute: () => null,
		}),
	).toBe("span");
});

test("displayLabel：无 id 但 data-testid 时显示语义标签", () => {
	const { displayLabel } = require("../src/assets/preview-inspect.js");
	expect(
		displayLabel({
			tagName: "BUTTON",
			id: "",
			classList: [],
			getAttribute: (n: string) => (n === "data-testid" ? "submit" : null),
		}),
	).toBe("button[data-testid=submit]");
});
