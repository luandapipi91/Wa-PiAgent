// 触发函数：triggerTaskDoneFrog(sessionId) 开关判断 + 当前会话判断 + 写入 frog store。
import { beforeEach, expect, test } from "bun:test";
import {
	FROG_SPOTS,
	FROG_VARIANTS,
	resetFrogVariantCycle,
	triggerTaskDoneFrog,
} from "../src/util/frog";
import { useFrogStore } from "../src/store/frog";
import { FROG_TASK_DONE_DEFAULT, useUiPrefsStore } from "../src/store/ui-prefs";
import { useProjectsStore } from "../src/store/projects";

beforeEach(() => {
	resetFrogVariantCycle();
	useUiPrefsStore.setState({ frogTaskDone: FROG_TASK_DONE_DEFAULT });
	useFrogStore.setState({ current: null });
	useProjectsStore.setState({ currentSessionId: "s1" });
});

test("当前会话触发：返回 burst 并写入 store，变体/位置/会话 ID 合法", () => {
	const burst = triggerTaskDoneFrog("s1");
	expect(burst).not.toBeNull();
	expect(useFrogStore.getState().current).toEqual(burst);
	expect(FROG_VARIANTS).toContain(burst!.variant);
	expect(FROG_SPOTS).toContain(burst!.spot);
	expect(burst!.sessionId).toBe("s1");
	expect(typeof burst!.id).toBe("number");
});

test("非当前会话（sessionId ≠ currentSessionId）→ 返回 null 且不写入", () => {
	expect(triggerTaskDoneFrog("other")).toBeNull();
	expect(useFrogStore.getState().current).toBeNull();
});

test("开关关闭 → 返回 null 且不写入", () => {
	useUiPrefsStore.getState().setFrogTaskDone(false);
	expect(triggerTaskDoneFrog("s1")).toBeNull();
	expect(useFrogStore.getState().current).toBeNull();
});
