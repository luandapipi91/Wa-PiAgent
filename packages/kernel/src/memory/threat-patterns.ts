// 提示词注入防护。
//
// 移植自 @amaster.ai/pi-shared（Apache-2.0）的 threat-patterns 模块，
// 因为记忆系统不再依赖该包，但防护能力不能丢：记忆条目会被注入系统提示词，
// 必须拦下注入与窃取载荷。
//
// 版权归属：规则表源自 @amaster.ai/pi-shared v0.1.9（Apache-2.0），
// 详见仓库根 THIRD_PARTY_NOTICES.md。本文件为衍生使用。

export type ThreatScope = "all" | "context" | "strict";

type Rule = readonly [pattern: string, id: string, scope: ThreatScope];

/** 命中即拒绝的规则表（顺序敏感：先命中者作为报告 id） */
const RAW_PATTERNS: readonly Rule[] = [
	["ignore\\s+(?:\\w+\\s+)*(previous|all|above|prior)\\s+(?:\\w+\\s+)*instructions", "prompt_injection", "all"],
	["system\\s+prompt\\s+override", "sys_prompt_override", "all"],
	["disregard\\s+(?:\\w+\\s+)*(your|all|any)\\s+(?:\\w+\\s+)*(instructions|rules|guidelines)", "disregard_rules", "all"],
	["act\\s+as\\s+(if|though)\\s+(?:\\w+\\s+)*you\\s+(?:\\w+\\s+)*(have\\s+no|don't\\s+have)\\s+(?:\\w+\\s+)*(restrictions|limits|rules)", "bypass_restrictions", "all"],
	["<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->", "html_comment_injection", "all"],
	["<\\s*div\\s+style\\s*=\\s*[\"'][\\s\\S]*?display\\s*:\\s*none", "hidden_div", "all"],
	["translate\\s+.*\\s+into\\s+.*\\s+and\\s+(execute|run|eval)", "translate_execute", "all"],
	["do\\s+not\\s+(?:\\w+\\s+)*tell\\s+(?:\\w+\\s+)*the\\s+user", "deception_hide", "all"],
	["you\\s+are\\s+(?:\\w+\\s+)*now\\s+(?:a|an|the)\\s+", "role_hijack", "context"],
	["pretend\\s+(?:\\w+\\s+)*(you\\s+are|to\\s+be)\\s+", "role_pretend", "context"],
	["output\\s+(?:\\w+\\s+)*(system|initial)\\s+prompt", "leak_system_prompt", "context"],
	["(respond|answer|reply)\\s+without\\s+(?:\\w+\\s+)*(restrictions|limitations|filters|safety)", "remove_filters", "context"],
	["you\\s+have\\s+been\\s+(?:\\w+\\s+)*(updated|upgraded|patched)\\s+to", "fake_update", "context"],
	["\\bname\\s+yourself\\s+\\w+", "identity_override", "context"],
	["register\\s+(as\\s+)?a?\\s*node", "c2_node_registration", "context"],
	["(heartbeat|beacon|check[\\s\\-]?in)\\s+(to|with)\\s+", "c2_heartbeat", "context"],
	["pull\\s+(down\\s+)?(?:new\\s+)?task(?:ing|s)?\\b", "c2_task_pull", "context"],
	["connect\\s+to\\s+the\\s+network\\b", "c2_network_connect", "context"],
	["you\\s+must\\s+(?:\\w+\\s+){0,3}(register|connect|report|beacon)\\b", "forced_action", "context"],
	["only\\s+use\\s+one[\\s\\-]?liners?\\b", "anti_forensic_oneliner", "context"],
	["never\\s+(?:\\w+\\s+)*(?:create|write)\\s+(?:\\w+\\s+)*(?:script|file)\\s+(?:\\w+\\s+)*disk", "anti_forensic_disk", "context"],
	["unset\\s+\\w*(?:CLAUDE|CODEX|HERMES|AGENT|OPENAI|ANTHROPIC|PI)\\w*", "env_var_unset_agent", "context"],
	["\\b(?:praxis|cobalt\\s*strike|sliver|havoc|mythic|metasploit|brainworm)\\b", "known_c2_framework", "context"],
	["\\bc2\\s+(?:server|channel|infrastructure|beacon)\\b", "c2_explicit", "context"],
	["\\bcommand\\s+and\\s+control\\b", "c2_explicit_long", "context"],
	["curl\\s+[^\\n]*\\$\\{?\\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)", "exfil_curl", "all"],
	["wget\\s+[^\\n]*\\$\\{?\\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)", "exfil_wget", "all"],
	["cat\\s+[^\\n]*(\\.env|credentials|\\.netrc|\\.pgpass|\\.npmrc|\\.pypirc)", "read_secrets", "all"],
	["(send|post|upload|transmit)\\s+.*\\s+(to|at)\\s+https?://", "send_to_url", "strict"],
	["(include|output|print|share)\\s+(?:\\w+\\s+)*(conversation|chat\\s+history|previous\\s+messages|full\\s+context|entire\\s+context)", "context_exfil", "strict"],
	["authorized_keys", "ssh_backdoor", "strict"],
	["\\$HOME/\\.ssh|~/\\.ssh", "ssh_access", "strict"],
	["\\$HOME/\\.pi/\\.env|~/\\.pi/\\.env", "pi_env", "strict"],
	["(update|modify|edit|write|change|append|add\\s+to)\\s+.*(?:AGENTS\\.md|CLAUDE\\.md|\\.cursorrules|\\.clinerules)", "agent_config_mod", "strict"],
	["(?:api[_-]?key|token|secret|password)\\s*[=:]\\s*[\"'][A-Za-z0-9+/=_-]{20,}", "hardcoded_secret", "strict"],
] as const;

/** 不可见字符（可能用于隐藏指令），命中按 invisible_unicode_<code> 报告 */
export const INVISIBLE_CHARS: ReadonlySet<string> = new Set([
	"\u200b", "\u200c", "\u200d", "\u2060", "\u2062", "\u2063", "\u2064",
	"\ufeff", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e",
	"\u2066", "\u2067", "\u2068", "\u2069",
]);

const COMPILED: ReadonlyArray<{ id: string; scope: ThreatScope; re: RegExp }> =
	RAW_PATTERNS.map(([pattern, id, scope]) => ({
		id,
		scope,
		re: new RegExp(pattern, "i"),
	}));

function codesFor(scope: ThreatScope): ReadonlySet<string> {
	if (scope === "all") return new Set(["all"]);
	if (scope === "context") return new Set(["all", "context"]);
	if (scope === "strict") return new Set(["all", "context", "strict"]);
	throw new Error(`scanForThreats: unknown scope '${scope}'`);
}

/** 扫描内容，返回命中的威胁 id 数组（不可见字符记为 invisible_unicode_U+XXXX） */
export function scanForThreats(
	content: string,
	scope: ThreatScope = "context",
): string[] {
	const allowed = codesFor(scope);
	const findings: string[] = [];
	for (const ch of content) {
		if (INVISIBLE_CHARS.has(ch)) {
			findings.push(
				`invisible_unicode_U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`,
			);
		}
	}
	for (const rule of COMPILED) {
		if (allowed.has(rule.scope) && rule.re.test(content)) {
			findings.push(rule.id);
		}
	}
	return findings;
}

/** 返回首个威胁的可读消息；无威胁返回 null */
export function firstThreatMessage(
	content: string,
	scope: ThreatScope = "strict",
): string | null {
	const findings = scanForThreats(content, scope);
	if (findings.length === 0) return null;
	const id = findings[0];
	if (id.startsWith("invisible_unicode_")) {
		const code = id.replace("invisible_unicode_", "");
		return `Blocked: content contains invisible unicode character ${code} (possible injection).`;
	}
	return `Blocked: content matches threat pattern '${id}'. Content is injected into the system prompt and must not contain injection or exfiltration payloads.`;
}
