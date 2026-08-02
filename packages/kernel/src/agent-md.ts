import type { AgentConfig, Partners } from "@wa-pi/shared";
import { agentDefOf } from "@wa-pi/shared";

// 轻量 YAML 解析（仅支持 agent.md 用到的子集：标量、列表、嵌套对象）
// 不引入 gray-mirror 等依赖，保持 kernel 精简
function parseYaml(text: string): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	const lines = text.split("\n");
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (!line.trim() || line.trim().startsWith("#")) {
			i++;
			continue;
		}
		const m = line.match(/^(\w+):\s*(.*)$/);
		if (!m) {
			i++;
			continue;
		}
		const [, key, val] = m;
		if (val === "") {
			// 嵌套块
			if (key === "partners") {
				const partners: Record<string, string[]> = { askTo: [] };
				i++;
				while (i < lines.length && lines[i].startsWith("  ")) {
					const pm = lines[i].match(/^\s+(\w+):\s*(.*)$/);
					// 只收集 askTo；旧文件里的 askFrom 行被忽略（字段已移除）
					if (pm && pm[1] === "askTo") partners[pm[1]] = parseList(pm[2]);
					i++;
				}
				result[key] = partners;
				continue; // while 退出后 i 已指向下一无缩进行，跳过外层 i++
			} else if (key === "delegationHints") {
				// 委派引导嵌套块：收集 whenToDelegate/whenNotTo/benefit 标量字段
				const hints: Record<string, string> = {};
				i++;
				while (i < lines.length && lines[i].startsWith("  ")) {
					const hm = lines[i].match(/^\s+(\w+):\s*(.*)$/);
					if (
						hm &&
						["whenToDelegate", "whenNotTo", "benefit"].includes(hm[1])
					) {
						hints[hm[1]] = String(parseScalar(hm[2]));
					}
					i++;
				}
				result[key] = hints;
				continue; // 同 partners
			} else if (i + 1 < lines.length && lines[i + 1].startsWith("  ")) {
				// 跳过未知嵌套块
				i++;
				while (i < lines.length && lines[i].startsWith("  ")) i++;
				continue;
			} else {
				// 空值标量（如空 description）
				result[key] = "";
			}
		} else {
			result[key] = parseScalar(val);
		}
		i++;
	}
	return result;
}

function parseScalar(val: string): unknown {
	const v = val.trim();
	if (v.startsWith("[") && v.endsWith("]")) return parseList(v);
	if (v === "[]") return [];
	if (v === "true") return true;
	if (v === "false") return false;
	if (v === "null") return null;
	if (
		(v.startsWith('"') && v.endsWith('"')) ||
		(v.startsWith("'") && v.endsWith("'"))
	) {
		return v.slice(1, -1);
	}
	return v;
}

function parseList(val: string): string[] {
	const v = val.trim();
	if (!v.startsWith("[")) return [];
	const inner = v.slice(1, -1).trim();
	if (!inner) return [];
	return inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
}

export function parseAgentMd(md: string): AgentConfig {
	const fm = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!fm) throw new Error("agent.md 缺少 frontmatter");
	const [, yamlText, bodyText] = fm;
	const y = parseYaml(yamlText);
	const partners = (y.partners as Partners) ?? { askTo: [] };
	return {
		displayName: y.displayName as string,
		avatar: y.avatar as string,
		avatarColor: y.avatarColor as string,
		description: y.description as string,
		model:
			y.model === undefined || y.model === null || y.model === ""
				? null
				: (y.model as string),
		thinking:
			y.thinking === undefined || y.thinking === null
				? null
				: ((y.thinking === "low"
						? "medium"
						: y.thinking) as AgentConfig["thinking"]),
		tools: (() => {
			if (Array.isArray(y.tools)) return y.tools as string[];
			if (y.tools == null || String(y.tools).trim() === "") return [];
			return String(y.tools)
				.split(",")
				.map((s) => s.trim());
		})(),
		skills: (() => {
			const raw = Array.isArray(y.skills)
				? (y.skills as string[])
				: String(y.skills ?? "")
						.split(",")
						.map((s: string) => s.trim());
			// 防御：过滤空字符串（如旧格式 skills: 被解析为 [""] 的残留数据）
			return raw.filter((s: string) => s !== "");
		})(),
		mcpServers: Array.isArray(y.mcpServers) ? (y.mcpServers as string[]) : [],
		partners,
		delegationHints: (() => {
			const h = y.delegationHints as Record<string, string> | undefined;
			if (!h) return undefined;
			// 三字段全空则视为未配置
			const has = h.whenToDelegate || h.whenNotTo || h.benefit;
			return has
				? {
						whenToDelegate: h.whenToDelegate,
						whenNotTo: h.whenNotTo,
						benefit: h.benefit,
					}
				: undefined;
		})(),
		systemPromptBody: bodyText.trim() || undefined,
	};
}

export function stringifyAgentMd(c: AgentConfig): string {
	// 防护：displayName 不能为空或 undefined（防止序列化为字符串 "undefined"）
	if (!c.displayName) throw new Error("displayName 不能为空");
	const fm: string[] = ["---"];
	fm.push(`displayName: ${c.displayName}`);
	fm.push(`avatar: "${c.avatar}"`);
	fm.push(`avatarColor: "${c.avatarColor}"`);
	fm.push(`description: ${c.description}`);
	fm.push(`model: ${c.model ?? ""}`);
	// thinking 为 null 时不写该行：wa-pi 读取时 undefined → null（语义不变：跟随主会话）；
	// 若写成 `thinking: null`，pi 的 frontmatter 解析会把 "null" 当字符串 → parse warning
	// （invalid value "null": must be one of off, minimal, low, medium, high, xhigh）。
	if (c.thinking !== null) fm.push(`thinking: ${c.thinking}`);
	fm.push(`tools: [${c.tools.join(", ")}]`);
	fm.push(`skills: [${c.skills.join(", ")}]`);
	fm.push(
		`mcpServers: ${c.mcpServers.length ? `[${c.mcpServers.join(", ")}]` : "[]"}`,
	);
	fm.push("partners:");
	fm.push(`  askTo: [${c.partners.askTo.join(", ")}]`);
	// 委派引导：三字段有任一非空才写出，避免污染所有 agent.md
	const h = c.delegationHints;
	if (h && (h.whenToDelegate || h.whenNotTo || h.benefit)) {
		fm.push("delegationHints:");
		if (h.whenToDelegate) fm.push(`  whenToDelegate: ${h.whenToDelegate}`);
		if (h.whenNotTo) fm.push(`  whenNotTo: ${h.whenNotTo}`);
		if (h.benefit) fm.push(`  benefit: ${h.benefit}`);
	}
	fm.push("---");
	if (c.systemPromptBody) fm.push(c.systemPromptBody);
	return fm.join("\n");
}

const ILLEGAL_NAME_CHARS = /[/\\:*?"<>|]/;

export function validateAgentConfig(c: AgentConfig): string[] {
	const errs: string[] = [];
	if (!c.displayName || !c.displayName.trim())
		errs.push("displayName 不能为空");
	else if (ILLEGAL_NAME_CHARS.test(c.displayName))
		errs.push(
			`非法 displayName: ${c.displayName}（含 / \\ : * ? " < > | 字符）`,
		);
	if (!["disabled", "medium", "high", "max", null].includes(c.thinking))
		errs.push(`非法 thinking: ${c.thinking}`);
	return errs;
}

/** 当 agent.md 不存在时，生成一份默认 AgentConfig */
export function makeDefaultAgentConfig(displayName: string): AgentConfig {
	const def = agentDefOf(displayName);
	return {
		displayName,
		avatar: def.emoji,
		avatarColor: `${def.gradient[0]}-${def.gradient[1]}`,
		description: "",
		model: null,
		thinking: null,
		tools: [],
		skills: [],
		mcpServers: [],
		partners: { askTo: [] },
	};
}
