import { expect, test } from "bun:test";
import { expandSkillTokens } from "../src/channels/skill-expand";

const skills = [
	{ name: "brainstorming", content: "# 头脑风暴\n先问清楚再动手。", location: "/skills/brainstorming/SKILL.md" },
	{ name: "tdd", content: "# TDD\n先写失败测试。", location: "/skills/tdd/SKILL.md" },
];

test("展开 $[name] 为 <skill name location> XML 块", () => {
	const out = expandSkillTokens("你是客服。$[brainstorming] 其余不变", skills);
	expect(out).toContain('<skill name="brainstorming" location="/skills/brainstorming/SKILL.md">');
	expect(out).toContain("# 头脑风暴");
	expect(out).toContain("</skill>");
	expect(out).toContain("你是客服。");
	expect(out).toContain("其余不变");
});

test("location 缺省时省略该属性", () => {
	const out = expandSkillTokens("$[tdd]", [{ name: "tdd", content: "X" }]);
	expect(out).toContain('<skill name="tdd">');
	expect(out).not.toContain("location");
});

test("多个 token 依次展开；未知技能保留原文", () => {
	const out = expandSkillTokens("$[tdd] 和 $[不存在的技能]", skills);
	expect(out).toContain('<skill name="tdd"');
	expect(out).toContain("# TDD");
	expect(out).toContain("$[不存在的技能]");
});

test("无 token → 原样返回；空串 → 空串", () => {
	expect(expandSkillTokens("没有引用", skills)).toBe("没有引用");
	expect(expandSkillTokens("", skills)).toBe("");
});
