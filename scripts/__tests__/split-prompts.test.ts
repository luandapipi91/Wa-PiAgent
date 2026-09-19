import { test, expect } from "bun:test";
import {
	parsePrompts,
	sanitizeName,
	makeDescription,
	renderAgentMd,
	assignDisplayNames,
	type Role,
} from "../split-prompts";

function role(partial: Partial<Role>): Role {
	return {
		name: "Test Role",
		body: "body",
		contributor: "",
		index: 0,
		...partial,
	};
}

// ---------- parsePrompts ----------

const SAMPLE = `<details>
<summary><strong>Linux Terminal</strong></summary>

## Linux Terminal

Contributed by [@f](https://github.com/f)

\`\`\`md
I want you to act as a linux terminal.
\`\`\`

</details>

<details>
<summary><strong>Excel Sheet</strong></summary>

## Excel Sheet

Contributed by @anonymous

\`\`\`md
I want you to act as an excel sheet.
\`\`\`

</details>
`;

test("parsePrompts 解析多个角色块", () => {
	const roles = parsePrompts(SAMPLE);
	expect(roles).toHaveLength(2);
	expect(roles[0].name).toBe("Linux Terminal");
	expect(roles[0].body).toBe("I want you to act as a linux terminal.");
	expect(roles[0].contributor).toBe("[@f](https://github.com/f)");
	expect(roles[1].name).toBe("Excel Sheet");
	expect(roles[1].contributor).toBe("@anonymous");
});

test("parsePrompts 正文含嵌套代码块时取最后围栏", () => {
	const text = `<details>
<summary><strong>Nested</strong></summary>

## Nested

\`\`\`md
Start here

\`\`\`js
const a = 1;
\`\`\`

Still body.

\`\`\`

</details>
`;
	const roles = parsePrompts(text);
	expect(roles).toHaveLength(1);
	expect(roles[0].body).toContain("Start here");
	expect(roles[0].body).toContain("Still body.");
});

test("parsePrompts 跳过非 details 前置内容", () => {
	const roles = parsePrompts("# title\n\n" + SAMPLE);
	expect(roles).toHaveLength(2);
});

// ---------- sanitizeName ----------

test("sanitizeName 替换非法字符", () => {
	expect(sanitizeName('UX/UI Developer: "Pro" <v2>', "fb")).toBe(
		"UX-UI Developer- -Pro- -v2-",
	);
});

test("sanitizeName 去掉首尾空白与结尾点", () => {
	expect(sanitizeName("  Web Design  ", "fb")).toBe("Web Design");
	expect(sanitizeName("Note.", "fb")).toBe("Note");
});

test("sanitizeName 空名与 Windows 保留名兜底", () => {
	expect(sanitizeName(".", "Agent-3")).toBe("Agent-3");
	expect(sanitizeName("", "Agent-4")).toBe("Agent-4");
	expect(sanitizeName("CON", "Agent-5")).toBe("Agent-5");
	expect(sanitizeName("nul", "Agent-6")).toBe("Agent-6");
});

test("sanitizeName 超长名按 code point 截断 120", () => {
	const long = "x".repeat(300);
	const s = sanitizeName(long, "fb");
	expect([...s].length).toBe(120);
	// emoji 是代理对，不能被从中间截断（121 个 > 120 触发截断）
	const emoji = "🎉".repeat(121);
	const s2 = sanitizeName(emoji, "fb");
	expect([...s2].length).toBe(120);
	expect(s2.endsWith("🎉")).toBe(true);
});

// ---------- makeDescription ----------

test("makeDescription 取正文首行并截断", () => {
	const r = role({
		name: "R",
		body: "I want you to act as a tester. More text.",
	});
	expect(makeDescription(r)).toBe("I want you to act as a tester. More text.");
});

test("makeDescription 超长截断加省略号", () => {
	const r = role({ name: "R", body: "a".repeat(200) });
	expect(makeDescription(r)).toBe("a".repeat(120) + "…");
});

test("makeDescription 跳过代码围栏首行，空正文回退角色名", () => {
	// 首个非围栏行是 code
	const r = role({ name: "My Role", body: "```\ncode\n```" });
	expect(makeDescription(r)).toBe("code");
	// 只有围栏没有内容 → 回退角色名
	const r2 = role({ name: "My Role", body: "```\n```" });
	expect(makeDescription(r2)).toBe("My Role");
});

// ---------- renderAgentMd ----------

test("renderAgentMd 生成 frontmatter + 正文", () => {
	const r = role({
		name: "Linux Terminal",
		body: "I want you to act as a terminal.",
	});
	const md = renderAgentMd(r, "Linux Terminal");
	expect(md).toContain("displayName: Linux Terminal");
	expect(md).toContain("description: I want you to act as a terminal.");
	expect(md).toContain("---\n\nI want you to act as a terminal.");
});

test("renderAgentMd 贡献者写入 frontmatter 注释", () => {
	const r = role({
		name: "R",
		body: "b",
		contributor: "[@f](https://github.com/f)",
	});
	const md = renderAgentMd(r, "R");
	expect(md).toContain("# Contributed by [@f](https://github.com/f)");
});

test("renderAgentMd description 中的双引号被替换", () => {
	const r = role({ name: "R", body: 'say "hi" now' });
	const md = renderAgentMd(r, "R");
	expect(md).toContain("description: say 'hi' now");
});

// ---------- assignDisplayNames ----------

test("assignDisplayNames 完全重名追加 -2/-3", () => {
	const rs = [
		role({ name: "A", index: 1 }),
		role({ name: "A", index: 2 }),
		role({ name: "A", index: 3 }),
	];
	const assigned = assignDisplayNames(rs);
	expect(assigned.map((a) => a.displayName)).toEqual(["A", "A-2", "A-3"]);
});

test("assignDisplayNames 大小写不同也视为重名（Windows 不敏感）", () => {
	const rs = [
		role({ name: "Life Coach", index: 1 }),
		role({ name: "Life coach", index: 2 }),
	];
	const assigned = assignDisplayNames(rs);
	// 后缀基于 base 原始大小写；Windows 上 "Life Coach-2" 与 "Life Coach" 不冲突
	expect(assigned.map((a) => a.displayName)).toEqual([
		"Life Coach",
		"Life coach-2",
	]);
});

test("assignDisplayNames 清洗后撞名也加后缀", () => {
	// "/" 与 ":" 清洗后都变成 "-"，两个名字撞成 "UX-UI Developer"
	const rs = [
		role({ name: "UX/UI Developer", index: 1 }),
		role({ name: "UX:UI Developer", index: 2 }),
	];
	const assigned = assignDisplayNames(rs);
	expect(assigned.map((a) => a.displayName)).toEqual([
		"UX-UI Developer",
		"UX-UI Developer-2",
	]);
});

test("assignDisplayNames 文件名全局唯一且无非法字符", () => {
	const rs = [
		role({ name: "a/b", index: 1 }),
		role({ name: "a\\b", index: 2 }),
		role({ name: "a:b", index: 3 }),
	];
	const assigned = assignDisplayNames(rs);
	const names = assigned.map((a) => a.fileName);
	expect(new Set(names).size).toBe(names.length);
	for (const n of names) expect(/[/\\:*?"<>|]/.test(n)).toBe(false);
});
