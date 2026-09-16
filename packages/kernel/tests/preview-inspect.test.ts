import { test, expect } from "bun:test";
import {
	injectInspectScript,
	INSPECT_SCRIPT_TAG,
} from "../src/preview-inspect";

// UMD：node/bun 下 require 拿到纯函数 buildSelector
const { buildSelector } = require("../src/assets/preview-inspect.js");

// ── parsePreviewPathname：从 /preview/<encDir>/<encRel> 还原磁盘绝对路径 ──
// 嵌套 iframe 场景：内层页面向上层回传选中元素时，需携带自身真实文件路径，
// 否则主应用会用外层页面路径去定位行号、查错文件。
const { parsePreviewPathname } = require("../src/assets/preview-inspect.js");

test("parsePreviewPathname：常规编码路径还原为磁盘绝对路径", () => {
	expect(
		parsePreviewPathname("/preview/%2FUsers%2Fco%2Fproj%2Fwww/inner.html"),
	).toBe("/Users/co/proj/www/inner.html");
});

test("parsePreviewPathname：文件名含空格/中文等编码字符", () => {
	expect(
		parsePreviewPathname(
			"/preview/%2FC%3A%5Fproj%2Fpage%20one/%E9%A1%B5%E9%9D%A2.html",
		),
	).toBe("/C:_proj/page one/页面.html");
});

test("parsePreviewPathname：深层相对段一并还原", () => {
	expect(parsePreviewPathname("/preview/%2Fhome%2Fu%2Fapp/sub/dir/x.html")).toBe(
		"/home/u/app/sub/dir/x.html",
	);
});

test("parsePreviewPathname：非 /preview 前缀 → null", () => {
	expect(parsePreviewPathname("/other/a.html")).toBeNull();
	expect(parsePreviewPathname("/preview")).toBeNull();
	expect(parsePreviewPathname("/preview/")).toBeNull();
});

test("parsePreviewPathname：非法 % 序列（解码失败）→ null", () => {
	expect(parsePreviewPathname("/preview/%2Fhome%2Fu/bad%.html")).toBeNull();
});

// ── injectInspectIntoFrames：srcdoc/about:blank 型子 iframe 由父页代注入 ──
// 背景：srcdoc 子 iframe 不发 HTTP 请求，kernel 无从注入，子文档内无脚本 → 选中失效；
// 子文档继承父源可达，由父页脚本代注入（createScript 由调用方提供，测试可观测）。
test("injectInspectIntoFrames：可达且未初始化的子 iframe 被注入", () => {
	const {
		injectInspectIntoFrames,
	} = require("../src/assets/preview-inspect.js");
	const injectedDocs: any[] = [];
	const child = {
		contentDocument: {
			documentElement: {},
			defaultView: {}, // 无 __hiagentInspect
		},
	};
	const n = injectInspectIntoFrames([child], (doc: any) => {
		injectedDocs.push(doc);
		return true;
	});
	expect(n).toBe(1);
	expect(injectedDocs).toHaveLength(1);
	expect(injectedDocs[0]).toBe(child.contentDocument);
});

test("injectInspectIntoFrames：已初始化（__hiagentInspect）不重复注入", () => {
	const {
		injectInspectIntoFrames,
	} = require("../src/assets/preview-inspect.js");
	const child = {
		contentDocument: {
			documentElement: {},
			defaultView: { __hiagentInspect: true },
		},
	};
	expect(injectInspectIntoFrames([child], () => true)).toBe(0);
});

test("injectInspectIntoFrames：跨源（contentDocument 抛异常）/未就绪（null）静默跳过", () => {
	const {
		injectInspectIntoFrames,
	} = require("../src/assets/preview-inspect.js");
	const calls: any[] = [];
	const create = (doc: any) => {
		calls.push(doc);
		return true;
	};
	const crossOrigin = {
		get contentDocument(): Document {
			throw new Error("blocked");
		},
	};
	const notReady = { contentDocument: null };
	const noRoot = { contentDocument: {} }; // 无 documentElement（加载中）
	expect(injectInspectIntoFrames([crossOrigin, notReady, noRoot], create)).toBe(
		0,
	);
	expect(calls).toHaveLength(0);
});

test("injectInspectIntoFrames：单个注入失败不阻断其余（静默降级）", () => {
	const {
		injectInspectIntoFrames,
	} = require("../src/assets/preview-inspect.js");
	const ok = { contentDocument: { documentElement: {}, defaultView: {} } };
	const bad = { contentDocument: { documentElement: {}, defaultView: {} } };
	const create = (doc: any) => {
		if (doc === bad.contentDocument) throw new Error("CSP 拦截等");
		return true;
	};
	expect(injectInspectIntoFrames([bad, ok], create)).toBe(1);
});

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

// ── srcdoc 型 iframe：内容内联在属性里不发 HTTP 请求，kernel 无从注入；
// 且 sandbox 无 allow-same-origin 时父层 contentDocument 被阻断、无法代注入 ——
// 唯一可控的注入面就是外层 HTML 文本本身：把转义态的 script 标签插进 srcdoc 属性值。
test("注入：srcdoc 属性内容插入转义脚本（</head> 前）", () => {
	const srcdoc =
		"&lt;!doctype html&gt;&lt;html&gt;&lt;head&gt;&lt;title&gt;t&lt;/title&gt;&lt;/head&gt;&lt;body&gt;hi&lt;/body&gt;&lt;/html&gt;";
	const out = injectInspectScript(`<iframe srcdoc="${srcdoc}"></iframe>`);
	const escaped =
		"&lt;script src=&quot;/preview-inspect.js&quot;&gt;&lt;/script&gt;";
	expect(out).toContain(`&lt;title&gt;t&lt;/title&gt;${escaped}&lt;/head&gt;`);
});

test("注入：srcdoc 无 head 段时插到属性值最前", () => {
	const srcdoc = "&lt;body&gt;hi&lt;/body&gt;";
	const out = injectInspectScript(`<iframe srcdoc="${srcdoc}"></iframe>`);
	const escaped =
		"&lt;script src=&quot;/preview-inspect.js&quot;&gt;&lt;/script&gt;";
	expect(out).toContain(`srcdoc="${escaped}&lt;body&gt;`);
});

test("注入：srcdoc 大小写不敏感（&lt;/HEAD&gt;）", () => {
	const srcdoc = "&lt;head&gt;&lt;/HEAD&gt;&lt;body&gt;&lt;/body&gt;";
	const out = injectInspectScript(`<iframe SRCDOC="${srcdoc}"></iframe>`);
	const escaped =
		"&lt;script src=&quot;/preview-inspect.js&quot;&gt;&lt;/script&gt;";
	expect(out.toLowerCase()).toContain(`${escaped}&lt;/head&gt;`.toLowerCase());
	// 且脚本在 &lt;head&gt; 之后（紧贴 </head> 前）
	expect(out).toContain(`&lt;head&gt;${escaped}&lt;/HEAD&gt;`);
});

test("注入：单引号 srcdoc 属性同样处理", () => {
	const srcdoc = "&lt;p&gt;hi&lt;/p&gt;";
	const out = injectInspectScript(`<iframe srcdoc='${srcdoc}'></iframe>`);
	const escaped =
		"&lt;script src=&#39;/preview-inspect.js&#39;&gt;&lt;/script&gt;";
	expect(out).toContain(`srcdoc='${escaped}&lt;p&gt;`);
});

test("注入：外层文档正常注入且 srcdoc 同时注入（两层都要）", () => {
	const srcdoc = "&lt;head&gt;&lt;/head&gt;";
	const html = `<html><head></head><body><iframe srcdoc="${srcdoc}"></iframe></body></html>`;
	const out = injectInspectScript(html);
	// 外层：真实脚本标签插在 </head> 前
	expect(out).toContain(`${INSPECT_SCRIPT_TAG}</head>`);
	// 内层：转义脚本插在 srcdoc 值内（紧贴转义 </head> 前）
	expect(out).toContain(
		`srcdoc="&lt;head&gt;&lt;script src=&quot;/preview-inspect.js&quot;&gt;&lt;/script&gt;&lt;/head&gt;"`,
	);
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

// ── clampRectToViewport：把文档坐标矩形平移/收缩到视口内（尺寸不变仅平移） ──
test("clampRectToViewport：正常在视口内 → 不动", () => {
	const { clampRectToViewport } = require("../src/assets/preview-inspect.js");
	expect(clampRectToViewport(100, 100, 200, 60, 800, 600)).toEqual({
		left: 100,
		top: 100,
		width: 200,
		height: 60,
	});
});

test("clampRectToViewport：元素在右侧边缘 → left 钳到视口内", () => {
	const { clampRectToViewport } = require("../src/assets/preview-inspect.js");
	// 元素 left=750，宽 200，右缘 950 > 视口宽 800 → left 钳到 800-200=600
	expect(clampRectToViewport(750, 100, 200, 60, 800, 600)).toEqual({
		left: 600,
		top: 100,
		width: 200,
		height: 60,
	});
});

test("clampRectToViewport：元素在底部边缘 → top 钳到视口内", () => {
	const { clampRectToViewport } = require("../src/assets/preview-inspect.js");
	// 元素 top=580，高 60，底缘 640 > 视口高 600 → top 钳到 600-60=540
	expect(clampRectToViewport(100, 580, 200, 60, 800, 600)).toEqual({
		left: 100,
		top: 540,
		width: 200,
		height: 60,
	});
});

test("clampRectToViewport：元素在左侧/顶部边缘（负坐标）→ 钳到 0", () => {
	const { clampRectToViewport } = require("../src/assets/preview-inspect.js");
	expect(clampRectToViewport(-50, -30, 200, 60, 800, 600)).toEqual({
		left: 0,
		top: 0,
		width: 200,
		height: 60,
	});
});

test("clampRectToViewport：元素宽 > 视口 → 收缩到视口宽", () => {
	const { clampRectToViewport } = require("../src/assets/preview-inspect.js");
	// 元素 left=0，宽 1200 > 800，left 钳到 0，宽收缩到 800
	expect(clampRectToViewport(0, 100, 1200, 60, 800, 600)).toEqual({
		left: 0,
		top: 100,
		width: 800,
		height: 60,
	});
});

test("clampRectToViewport：元素高 > 视口 → 收缩到视口高", () => {
	const { clampRectToViewport } = require("../src/assets/preview-inspect.js");
	expect(clampRectToViewport(100, 0, 200, 900, 800, 600)).toEqual({
		left: 100,
		top: 0,
		width: 200,
		height: 600,
	});
});

// ── layoutOverlayInPage（视口系 clamp + 滚动偏移 → absolute 遮罩层页面坐标）──
// 回归：clamp 必须发生在视口坐标系；此前误把「文档坐标」按视口范围收敛，
// 页面滚动后高亮框被拉回文档首屏、视觉上「消失」。
test("layoutOverlayInPage：未滚动时结果等于视口内 clamp", () => {
	const { layoutOverlayInPage } = require("../src/assets/preview-inspect.js");
	expect(layoutOverlayInPage(100, 300, 200, 80, 0, 0, 800, 600)).toEqual({
		left: 100,
		top: 300,
		width: 200,
		height: 80,
	});
});

test("layoutOverlayInPage：滚动后（scrollY>0）框落在元素实际页面位置，不被拉回首屏", () => {
	const { layoutOverlayInPage } = require("../src/assets/preview-inspect.js");
	// 视口 800x600，已滚动 scrollY=2000；元素显示在屏幕中间 r.top=300
	// 正确：页面 top = 300+2000 = 2300（贴合元素）
	// 错误（修复前）：把 2300 当视口坐标 clamp → ≤600-height，框画到首屏
	expect(layoutOverlayInPage(100, 300, 200, 80, 0, 2000, 800, 600)).toEqual({
		left: 100,
		top: 2300,
		width: 200,
		height: 80,
	});
});

test("layoutOverlayInPage：底部边缘元素在视口系上移贴边后再加偏移", () => {
	const { layoutOverlayInPage } = require("../src/assets/preview-inspect.js");
	// 元素 r.top=560、高 80，超出视口底缘(600) 40px → 视口系 top 收敛到 520，再加 sy
	expect(layoutOverlayInPage(50, 560, 200, 80, 30, 1500, 800, 600)).toEqual({
		left: 80,
		top: 2020,
		width: 200,
		height: 80,
	});
});
