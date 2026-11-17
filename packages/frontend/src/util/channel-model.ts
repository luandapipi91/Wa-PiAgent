import type { AgentConfig, ChannelConfig } from "@wa-pi/shared";

/**
 * 解析 IM 机器人会话实际使用的模型（进入 IM 会话时输入框模型同步用）。
 * 与 kernel channel-manager.ts 入站解析保持一致：channel.model ?? agent.model，
 * 智能体按 agentName 匹配、已被删除时降级取 agents[0]（复刻 resolveAgent）。
 * 返回 null = 双方都未配置（跟随全局默认模型，前端维持现有回退行为）。
 */
export function resolveChannelModel(
	bot: Pick<ChannelConfig, "model" | "agentName"> | undefined,
	agents: Pick<AgentConfig, "displayName" | "model">[],
): string | null {
	if (!bot) return null;
	if (bot.model) return bot.model;
	const bound = agents.find((a) => a.displayName === bot.agentName) ?? agents[0];
	// AgentConfig.model 约定 null/"" 均为未配置（跟随全局）
	return bound?.model || null;
}
