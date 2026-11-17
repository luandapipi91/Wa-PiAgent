// IM 会话机器人模型解析（进入 IM 会话时输入框模型同步为机器人实际用模）：
// 与 kernel channel-manager.ts 入站解析保持一致——channel.model ?? agent.model，
// agent 按 agentName 匹配、已被删除时降级取 agents[0]；两者都未配置返回 null
// （= 跟随全局默认模型，前端维持现有回退行为）。
import { test, expect } from "bun:test";
import { resolveChannelModel } from "./channel-model";

const agents = [
	{ displayName: "验收机器人2", model: "prov/agent-model" },
	{ displayName: "慧来客迭代", model: null },
];

test("机器人配置了模型 → 直接用机器人模型（channel.model 优先）", () => {
	expect(
		resolveChannelModel(
			{ model: "prov/bot-model", agentName: "验收机器人2" },
			agents,
		),
	).toBe("prov/bot-model");
});

test("机器人模型为 null → 回退关联智能体的模型（channel.model ?? agent.model）", () => {
	expect(
		resolveChannelModel({ model: null, agentName: "验收机器人2" }, agents),
	).toBe("prov/agent-model");
});

test("机器人与关联智能体都没配模型 → null（跟随全局默认，维持现状）", () => {
	expect(
		resolveChannelModel({ model: null, agentName: "慧来客迭代" }, agents),
	).toBeNull();
});

test("关联智能体已被删除 → 降级取第一个智能体的模型（复刻 kernel resolveAgent 降级）", () => {
	expect(
		resolveChannelModel({ model: null, agentName: "已被删除的智能体" }, agents),
	).toBe("prov/agent-model");
});

test("智能体模型为空串 → 视为未配置，返回 null（AgentConfig.model 空串=跟随全局）", () => {
	expect(
		resolveChannelModel(
			{ model: null, agentName: "空模型" },
			[{ displayName: "空模型", model: "" }],
		),
	).toBeNull();
});

test("找不到机器人（会话数据晚于机器人删除）→ null", () => {
	expect(resolveChannelModel(undefined, agents)).toBeNull();
});

test("系统内无智能体可用 → null", () => {
	expect(
		resolveChannelModel({ model: null, agentName: "任意" }, []),
	).toBeNull();
});
