import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

// 仓库内真实的插件入口（examples/ext-ui-bridge-demo）：用于验证真实文件路径不被误伤
const demoEntry = fileURLToPath(
	new URL("../../../examples/ext-ui-bridge-demo/index.ts", import.meta.url),
);

describe("内置扩展命令：**保留并打标**（不剔除，展示层自己过滤）", () => {
	test("sourceInfo.path 以 builtin: 开头的命令被标记 builtinExtension，且仍是 extension 来源", () => {
		const out = attachPackageName([
			{
				name: "mcp",
				description: "Manage MCP servers",
				source: "extension",
				sourceInfo: {
					path: "builtin:mcp",
					source: "builtin",
					scope: "temporary",
					origin: "top-level",
				},
			},
			{
				name: "llama",
				source: "extension",
				sourceInfo: { path: "builtin:llama.cpp", source: "builtin" },
			},
		]);
		// 必须保留：pi 会**拦截执行**它们（不产生 user 消息），剔除会让「这条命令会不会被 pi
		// 拦截」的判定失去依据，于是聊天窗凭空多出一条并不存在的用户消息（回归：/mcp 气泡）。
		expect(out.map((c) => c.name)).toEqual(["mcp", "llama"]);
		expect(out.map((c) => c.builtinExtension)).toEqual([true, true]);
		// 回显抑制按 source === "extension" 判定，标记不得改动来源
		expect(out.every((c) => c.source === "extension")).toBe(true);
		// 内置命令无归属包 → 不进「附加命令」弹窗（该弹窗按 packageName 过滤）
		expect(out.every((c) => c.packageName === undefined)).toBe(true);
	});

	test("真实文件路径的扩展命令仍被保留并附包名（不误伤，且不带 builtinExtension）", () => {
		const out = attachPackageName([
			{
				name: "uidemo",
				description: "x",
				source: "extension",
				sourceInfo: { path: demoEntry, origin: "top-level" },
			},
			{ name: "goal", source: "extension", sourceInfo: { path: goalEntry } },
		]);
		expect(out.map((c) => c.name)).toEqual(["uidemo", "goal"]);
		expect(out[0].packageName).toBe("ext-ui-bridge-demo");
		expect(out[1].packageName).toBe("goal-ext");
		expect(out.every((c) => c.builtinExtension !== true)).toBe(true);
	});

	test("混合清单：仅内置命令打标，prompt/skill/无 sourceInfo 的 extension 命令不受影响", () => {
		const out = attachPackageName([
			cmd("mcp", "extension", "builtin:mcp"),
			cmd("llama", "extension", "builtin:llama.cpp"),
			cmd("goal", "extension", goalEntry),
			cmd("review", "prompt", "E:/tpl/review.md"),
			cmd("skill:x", "skill", "E:/skills/x/SKILL.md"),
			{ name: "__!wa_pi_reload", source: "extension" },
		]);
		expect(out.map((c) => c.name)).toEqual([
			"mcp",
			"llama",
			"goal",
			"review",
			"skill:x",
			"__!wa_pi_reload",
		]);
		expect(out.filter((c) => c.builtinExtension === true).map((c) => c.name)).toEqual([
			"mcp",
			"llama",
		]);
		expect(out[2].packageName).toBe("goal-ext");
	});

	test("wa-pi-bridge 不再包含针对 /mcp 的 custom() 兜底补丁", () => {
		const src = readFileSync(
			new URL("../src/wa-pi-bridge.extension.ts", import.meta.url),
			"utf8",
		);
		expect(src).not.toContain("openMcpPanel");
		expect(src).not.toContain("pi-mcp-adapter");
		expect(src).not.toContain("custom-unsupported");
	});
});
