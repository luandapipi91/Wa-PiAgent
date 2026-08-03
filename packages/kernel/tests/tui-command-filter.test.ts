import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	filterTuiCommands,
	isCommandDisabled,
	isTuiOnlyExtension,
	resetDisabledCommands,
	type RawCommandInfo,
} from "../src/tui-command-filter";

// 每个用例独立的临时扩展目录：tui-ext 含 ui.custom( 调用，plain-ext 不含
let root: string;
let tuiEntry: string;
let plainEntry: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "tui-filter-"));

	const tuiDir = join(root, "tui-ext");
	mkdirSync(join(tuiDir, "lib"), { recursive: true });
	writeFileSync(
		join(tuiDir, "package.json"),
		JSON.stringify({ name: "tui-ext" }),
	);
	writeFileSync(join(tuiDir, "index.ts"), `export const x = 1;\n`);
	// ui.custom 藏在同包子文件的辅助函数里（模拟 pi-mcp-adapter 的 openMcpAuthPanel）
	writeFileSync(
		join(tuiDir, "lib", "panel.ts"),
		`export function openPanel(ctx: any) {\n  ctx.ui.custom(() => {});\n}\n`,
	);
	tuiEntry = join(tuiDir, "index.ts");

	const plainDir = join(root, "plain-ext");
	mkdirSync(plainDir, { recursive: true });
	writeFileSync(
		join(plainDir, "package.json"),
		JSON.stringify({ name: "plain-ext" }),
	);
	writeFileSync(join(plainDir, "index.ts"), `export const y = 2;\n`);
	plainEntry = join(plainDir, "index.ts");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function cmd(
	name: string,
	source: RawCommandInfo["source"],
	path?: string,
): RawCommandInfo {
	return {
		name,
		source,
		sourceInfo: path ? { path } : undefined,
	};
}

test("isTuiOnlyExtension: 命中子文件里的 ui.custom( 调用", () => {
	expect(isTuiOnlyExtension(tuiEntry)).toBe(true);
	expect(isTuiOnlyExtension(plainEntry)).toBe(false);
});

test("isTuiOnlyExtension: 命中带泛型参数的 ui.custom<T>( 调用（pi-open-agents 形式）", () => {
	// pi-open-agents 的 selector.ts 使用 ctx.ui.custom<string | null>(...)，
	// 正则必须允许 custom 与左括号之间存在泛型参数，否则过滤漏判。
	const genDir = join(root, "generic-ext");
	mkdirSync(genDir, { recursive: true });
	writeFileSync(
		join(genDir, "package.json"),
		JSON.stringify({ name: "generic-ext" }),
	);
	writeFileSync(
		join(genDir, "panel.ts"),
		`export function openPanel(ctx: any) {\n  return ctx.ui.custom<string | null>((tui) => {\n    tui.render();\n  });\n}\n`,
	);
	expect(isTuiOnlyExtension(join(genDir, "panel.ts"))).toBe(true);
});

test("isTuiOnlyExtension: 命中 ui.custom 带空格再泛型的调用", () => {
	const genDir = join(root, "generic-spaced-ext");
	mkdirSync(genDir, { recursive: true });
	writeFileSync(
		join(genDir, "package.json"),
		JSON.stringify({ name: "generic-spaced-ext" }),
	);
	writeFileSync(
		join(genDir, "panel.ts"),
		`export function openPanel(ctx: any) {\n  return ctx.ui.custom < string > ((tui) => {\n    tui.render();\n  });\n}\n`,
	);
	expect(isTuiOnlyExtension(join(genDir, "panel.ts"))).toBe(true);
});

test("isTuiOnlyExtension: 命中其他 TUI 对话 API（ui.input / ui.select / ui.confirm / ui.editor）", () => {
	// 不只用 ui.custom 的扩展会被漏判（如 handler 直接 ctx.ui.input(...) 无参数交互），
	// 这些 API 在 RPC 模式下同样不可用，必须一并识别。
	const cases = [
		["input", `return ctx.ui.input("Search:");`],
		["select", `return ctx.ui.select("Pick:", []);`],
		["confirm", `return ctx.ui.confirm("Sure?");`],
		["editor", `return ctx.ui.editor("Edit:", "");`],
	];
	for (const [name, body] of cases) {
		const dir = join(root, `tui-api-${name}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `tui-api-${name}` }));
		writeFileSync(join(dir, "panel.ts"), `export const open = (ctx: any) => ${body}\n`);
		expect(isTuiOnlyExtension(join(dir, "panel.ts"))).toBe(true);
	}
});

test("filterTuiCommands: TUI-only 命令不再删除，附加 tuiOnly: true 标记", () => {
	const commands: RawCommandInfo[] = [
		cmd("mcp-auth", "extension", tuiEntry),
		cmd("hello", "extension", plainEntry),
		cmd("review", "prompt"),
		cmd("goal", "extension"), // 无 sourceInfo → 原样保留
	];
	const result = filterTuiCommands(commands);
	expect(result).toHaveLength(4);
	expect(result.find((c) => c.name === "mcp-auth")?.tuiOnly).toBe(true);
	expect(result.find((c) => c.name === "hello")?.tuiOnly).toBe(false);
	expect(result.find((c) => c.name === "review")?.tuiOnly).toBeUndefined();
	expect(result.find((c) => c.name === "goal")?.tuiOnly).toBeUndefined();
});

test("isCommandDisabled / resetDisabledCommands: 初始为空，reset 可重复调用", () => {
	// 登记逻辑由后续任务接 settings 后实现；此处仅验证集合为空且 reset 不抛错
	expect(isCommandDisabled("mcp-auth")).toBe(false);
	expect(() => resetDisabledCommands()).not.toThrow();
	expect(() => resetDisabledCommands()).not.toThrow();
	expect(isCommandDisabled("mcp-auth")).toBe(false);
});

test("filterTuiCommands: 非 extension 来源不看 sourceInfo 也保留", () => {
	const commands: RawCommandInfo[] = [cmd("tpl", "prompt", tuiEntry)];
	expect(filterTuiCommands(commands)).toHaveLength(1);
});
