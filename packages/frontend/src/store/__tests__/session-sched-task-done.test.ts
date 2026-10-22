// 定时任务完成的声音/动画门禁测试（bun:test）：
// 定时任务执行会话（sessionId 以 sched- 前缀，kernel scheduler 硬编码生成）到达 agent_end 时：
// - 提示音由独立开关 soundSchedTaskDone 控制（默认 false = 默认不响）
// - 青蛙动画一律不触发（需求：定时任务完成不需要动画，无开关）
// 普通会话与 IM 会话行为不变（回归保护）。
import { beforeEach, expect, mock, test } from "bun:test";

// mock 声音/青蛙（记录调用；避免 Audio 副作用）
const playTaskDone = mock();
const triggerTaskDoneFrog = mock();
mock.module("../../util/sound", () => ({
	playTaskDone,
	playNeedsAction: mock(),
	previewTaskDone: mock(),
}));
mock.module("../../util/frog", () => ({
	triggerTaskDoneFrog,
}));

import { useSessionStore } from "../session";
import { useUiPrefsStore } from "../ui-prefs";

beforeEach(() => {
	playTaskDone.mockClear();
	triggerTaskDoneFrog.mockClear();
	// 真实 ui-prefs store：重置为本测试关注的状态（soundSchedTaskDone 默认 false）
	useUiPrefsStore.setState({ soundTaskDone: true, soundSchedTaskDone: false });
});

function agentEnd(sessionId: string, willRetry?: boolean) {
	return {
		type: "sdk:event",
		projectId: "p",
		sessionId,
		agentName: "研发",
		event: willRetry ? { type: "agent_end", willRetry } : { type: "agent_end" },
	} as any;
}

test("sched- 会话 agent_end 默认：不播提示音、不触发青蛙动画", () => {
	useSessionStore
		.getState()
		.handleSDKEvent("sched-t1-123", agentEnd("sched-t1-123"));
	expect(playTaskDone).not.toHaveBeenCalled();
	expect(triggerTaskDoneFrog).not.toHaveBeenCalled();
});

test("sched- 会话 + soundSchedTaskDone=true：播提示音、仍不触发青蛙动画", () => {
	useUiPrefsStore.setState({ soundSchedTaskDone: true });
	useSessionStore
		.getState()
		.handleSDKEvent("sched-t1-456", agentEnd("sched-t1-456"));
	expect(playTaskDone).toHaveBeenCalledTimes(1);
	expect(triggerTaskDoneFrog).not.toHaveBeenCalled();
});

test("普通会话 agent_end：行为不变（提示音 + 青蛙动画）", () => {
	useSessionStore.getState().handleSDKEvent("s-normal", agentEnd("s-normal"));
	expect(playTaskDone).toHaveBeenCalledTimes(1);
	expect(triggerTaskDoneFrog).toHaveBeenCalledTimes(1);
});

test("im- 会话 agent_end：不播提示音、不触发动画（回归保护）", () => {
	useSessionStore.getState().handleSDKEvent("im-ch-1", agentEnd("im-ch-1"));
	expect(playTaskDone).not.toHaveBeenCalled();
	expect(triggerTaskDoneFrog).not.toHaveBeenCalled();
});

test("willRetry=true 的中间态：任何会话都不触发（回归保护）", () => {
	useSessionStore
		.getState()
		.handleSDKEvent("s-normal", agentEnd("s-normal", true));
	useSessionStore
		.getState()
		.handleSDKEvent("sched-t1-789", agentEnd("sched-t1-789", true));
	expect(playTaskDone).not.toHaveBeenCalled();
	expect(triggerTaskDoneFrog).not.toHaveBeenCalled();
});
