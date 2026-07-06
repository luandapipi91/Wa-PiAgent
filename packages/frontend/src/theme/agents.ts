import type { AgentConfig } from "hiagent-shared";

// spec 6.0 四角色：emoji + 渐变色 + 副文案
export const AGENT_THEME: Record<string, { gradient: [string, string]; subtitle: string }> = {
  product: { gradient: ["#89b4fa", "#b4befe"], subtitle: "需求设计" },
  pm:      { gradient: ["#f9e2af", "#ebbc9e"], subtitle: "项目管理" },
  dev:     { gradient: ["#fab387", "#f38ba8"], subtitle: "技术实现" },
  test:    { gradient: ["#a6e3a1", "#94e2d5"], subtitle: "质量验收" },
};

export function agentGradient(name: string): [string, string] {
  return AGENT_THEME[name]?.gradient ?? ["#6c7086", "#585b70"];
}

export function avatarStyle(name: string, size: number): React.CSSProperties {
  const [from, to] = agentGradient(name);
  return {
    width: size, height: size, borderRadius: "50%",
    background: `linear-gradient(135deg, ${from}, ${to})`,
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: size * 0.5, flexShrink: 0,
  };
}
