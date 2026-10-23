import { test, expect } from "bun:test";
import {
	parseAgentMd,
	stringifyAgentMd,
	validateAgentConfig,
	makeDefaultAgentConfig,
} from "../src/agent-md";
import { ALL_AGENT_NAMES } from "@wa-pi/shared";
import type { AgentConfig } from "@wa-pi/shared";

const DEV_MD = `---
displayName: 研发
avatar: "⚙️"
avatarColor: "#fab387-#f38ba8"
description: 后端研发
model: anthropic/claude-sonnet-4
thinking: high
tools: read, bash, edit
skills: architecture-review
mcpServers: []
partners:
  askTo: [product, test]
---
你是一名资深后端工程师。`;

test("parseAgentMd 解析 frontmatter + 正文", () => {
	const c = parseAgentMd(DEV_MD);
	expect(c.displayName).toBe("研发");
	expect(c.tools).toEqual(["read", "bash", "edit"]);
	expect(c.skills).toEqual(["architecture-review"]);
	expect(c.partners.askTo).toEqual(["product", "test"]);
	expect(c.systemPromptBody).toBe("你是一名资深后端工程师。");
});

test("parseAgentMd 处理空 mcpServers", () => {
	const c = parseAgentMd(DEV_MD);
	expect(c.mcpServers).toEqual([]);
});

test("stringifyAgentMd 往返一致", () => {
	const c = parseAgentMd(DEV_MD);
	const md2 = stringifyAgentMd(c);
	const c2 = parseAgentMd(md2);
	expect(c2).toEqual(c);
});

test("validateAgentConfig 拒绝非法 displayName", () => {
	const bad = parseAgentMd(DEV_MD);
	bad.displayName = "a/b";
	const errs = validateAgentConfig(bad as AgentConfig);
	expect(errs.length).toBeGreaterThan(0);
});

test("validateAgentConfig 合法配置返回空", () => {
	const c = parseAgentMd(DEV_MD);
	expect(validateAgentConfig(c)).toEqual([]);
});

const base: AgentConfig = {
	displayName: "代码审查",
	avatar: "🔍",
	avatarColor: "#06b6d4-#3b82f6",
	description: "评审改动",
	model: "glm-4.6",
	thinking: "high",
	tools: [],
	skills: [],
	mcpServers: [],
	partners: { askTo: ["dev"] },
	systemPromptBody: "你是代码审查智能体。",
};

test("validateAgentConfig: 任意非空合法名通过；非法文件名字符拒绝", () => {
	expect(validateAgentConfig(base)).toEqual([]);
	expect(validateAgentConfig({ ...base, displayName: "" })).toContain(
		"displayName 不能为空",
	);
	expect(validateAgentConfig({ ...base, displayName: "a/b" })[0]).toContain(
		"非法 displayName",
	);
	expect(validateAgentConfig({ ...base, displayName: "a:b" })[0]).toContain(
		"非法 displayName",
	);
});

test("delegationHints 序列化/解析往返（三字段齐全）", () => {
	const c: AgentConfig = {
		...base,
		delegationHints: {
			whenToDelegate: "用户描述新需求时",
			whenNotTo: "已明确到具体文件",
			benefit: "省主上下文 token",
		},
	};
	const md = stringifyAgentMd(c);
	expect(md).toContain("delegationHints:");
	expect(md).toContain("  whenToDelegate: 用户描述新需求时");
	expect(md).toContain("  whenNotTo: 已明确到具体文件");
	expect(md).toContain("  benefit: 省主上下文 token");
	const parsed = parseAgentMd(md);
	expect(parsed.delegationHints).toEqual({
		whenToDelegate: "用户描述新需求时",
		whenNotTo: "已明确到具体文件",
		benefit: "省主上下文 token",
	});
});

test("delegationHints 部分字段（只有 whenToDelegate）往返不丢", () => {
	const c: AgentConfig = {
		...base,
		delegationHints: { whenToDelegate: "只配一条" },
	};
	const md = stringifyAgentMd(c);
	const parsed = parseAgentMd(md);
	expect(parsed.delegationHints).toEqual({ whenToDelegate: "只配一条" });
});

test("delegationHints 未配置时不写入 frontmatter（不污染旧文件）", () => {
	const md = stringifyAgentMd(base);
	expect(md).not.toContain("delegationHints");
	expect(parseAgentMd(md).delegationHints).toBeUndefined();
});

test("delegationHints 三字段全空时不写入（视为未配置）", () => {
	const c: AgentConfig = {
		...base,
		delegationHints: { whenToDelegate: "", whenNotTo: "", benefit: "" },
	};
	const md = stringifyAgentMd(c);
	expect(md).not.toContain("delegationHints");
});
test("thinking: low 读取时归一为 medium", () => {
	const md = stringifyAgentMd(base).replace("thinking: high", "thinking: low");
	expect(parseAgentMd(md).thinking).toBe("medium");
});

test("makeDefaultAgentConfig 支持任意 displayName（无内置定义时用名称本身）", () => {
	const c = makeDefaultAgentConfig("文档写手");
	expect(c.displayName).toBe("文档写手");
	expect(c.avatar).toBe("🤖");
});

test("makeDefaultAgentConfig 默认关系网包含所有内置智能体", () => {
	const c = makeDefaultAgentConfig("文档写手");
	expect(c.partners.askTo).toEqual(ALL_AGENT_NAMES);
});

test("thinking: null 序列化时不写 thinking 行（避免 pi 解析 'null' 字符串报 parse warning）；解析往返仍 null；model null 往返", () => {
	const c = { ...base, thinking: null as any, model: null as any };
	const md = stringifyAgentMd(c);
	// 修复：null thinking 不再写 `thinking: null`（pi frontmatter 解析会把 "null" 当字符串 → parse warning）
	expect(md).not.toContain("thinking: null");
	expect(md).not.toContain("thinking:");
	const parsed = parseAgentMd(md);
	expect(parsed.thinking).toBeNull();
	expect(parsed.model).toBeNull();
});

test("validateAgentConfig 允许 thinking: null 与空 model", () => {
	const c = { ...base, thinking: null, model: null };
	expect(validateAgentConfig(c)).toEqual([]);
	expect(
		validateAgentConfig({ ...base, thinking: "high", model: "glm-4.6" }),
	).toEqual([]);
	expect(
		validateAgentConfig({ ...base, thinking: "bogus" as any })[0],
	).toContain("非法 thinking");
});

// ─── tools 序列化/解析 TDD（修复 YAML 非法格式 bug）────────────────────────────

test("stringifyAgentMd 非空 tools 用 YAML flow sequence 格式（不产生前导逗号）", () => {
	const c = { ...base, tools: ["read", "bash", "edit"] };
	const md = stringifyAgentMd(c);
	expect(md).toContain("tools: [read, bash, edit]");
	expect(md).not.toMatch(/tools: ,/); // 不应有前导逗号（旧 bug）
});

test("stringifyAgentMd 空 tools 输出 tools: []", () => {
	const c = { ...base, tools: [] };
	const md = stringifyAgentMd(c);
	expect(md).toContain("tools: []");
});

test("parseAgentMd: tools: [] 空 YAML flow sequence 解析为 []", () => {
	const md = stringifyAgentMd({ ...base, tools: [] });
	const c = parseAgentMd(md);
	expect(c.tools).toEqual([]);
});

test("parseAgentMd: tools: [read, bash] 解析为数组", () => {
	const md = stringifyAgentMd({ ...base, tools: ["read", "bash"] });
	const c = parseAgentMd(md);
	expect(c.tools).toEqual(["read", "bash"]);
});

test("parseAgentMd: tools 为空/null 时返回 []（不产生 ['undefined'] ）", () => {
	// 模拟 YAML 解析 tools:  为空的情况 —— y.tools = null
	const rawEmpty = `---
displayName: 测试
tools:
---`;
	const c = parseAgentMd(rawEmpty);
	expect(c.tools).toEqual([]);
});

test("tools 序列化往返：非空数组不丢项", () => {
	const c = {
		...base,
		tools: ["read", "bash", "edit", "grep", "delegate", "fleet"],
	};
	const c2 = parseAgentMd(stringifyAgentMd(c));
	expect(c2.tools).toEqual([
		"read",
		"bash",
		"edit",
		"grep",
		"delegate",
		"fleet",
	]);
});

test("tools 序列化往返：空数组不变成 ['']", () => {
	const c = { ...base, tools: [] };
	const c2 = parseAgentMd(stringifyAgentMd(c));
	expect(c2.tools).toEqual([]);
});

test("skills 序列化往返：空数组不变成 ['']（Bug: 旧格式 skills: 无括号）", () => {
	const c = { ...base, skills: [] };
	const c2 = parseAgentMd(stringifyAgentMd(c));
	expect(c2.skills).toEqual([]);
});

test("skills 序列化往返：非空数组不丢项", () => {
	const c = { ...base, skills: ["pdf", "web"] };
	const c2 = parseAgentMd(stringifyAgentMd(c));
	expect(c2.skills).toEqual(["pdf", "web"]);
});

test("skillsAllOff: true 序列化写出并解析往返一致", () => {
	const c = { ...base, skills: [], skillsAllOff: true };
	const md = stringifyAgentMd(c);
	expect(md).toContain("skillsAllOff: true");
	const parsed = parseAgentMd(md);
	expect(parsed.skillsAllOff).toBe(true);
	expect(parsed.skills).toEqual([]);
});

test("skillsAllOff 未配置时不写入 frontmatter（不污染旧文件）", () => {
	const md = stringifyAgentMd(base);
	expect(md).not.toContain("skillsAllOff");
	expect(parseAgentMd(md).skillsAllOff).toBeUndefined();
});

test("skillsAllOff 为 false 时不写入 frontmatter", () => {
	const c = { ...base, skillsAllOff: false };
	const md = stringifyAgentMd(c);
	expect(md).not.toContain("skillsAllOff");
	expect(parseAgentMd(md).skillsAllOff).toBeUndefined();
});
