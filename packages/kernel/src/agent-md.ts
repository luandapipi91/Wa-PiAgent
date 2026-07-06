import type { AgentConfig } from "hiagent-shared";

export function parseAgentMd(content: string): AgentConfig {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error("Invalid agent.md: missing frontmatter");
  const [, fmRaw, bodyRaw] = m;
  const fm = parseFrontmatter(fmRaw);
  return {
    name: fm.name,
    displayName: fm.displayName ?? fm.name,
    avatar: fm.avatar ?? "🤖",
    description: fm.description ?? "",
    model: fm.model ?? "deepseek/deepseek-v4-flash",
    thinking: fm.thinking ?? "off",
    tools: parseList(fm.tools),
    skills: parseList(fm.skills),
    partners: {
      askTo: parseList(fm.partners?.askTo),
      askFrom: parseList(fm.partners?.askFrom),
    },
    systemPrompt: bodyRaw.trim(),
  };
}

export function serializeAgentMd(c: AgentConfig): string {
  const lines = ["---"];
  lines.push(`name: ${c.name}`);
  lines.push(`displayName: ${c.displayName}`);
  lines.push(`avatar: "${c.avatar}"`);
  if (c.description) lines.push(`description: ${c.description}`);
  lines.push(`model: ${c.model}`);
  lines.push(`thinking: ${c.thinking}`);
  if (c.tools.length) lines.push(`tools: ${c.tools.join(", ")}`);
  if (c.skills.length) lines.push(`skills: ${c.skills.join(", ")}`);
  if (c.partners.askTo.length || c.partners.askFrom.length) {
    lines.push("partners:");
    if (c.partners.askTo.length) lines.push(`  askTo: [${c.partners.askTo.join(", ")}]`);
    if (c.partners.askFrom.length) lines.push(`  askFrom: [${c.partners.askFrom.join(", ")}]`);
  }
  lines.push("---");
  if (c.systemPrompt) lines.push("", c.systemPrompt);
  return lines.join("\n");
}

function parseFrontmatter(raw: string): Record<string, any> {
  const result: Record<string, any> = {};
  let currentObj: Record<string, any> | null = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const objMatch = line.match(/^(\w+):$/);
    if (objMatch) { currentObj = {}; result[objMatch[1]] = currentObj; continue; }
    const nestedMatch = line.match(/^  (\w+):\s*(.*)$/);
    if (nestedMatch && currentObj) { currentObj[nestedMatch[1]] = parseValue(nestedMatch[2]); continue; }
    const kvMatch = line.match(/^(\w+):\s*(.*)$/);
    if (kvMatch) { currentObj = null; result[kvMatch[1]] = parseValue(kvMatch[2]); }
  }
  return result;
}

function parseValue(v: string): any {
  v = v.trim();
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  if (v.startsWith("[") && v.endsWith("]")) return v.slice(1, -1).split(",").map(s => s.trim()).filter(Boolean);
  return v;
}

function parseList(v: any): string[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return v.split(",").map(s => s.trim()).filter(Boolean);
  return [];
}
