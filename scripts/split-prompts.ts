#!/usr/bin/env bun
/**
 * 把 docs/references/awesome-chatgpt-prompts/PROMPTS.md
 * 拆分成 2096 个单角色提示词文件，存储为 wa-pi 项目能识别的 agent 格式：
 *   frontmatter(displayName/avatar/avatarColor/description/tools/skills/mcpServers/partners) + 正文
 *
 * 输出目录：docs/references/awesome-chatgpt-prompts/agents/
 * 每个角色一个 <displayName>.md，格式与 packages/kernel/src/agent-md.ts 的 stringifyAgentMd 一致，
 * 可整体复制到 ~/.wa-pi/agents/ 被运行时直接识别。
 *
 * 用法：bun scripts/split-prompts.ts [--dry-run]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SRC = join(ROOT, "docs/references/awesome-chatgpt-prompts/PROMPTS.md");
const OUT_DIR = join(ROOT, "docs/references/awesome-chatgpt-prompts/agents");

const DRY_RUN = process.argv.includes("--dry-run");

const ILLEGAL_NAME_CHARS = /[/\\:*?"<>|]/g;
// Windows 文件名保留名（不区分大小写，忽略扩展名）
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

export interface Role {
	name: string;
	body: string;
	contributor: string;
	index: number;
}

export interface AssignedFile {
	role: Role;
	displayName: string;
	fileName: string;
}

export function parsePrompts(text: string): Role[] {
	// 按 <details> 块切分
	const blocks = text.split(/(?=^<details>$)/m);
	const roles: Role[] = [];
	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];
		if (!block.includes("<details>")) continue; // 前置内容
		// summary 角色名
		const sm = block.match(/<summary><strong>(.*?)<\/strong><\/summary>/);
		if (!sm) {
			console.warn(`[skip] 第 ${i} 块缺少 summary，跳过`);
			continue;
		}
		const name = sm[1].trim();
		// 贡献者
		const cm = block.match(/Contributed by\s+(.+?)(?:\n|$)/);
		const contributor = cm ? cm[1].trim() : "";
		// ```md 正文：取第一个 ```md 之后到最后一个 ``` 之前
		const mdIdx = block.indexOf("```md");
		if (mdIdx === -1) {
			console.warn(`[skip] 角色 ${name} 缺少 \`\`\`md 正文块，跳过`);
			continue;
		}
		const afterMd = block.slice(mdIdx + 5); // 跳过 ```md
		// 找最后一个 ```
		const lastFence = afterMd.lastIndexOf("```");
		if (lastFence === -1) {
			console.warn(`[skip] 角色 ${name} 缺少结束 \`\`\`，跳过`);
			continue;
		}
		let body = afterMd.slice(0, lastFence);
		// 去掉包裹 ```md 后紧跟的第一个换行、结束 ``` 前的尾随换行
		body = body.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
		roles.push({ name, body, contributor, index: i });
	}
	return roles;
}

/** 清洗 displayName / 文件名：替换非法字符、去除首尾空白与结尾点 */
export function sanitizeName(raw: string, fallback: string): string {
	let s = raw
		.replace(ILLEGAL_NAME_CHARS, "-")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[. ]+$/, "");
	// Windows 保留名、空名、"." ".." 兜底
	const stem = s.split(".")[0].toUpperCase();
	if (!s || s === "." || s === ".." || RESERVED_NAMES.has(stem)) {
		s = fallback;
	}
	// 截断超长名：Windows 路径上限 260（目录前缀约 65 字符），
	// 文件名(含 .md)留到 120 以内保证任意复制路径下可正常读写。
	// 按 code point 截断避免切到 emoji/代理对中间。
	const MAX_NAME = 120;
	if ([...s].length > MAX_NAME) {
		s = [...s].slice(0, MAX_NAME).join("");
	}
	return s;
}

/** 从正文提取一句 description：取第一个非空行，去代码围栏，截断 120 字符 */
export function makeDescription(role: Role): string {
	const firstLine = role.body
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l && !l.startsWith("```"));
	if (!firstLine) return role.name;
	const cleaned = firstLine.replace(/^[#>*\- ]+/, "").trim();
	if (!cleaned) return role.name;
	return cleaned.length > 120 ? cleaned.slice(0, 120) + "…" : cleaned;
}

export function renderAgentMd(role: Role, displayName: string): string {
	const desc = makeDescription(role).replace(/"/g, "'");
	const lines = [
		"---",
		`displayName: ${displayName}`,
		`avatar: "🤖"`,
		`avatarColor: "#8B5CF6-#6366F1"`,
		`description: ${desc}`,
		"model: ",
		"tools: []",
		"skills: []",
		"mcpServers: []",
		"partners:",
		"  askTo: []",
		"---",
	];
	if (role.contributor) {
		lines.splice(lines.length - 1, 0, `# Contributed by ${role.contributor}`);
	}
	return lines.join("\n") + "\n\n" + role.body.trimEnd() + "\n";
}

/** 唯一化 displayName（与 config-store 行为一致：重名追加 -2/-3） */
export function assignDisplayNames(roles: Role[]): AssignedFile[] {
	// 注意：Windows 文件系统大小写不敏感，Map 必须用 lowercase key，
	// 否则 "Life Coach" 与 "Life coach" 会互相覆盖导致文件数减少。
	const used = new Map<string, number>();
	const assigned: AssignedFile[] = [];
	for (const role of roles) {
		const fallback = `Agent-${role.index}`;
		const base = sanitizeName(role.name, fallback);
		const key = base.toLowerCase();
		const count = used.get(key) ?? 0;
		used.set(key, count + 1);
		const displayName = count === 0 ? base : `${base}-${count + 1}`;
		assigned.push({ role, displayName, fileName: `${displayName}.md` });
	}
	return assigned;
}

function main() {
	const text = readFileSync(SRC, "utf8");
	const roles = parsePrompts(text);
	console.log(`解析到角色块: ${roles.length}`);

	const assigned = assignDisplayNames(roles);
	// 真正重名 = displayName 与清洗后的 base 不同（追加了 -N 后缀）
	const baseNames = assigned.map((a) =>
		sanitizeName(a.role.name, `Agent-${a.role.index}`),
	);
	const dupes = assigned.filter((a, i) => a.displayName !== baseNames[i]);
	const sanitized = assigned.filter((a, i) => a.role.name !== baseNames[i]);
	console.log(
		`唯一 displayName: ${new Set(baseNames.map((s) => s.toLowerCase())).size}，重名追加后缀: ${dupes.length} 个，非法字符清洗: ${sanitized.length} 个`,
	);
	if (dupes.length)
		console.log("  重名:", dupes.map((d) => d.displayName).join("; "));

	if (DRY_RUN) {
		console.log(`[dry-run] 将写入 ${assigned.length} 个文件到 ${OUT_DIR}`);
		return;
	}

	mkdirSync(OUT_DIR, { recursive: true });
	let written = 0;
	for (const { role, displayName, fileName } of assigned) {
		writeFileSync(
			join(OUT_DIR, fileName),
			renderAgentMd(role, displayName),
			"utf8",
		);
		written++;
	}
	console.log(`已写入 ${written} 个文件到 ${OUT_DIR}`);
}

// CLI 入口；被 import 时不执行
if (import.meta.main) {
	main();
}
