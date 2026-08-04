import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	attachPackageName,
	type RawCommandInfo,
} from "../src/tui-command-filter";

// 每个用例独立的临时扩展目录：goal-ext 含 package.json，no-pkg-ext 不含
let root: string;
let goalEntry: string;
let noPkgEntry: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pkg-name-"));

	const goalDir = join(root, "goal-ext");
	mkdirSync(goalDir, { recursive: true });
	writeFileSync(
		join(goalDir, "package.json"),
		JSON.stringify({ name: "goal-ext" }),
	);
	writeFileSync(join(goalDir, "index.ts"), `export const x = 1;\n`);
	goalEntry = join(goalDir, "index.ts");

	const noPkgDir = join(root, "no-pkg-ext");
	mkdirSync(noPkgDir, { recursive: true });
	writeFileSync(join(noPkgDir, "index.ts"), `export const z = 3;\n`);
	noPkgEntry = join(noPkgDir, "index.ts");
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

test("attachPackageName 给 extension 命令附加包名，非 extension 原样返回", () => {
	const commands: RawCommandInfo[] = [
		cmd("goal", "extension", goalEntry),
		cmd("review", "prompt"),
	];
	const result = attachPackageName(commands);
	expect(result.find((c) => c.name === "goal")?.packageName).toBe("goal-ext");
	expect(result.find((c) => c.name === "review")?.packageName).toBeUndefined();
});

test("attachPackageName: 非 extension 来源即使有 sourceInfo 也不填 packageName", () => {
	const commands: RawCommandInfo[] = [cmd("tpl", "prompt", goalEntry)];
	const result = attachPackageName(commands);
	expect(result).toHaveLength(1);
	expect(result[0].packageName).toBeUndefined();
});

test("attachPackageName: 无 sourceInfo 的 extension 命令原样返回", () => {
	const commands: RawCommandInfo[] = [cmd("goal", "extension")];
	const result = attachPackageName(commands);
	expect(result[0].packageName).toBeUndefined();
});

test("attachPackageName: package.json 缺失时 packageName 静默为 undefined", () => {
	// 无 package.json 的扩展目录：resolvePackageName 读不到 name，静默降级不抛错
	const commands: RawCommandInfo[] = [cmd("z", "extension", noPkgEntry)];
	const result = attachPackageName(commands);
	expect(result[0].packageName).toBeUndefined();
});

test("attachPackageName: 不产生 tuiOnly 字段", () => {
	const commands: RawCommandInfo[] = [cmd("goal", "extension", goalEntry)];
	const result = attachPackageName(commands);
	expect("tuiOnly" in result[0]).toBe(false);
});
