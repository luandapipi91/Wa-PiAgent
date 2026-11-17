import { useEffect, useRef } from "react";
import { useAgentsStore } from "./store/agents";
import { useChannelsStore } from "./store/channels";
import { useComposerPrefsStore } from "./store/composer-prefs";
import { useProjectsStore } from "./store/projects";
import { resolveChannelModel } from "./util/channel-model";

/**
 * IM 会话进入时，输入框模型同步机器人实际用模（从 App.tsx 抽出以便独立单测——
 * 同 preview-window-driver 的抽取先例：App 体量大且依赖繁多）。
 *
 * 解析口径：channel.model ?? agent.model，与 kernel channel-manager 入站解析一致；
 * initSessionModel 仅在该会话无显式模型记录时写入（用户手选不被覆盖，不回写全局默认）。
 *
 * bots 平时仅事件驱动加载（channels:changed），刷新后可能为空：缺 bot 且 bots 为空时
 * 冷启动补拉**一次**（挂载生命周期内置位守卫）——空结果也必须置位：loadBots 对空结果
 * 同样产生新数组引用，effect 依赖 bots 会恒真重跑，无守卫即无限 GET /api/channels
 * （最终审查 Important-2 修复）。非空但缺该 bot（机器人已删除、会话映射残留）放弃同步。
 */
export function useImSessionModelSync(): void {
	const currentSessionId = useProjectsStore((s) => s.currentSessionId);
	const conversations = useChannelsStore((s) => s.conversations);
	const bots = useChannelsStore((s) => s.bots);
	const agents = useAgentsStore((s) => s.list);
	const initSessionModel = useComposerPrefsStore((s) => s.initSessionModel);
	// 补拉守卫：挂载生命周期内至多补拉一次（空结果同样置位，切断「空 bots → 补拉 →
	// 新数组引用 → effect 重跑」的恒真循环）
	const botsBackfillDoneRef = useRef(false);

	useEffect(() => {
		if (!currentSessionId) return;
		const imConv = conversations.find((c) => c.sessionId === currentSessionId);
		if (!imConv) return;
		const bot = bots.find((b) => b.id === imConv.channelId);
		if (!bot && bots.length === 0) {
			if (!botsBackfillDoneRef.current) {
				botsBackfillDoneRef.current = true;
				void useChannelsStore.getState().loadBots();
			}
			return;
		}
		if (!bot) return;
		const model = resolveChannelModel(bot, useAgentsStore.getState().list);
		if (model) void initSessionModel(currentSessionId, model);
	}, [currentSessionId, conversations, bots, agents, initSessionModel]);
}
