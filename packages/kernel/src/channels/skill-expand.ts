/** 技能 token 正则：与前端 quick-invoke 的 $[技能名] / ¥[技能名] 格式一致 */
const SKILL_TOKEN_RE = /[$¥]\[([^\]]+)\]/g;

/**
 * 把渠道附加提示词里的 $[技能名] 展开为 <skill> XML 块（仿 SDK _expandSkillCommand 的
 * 内联格式——SDK 的展开只作用于用户消息文本，--system-prompt 路径不生效，故 kernel 自行展开）。
 * 找不到的技能保留 $[name] 原文，不静默丢失。
 */
export function expandSkillTokens(
	text: string,
	skills: { name: string; content: string }[],
): string {
	if (!text || !text.includes("$")) return text;
	return text.replace(SKILL_TOKEN_RE, (raw, name: string) => {
		const skill = skills.find((s) => s.name === name);
		if (!skill) return raw;
		return `<skill name="${skill.name}">\n${skill.content}\n</skill>`;
	});
}
