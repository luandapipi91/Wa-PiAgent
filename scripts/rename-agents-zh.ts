#!/usr/bin/env bun
/**
 * 把 docs/references/awesome-chatgpt-prompts/agents/ 下的角色名
 * 从英文替换为中文可读角色名。
 *
 * 做法：
 *  1. 读取 .spike/zh-map-all.json（英文 displayName -> 中文 displayName）
 *  2. 对每个 agent 文件：更新 frontmatter displayName、保留 # Original: <英文名> 注释、
 *     正文不变；文件名同步改为中文（冲突自动追加 -2/-3）
 *  3. 幂等：已含 # Original 注释的文件跳过（避免重复执行叠加后缀）
 *
 * 用法：bun scripts/rename-agents-zh.ts [--dry-run]
 */
import { readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const AGENTS_DIR = join(ROOT, "docs/references/awesome-chatgpt-prompts/agents");
const MAP_PATH = join(
	ROOT,
	"docs/references/awesome-chatgpt-prompts/zh-name-map.json",
);

const DRY_RUN = process.argv.includes("--dry-run");

/** 清洗为合法文件名/displayName（与 split-prompts.ts 同规则） */
const ILLEGAL_NAME_CHARS = /[/\\:*?"<>|]/g;
const RESERVED_NAMES = new Set([
	"CON",
	"PRN",
	"AUX",
	"NUL",
	"COM1",
	"COM2",
	"COM3",
	"COM4",
	"COM5",
	"COM6",
	"COM7",
	"COM8",
	"COM9",
	"LPT1",
	"LPT2",
	"LPT3",
	"LPT4",
	"LPT5",
	"LPT6",
	"LPT7",
	"LPT8",
	"LPT9",
]);

export function sanitizeName(raw: string, fallback: string): string {
	let s = raw
		.replace(ILLEGAL_NAME_CHARS, "-")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[. ]+$/, "");
	const stem = s.split(".")[0].toUpperCase();
	if (!s || s === "." || s === ".." || RESERVED_NAMES.has(stem)) s = fallback;
	const MAX_NAME = 120;
	if ([...s].length > MAX_NAME) s = [...s].slice(0, MAX_NAME).join("");
	return s;
}

/** 替换 frontmatter 里的 displayName（只替换第一个），并在文件开头插入 # Original 注释 */
export function applyRenameToContent(
	content: string,
	displayName: string,
	originalName: string,
): string {
	const originalComment = `# Original: ${originalName}`;
	// 幂等：已含相同 Original 注释时不重复插入
	const withComment = content.includes(originalComment)
		? content
		: content.replace(/(^---\n)/, `$1${originalComment}\n`);
	return withComment.replace(
		/^displayName: .*$/m,
		`displayName: ${displayName}`,
	);
}

function main() {
	// 映射文件不存在时：已全部转换（幂等）则正常退出，否则报错提示
	let map: Record<string, string>;
	try {
		map = JSON.parse(readFileSync(MAP_PATH, "utf8"));
	} catch {
		const allDone = readdirSync(AGENTS_DIR)
			.filter((f) => f.endsWith(".md"))
			.every((f) =>
				readFileSync(join(AGENTS_DIR, f), "utf8").includes("# Original:"),
			);
		if (allDone) {
			console.log(`映射文件不存在，但 ${AGENTS_DIR} 已全部中文化，无需转换`);
			return;
		}
		console.error(
			`缺少映射文件: ${MAP_PATH}（首次转换前需先生成 zh-name-map.json）`,
		);
		process.exit(1);
	}
	const files = readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"));
	console.log(`目录文件数: ${files.length}`);

	// 幂等：已带 # Original: 注释的视为已完成
	const todo: { oldFile: string; zhName: string; content: string }[] = [];
	let already = 0;
	let unmapped = 0;
	for (const f of files) {
		const content = readFileSync(join(AGENTS_DIR, f), "utf8");
		if (content.includes("# Original:")) {
			already++;
			continue;
		}
		const enName = f.replace(/\.md$/, "");
		const zh = map[enName];
		if (!zh) {
			console.warn(`[warn] 无映射: ${enName}`);
			unmapped++;
			continue;
		}
		todo.push({ oldFile: f, zhName: zh, content });
	}
	console.log(
		`待转换: ${todo.length}，已完成跳过: ${already}，无映射: ${unmapped}`,
	);
	if (unmapped) process.exit(1);
	if (DRY_RUN) {
		console.log("[dry-run] 结束");
		return;
	}

	// 唯一化中文 displayName（Windows 大小写不敏感）
	const used = new Map<string, number>();
	const renamePlan: { oldFile: string; newFile: string; content: string }[] =
		[];
	const dupes: string[] = [];
	for (const { oldFile, zhName, content } of todo) {
		const base = sanitizeName(zhName, `Agent-${renamePlan.length}`);
		const key = base.toLowerCase();
		const count = used.get(key) ?? 0;
		used.set(key, count + 1);
		const displayName = count === 0 ? base : `${base}-${count + 1}`;
		if (count > 0) dupes.push(`${base} (第 ${count + 1} 个)`);
		// 替换 frontmatter 里的 displayName，并插入 Original 注释
		const newContent = applyRenameToContent(
			content,
			displayName,
			oldFile.replace(/\.md$/, ""),
		);
		renamePlan.push({
			oldFile,
			newFile: `${displayName}.md`,
			content: newContent,
		});
	}
	console.log(`重名追加后缀: ${dupes.length} 个`);
	if (dupes.length) console.log("  ", dupes.join("; "));

	// 执行：写新内容（同名直接覆盖，异名写新文件后删旧文件）
	const newNames = new Set<string>();
	for (const { newFile, content } of renamePlan) {
		writeFileSync(join(AGENTS_DIR, newFile), content, "utf8");
		newNames.add(newFile);
	}
	for (const { oldFile } of renamePlan) {
		// Windows 大小写不敏感：若新旧文件名仅大小写不同，unlink 会误删刚写的新文件
		const sameAsNew = renamePlan.some(
			(r) =>
				r.oldFile !== r.newFile &&
				r.newFile.toLowerCase() === oldFile.toLowerCase(),
		);
		if (!newNames.has(oldFile) && !sameAsNew) {
			try {
				unlinkSync(join(AGENTS_DIR, oldFile));
			} catch {}
		}
	}
	console.log(`已完成 ${renamePlan.length} 个文件的中文名替换`);
}

// CLI 入口；被 import 时不执行
if (import.meta.main) {
	main();
}
