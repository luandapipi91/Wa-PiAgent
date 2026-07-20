import type { AgentConfig, Partners } from "@hiagent/shared";
import { agentDefOf } from "@hiagent/shared";

// 轻量 YAML 解析（仅支持 agent.md 用到的子集：标量、列表、嵌套对象）
// 不引入 gray-mirror 等依赖，保持 kernel 精简
function parseYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) { i++; continue; }
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) { i++; continue; }
    const [, key, val] = m;
    if (val === "") {
      // 嵌套块
      if (key === "partners") {
        const partners: Record<string, string[]> = { askTo: [], askFrom: [] };
        i++;
        while (i < lines.length && lines[i].startsWith("  ")) {
          const pm = lines[i].match(/^\s+(\w+):\s*(.*)$/);
          if (pm) partners[pm[1]] = parseList(pm[2]);
          i++;
        }
        result[key] = partners;
      } else if (i + 1 < lines.length && lines[i + 1].startsWith("  ")) {
        // 跳过未知嵌套块
        i++;
        while (i < lines.length && lines[i].startsWith("  ")) i++;
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
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function parseList(val: string): string[] {
  const v = val.trim();
  if (!v.startsWith("[")) return [];
  const inner = v.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(",").map(s => s.trim().replace(/^["']|["']$/g, ""));
}

export function parseAgentMd(md: string): AgentConfig {
  const fm = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fm) throw new Error("agent.md 缺少 frontmatter");
  const [, yamlText, bodyText] = fm;
  const y = parseYaml(yamlText);
  const partners = (y.partners as Partners) ?? { askTo: [], askFrom: [] };
  return {
    displayName: y.displayName as string,
    avatar: y.avatar as string,
    avatarColor: y.avatarColor as string,
    description: y.description as string,
    model: (y.model === undefined || y.model === null || y.model === "") ? null : y.model as string,
    thinking: (y.thinking === undefined || y.thinking === null)
      ? null
      : (y.thinking === "low" ? "medium" : y.thinking) as AgentConfig["thinking"],
    systemPromptMode: y.systemPromptMode as AgentConfig["systemPromptMode"],
    inheritProjectContext: Boolean(y.inheritProjectContext),
    inheritSkills: Boolean(y.inheritSkills),
    tools: Array.isArray(y.tools) ? y.tools as string[] : String(y.tools).split(",").map(s => s.trim()),
    skills: Array.isArray(y.skills) ? y.skills as string[] : String(y.skills).split(",").map(s => s.trim()),
    mcpServers: Array.isArray(y.mcpServers) ? y.mcpServers as string[] : [],
    partners,
    triggerKeywords: Array.isArray(y.triggerKeywords) ? (y.triggerKeywords as string[]) : [],
    systemPromptBody: bodyText.trim() || undefined,
  };
}

export function stringifyAgentMd(c: AgentConfig): string {
  const fm: string[] = ["---"];
  fm.push(`displayName: ${c.displayName}`);
  fm.push(`avatar: "${c.avatar}"`);
  fm.push(`avatarColor: "${c.avatarColor}"`);
  fm.push(`description: ${c.description}`);
  fm.push(`model: ${c.model ?? ""}`);
  fm.push(`thinking: ${c.thinking}`);
  fm.push(`triggerKeywords: [${c.triggerKeywords.join(", ")}]`);
  fm.push(`systemPromptMode: ${c.systemPromptMode}`);
  fm.push(`inheritProjectContext: ${c.inheritProjectContext}`);
  fm.push(`inheritSkills: ${c.inheritSkills}`);
  fm.push(`tools: ${c.tools.join(", ")}`);
  fm.push(`skills: ${c.skills.join(", ")}`);
  fm.push(`mcpServers: ${c.mcpServers.length ? `[${c.mcpServers.join(", ")}]` : "[]"}`);
  fm.push("partners:");
  fm.push(`  askTo: [${c.partners.askTo.join(", ")}]`);
  fm.push(`  askFrom: [${c.partners.askFrom.join(", ")}]`);
  fm.push("---");
  if (c.systemPromptBody) fm.push(c.systemPromptBody);
  return fm.join("\n");
}

const ILLEGAL_NAME_CHARS = /[/\\:*?"<>|]/;

export function validateAgentConfig(c: AgentConfig): string[] {
  const errs: string[] = [];
  if (!c.displayName || !c.displayName.trim()) errs.push("displayName 不能为空");
  else if (ILLEGAL_NAME_CHARS.test(c.displayName)) errs.push(`非法 displayName: ${c.displayName}（含 / \\ : * ? " < > | 字符）`);
  if (!["disabled", "medium", "high", "max", null].includes(c.thinking)) errs.push(`非法 thinking: ${c.thinking}`);
  if (!["replace", "append"].includes(c.systemPromptMode)) errs.push(`非法 systemPromptMode: ${c.systemPromptMode}`);
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
    model: "glm-4.6",
    thinking: "medium",
    systemPromptMode: "replace",
    inheritProjectContext: true,
    inheritSkills: true,
    tools: [],
    skills: [],
    mcpServers: [],
    partners: { askTo: [], askFrom: [] },
    triggerKeywords: [],
  };
}
