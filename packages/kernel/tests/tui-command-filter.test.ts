import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterTuiCommands, isTuiOnlyExtension, type RawCommandInfo } from "../src/tui-command-filter";

// 每个用例独立的临时扩展目录：tui-ext 含 ui.custom( 调用，plain-ext 不含
let root: string;
let tuiEntry: string;
let plainEntry: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "tui-filter-"));

	const tuiDir = join(root, "tui-ext");
	mkdirSync(join(tuiDir, "lib"), { recursive: true });
	writeFileSync(join(tuiDir, "package.json"), JSON.stringify({ name: "tui-ext" }));
	writeFileSync(join(tuiDir, "index.ts"), `export const x = 1;\n`);
	// ui.custom 藏在同包子文件的辅助函数里（模拟 pi-mcp-adapter 的 openMcpAuthPanel）
	writeFileSync(
		join(tuiDir, "lib", "panel.ts"),
		`export function openPanel(ctx: any) {\n  ctx.ui.custom(() => {});\n}\n`,
	);
	tuiEntry = join(tuiDir, "index.ts");

	const plainDir = join(root, "plain-ext");
	mkdirSync(plainDir, { recursive: true });
	writeFileSync(join(plainDir, "package.json"), JSON.stringify({ name: "plain-ext" }));
	writeFileSync(join(plainDir, "index.ts"), `export const y = 2;\n`);
	plainEntry = join(plainDir, "index.ts");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function cmd(name: string, source: RawCommandInfo["source"], path?: string): RawCommandInfo {
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

test("filterTuiCommands: 过滤 TUI-only 扩展的命令，保留其余", () => {
	const commands: RawCommandInfo[] = [
		cmd("mcp-auth", "extension", tuiEntry),
		cmd("hello", "extension", plainEntry),
		cmd("review", "prompt"),
		cmd("goal", "extension"), // 无 sourceInfo → 保留
	];
	const names = filterTuiCommands(commands).map((c) => c.name);
	expect(names).toEqual(["hello", "review", "goal"]);
});

test("filterTuiCommands: 非 extension 来源不看 sourceInfo 也保留", () => {
	const commands: RawCommandInfo[] = [cmd("tpl", "prompt", tuiEntry)];
	expect(filterTuiCommands(commands)).toHaveLength(1);
});
