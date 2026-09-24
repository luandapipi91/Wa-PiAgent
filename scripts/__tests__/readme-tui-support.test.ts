/**
 * README 双版「TUI 插件兼容与支持」落点测试。
 *
 * 背景：wa-pi 兼容 pi 的 TUI 插件（为 pi CLI 编写的扩展无需修改，状态栏 / Widget /
 * 对话框 / 通知等 UI 原语以 GUI 原生组件呈现）。此前该能力只出现在「插件生态」小节
 * 的一条 bullet 里，改造前先写本测试（先红后绿），要求它同时出现在 5 个位置：
 *   ① 首屏 tagline 区 ② 首段（What is this / 这是什么）③ 特性摘要行
 *   ④ FAQ（常见问题）⑤ Why-a-GUI 对比表
 * 并断言中英双版落点数量一致、原有品类关键词没被 TUI 表述挤掉。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const en = readFileSync(join(root, "README.md"), "utf8");
const zh = readFileSync(join(root, "README.zh-CN.md"), "utf8");

/** 首个二级标题之前的首屏区（tagline + 徽章 + 导航行） */
function hero(doc: string): string {
	const end = doc.indexOf("\n## ");
	return end === -1 ? doc : doc.slice(0, end);
}

/** 取某个二级标题到下一个同级标题之间的正文 */
function section(doc: string, heading: string): string {
	const marker = `\n## ${heading}`;
	const start = doc.indexOf(marker);
	if (start === -1) return "";
	const rest = doc.slice(start + marker.length);
	const end = rest.indexOf("\n## ");
	return end === -1 ? rest : rest.slice(0, end);
}

/** 特性摘要行（hero 里的「·」分隔行） */
function summaryLine(doc: string): string {
	return hero(doc)
		.split("\n")
		.find((line) => line.includes(" · ")) ?? "";
}

const enHero = hero(en);
const zhHero = hero(zh);
const enIntro = section(en, "What is this");
const zhIntro = section(zh, "这是什么");
const enFaq = section(en, "FAQ");
const zhFaq = section(zh, "常见问题");
const enTable = section(en, "Why a GUI instead of the pi CLI");
const zhTable = section(zh, "为什么用 GUI，而不是直接用 pi CLI");

describe("README.md（英文）TUI 插件兼容落点", () => {
	test("① 首屏 tagline 区写出 TUI 插件兼容", () => {
		expect(enHero).toMatch(/TUI/i);
		expect(enHero).toMatch(/plugins?/i);
		expect(enHero).toMatch(/unchanged/i);
	});

	test("① 首屏写明 TUI 原语以 GUI 原生组件呈现", () => {
		for (const token of ["status bars", "widgets", "dialogs", "notifications"]) {
			expect(enHero.toLowerCase()).toContain(token);
		}
		expect(enHero).toMatch(/native GUI/i);
	});

	test("② 首段（What is this）写出 TUI 插件可原样运行", () => {
		expect(enIntro).toMatch(/TUI/i);
		expect(enIntro).toMatch(/unchanged/i);
	});

	test("③ 特性摘要行含 TUI 兼容项", () => {
		const line = summaryLine(en);
		expect(line).toContain("TUI");
	});

	test("④ FAQ 有 TUI 兼容问答", () => {
		expect(enFaq).toMatch(/TUI/i);
		expect(enFaq).toMatch(/unchanged/i);
	});

	test("⑤ Why-a-GUI 对比表有 TUI 行", () => {
		expect(enTable).toMatch(/\|.*TUI.*\|/i);
	});
});

describe("README.zh-CN.md（中文）TUI 插件兼容落点", () => {
	test("① 首屏 tagline 区写出 TUI 插件兼容", () => {
		expect(zhHero).toMatch(/TUI/);
		expect(zhHero).toContain("插件");
		expect(zhHero).toContain("无需修改");
	});

	test("① 首屏写明 TUI 原语以 GUI 原生组件呈现", () => {
		for (const token of ["状态栏", "Widget", "对话框", "通知"]) {
			expect(zhHero).toContain(token);
		}
		expect(zhHero).toContain("原生");
	});

	test("② 首段（这是什么）写出 TUI 插件可原样运行", () => {
		expect(zhIntro).toContain("TUI");
		expect(zhIntro).toContain("无需修改");
	});

	test("③ 特性摘要行含 TUI 兼容项", () => {
		const line = summaryLine(zh);
		expect(line).toContain("TUI");
	});

	test("④ 常见问题有 TUI 兼容问答", () => {
		expect(zhFaq).toContain("TUI");
		expect(zhFaq).toContain("无需修改");
	});

	test("⑤ Why-a-GUI 对比表有 TUI 行", () => {
		expect(zhTable).toMatch(/\|.*TUI.*\|/);
	});
});

describe("双版一致性与不倒退（反向断言）", () => {
	test("中英两版的 5 处落点一一对应（数量一致）", () => {
		const count = (doc: string, heads: [string, string]): number =>
			[hero(doc), section(doc, heads[0]), summaryLine(doc), section(doc, heads[1])].filter(
				(part) => /TUI/i.test(part),
			).length;
		expect(count(en, ["What is this", "FAQ"])).toBe(4);
		expect(count(zh, ["这是什么", "常见问题"])).toBe(4);
	});

	test("反向：不得把 TUI 兼容写成不支持 / 需要改造", () => {
		for (const doc of [en, zh]) {
			expect(doc).not.toMatch(/TUI plugins? (?:are )?not supported/i);
			expect(doc).not.toMatch(/does not support TUI/i);
			expect(doc).not.toContain("不支持 TUI");
			expect(doc).not.toContain("TUI 插件不支持");
		}
	});

	test("反向：不得出现「需要改造 TUI 插件」的误导表述", () => {
		expect(en).not.toMatch(/TUI plugins? (?:must|need to) be (?:rewritten|ported|adapted)/i);
		expect(zh).not.toMatch(/TUI 插件(?:必须|需要)(?:改造|重写|适配)/);
	});

	test("反向：品类关键词句不因新增 TUI 表述被挤掉", () => {
		expect(en).toContain("desktop GUI client for the [pi](https://github.com/earendil-works) coding agent");
		expect(zh).toContain("coding agent 的**桌面 GUI 客户端**");
	});

	test("反向：原有的 TUI 兼容 bullet 仍保留在插件生态小节", () => {
		expect(section(en, "Key features")).toContain("TUI plugins work out of the box");
		expect(section(zh, "核心特性")).toContain("TUI 插件开箱即用");
	});
});
