/**
 * 官网双版「TUI 插件兼容与支持」落点测试。
 *
 * 与 README 的 readme-tui-support.test.ts 同口径：官网也要把 TUI 插件兼容讲到
 * 首屏（eyebrow 品类句 + hero 信任行）与特性 / 设置区，并同步更新定位句
 * （pi coding agent 的桌面 GUI 客户端，取代旧的「pi agent 图形化桌面框架」）。
 * 先红后绿：先在当前（改造前）官网文件上跑，再改 website/index.html 与
 * website/index.en.html 让全部用例通过。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const zh = readFileSync(join(root, "website/index.html"), "utf8");
const en = readFileSync(join(root, "website/index.en.html"), "utf8");

/** 取首屏 eyebrow 文案 */
function eyebrow(doc: string): string {
	return doc.match(/<span class="eyebrow"[\s\S]*?<\/span>/)?.[0] ?? "";
}

/** 取首屏信任行 */
function heroTrust(doc: string): string {
	return doc.match(/<div class="hero-trust">[\s\S]*?<\/div>/)?.[0] ?? "";
}

/** 取特性区正文（features 到 settings 之间） */
function features(doc: string): string {
	const start = doc.indexOf('id="features"');
	const end = doc.indexOf('id="settings"');
	return start === -1 || end === -1 ? "" : doc.slice(start, end);
}

/** 取页面 meta description */
function metaDescription(doc: string): string {
	return doc.match(/name="description"[\s\S]*?content="([^"]*)"/)?.[1] ?? "";
}

/** 取设置一览里「插件」卡片正文 */
function pluginCard(doc: string, heading: string): string {
	const start = doc.indexOf(`<h4><span class="ico">🧩</span>${heading}</h4>`);
	if (start === -1) return "";
	const end = doc.indexOf("</ul>", start);
	return end === -1 ? "" : doc.slice(start, end);
}

describe("官网中文版 TUI 插件兼容落点", () => {
	test("① 首屏 eyebrow 改用品类句（pi coding agent 的桌面 GUI 客户端）", () => {
		expect(eyebrow(zh)).toContain("pi coding agent 的桌面 GUI 客户端");
	});

	test("② 首屏信任行含 TUI 插件兼容", () => {
		expect(heroTrust(zh)).toContain("TUI 插件兼容");
	});

	test("③ 特性区含 TUI 插件开箱即用卡片", () => {
		const f = features(zh);
		expect(f).toContain("TUI 插件开箱即用");
		expect(f).toContain("无需修改");
	});

	test("④ 设置一览「插件」卡含 TUI 插件兼容条目", () => {
		const card = pluginCard(zh, "插件");
		expect(card).toContain("TUI");
		expect(card).toContain("无需修改");
	});

	test("⑤ 页面 meta description 更新为品类句并含 TUI 插件", () => {
		const meta = metaDescription(zh);
		expect(meta).toContain("pi coding agent 的桌面 GUI 客户端");
		expect(meta).toContain("TUI 插件");
	});
});

describe("官网英文版 TUI 插件兼容落点", () => {
	test("① 首屏 eyebrow 改用品类句（desktop GUI client for the pi coding agent）", () => {
		expect(eyebrow(en)).toContain("Desktop GUI client for the pi coding agent");
	});

	test("② 首屏信任行含 TUI plugin compatible", () => {
		expect(heroTrust(en)).toContain("TUI plugin compatible");
	});

	test("③ 特性区含 TUI plugins work out of the box 卡片", () => {
		const f = features(en);
		expect(f).toContain("TUI plugins work out of the box");
		expect(f).toContain("unchanged");
	});

	test("④ 设置一览「Plugins」卡含 TUI plugin compatible 条目", () => {
		const card = pluginCard(en, "Plugins");
		expect(card).toMatch(/TUI/);
		expect(card).toContain("unchanged");
	});

	test("⑤ 页面 meta description 更新为品类句并含 TUI plugins", () => {
		const meta = metaDescription(en);
		expect(meta).toContain("desktop GUI client for the pi coding agent");
		expect(meta).toContain("TUI plugins");
	});
});

describe("官网双版一致性与不倒退（反向断言）", () => {
	test("反向：不得残留旧定位句（图形化桌面框架 / Graphical desktop framework）", () => {
		expect(zh).not.toContain("pi agent 图形化桌面框架");
		expect(en).not.toContain("Graphical desktop framework for pi agent");
	});

	test("反向：不得把 TUI 插件写成不支持", () => {
		for (const doc of [zh, en]) {
			expect(doc).not.toContain("TUI 插件不支持");
			expect(doc).not.toMatch(/TUI plugins? (?:are )?not supported/i);
		}
	});

	test("双版首屏与特性/设置区落点数量一致", () => {
		const hit = (doc: string, heading: string): number =>
			[eyebrow(doc), heroTrust(doc), features(doc), pluginCard(doc, heading), metaDescription(doc)].filter(
				(part) => /TUI/i.test(part),
			).length;
		expect(hit(zh, "插件")).toBe(4);
		expect(hit(en, "Plugins")).toBe(4);
	});
});
