// 任务完成青蛙动画：随机姿势 + 随机聊天区角落生成器（纯函数）。
// 每个字段随 rng 可注入，便于测试确定性与覆盖度验证。
import { useFrogStore, type FrogBurst } from "../store/frog";
import { useUiPrefsStore } from "../store/ui-prefs";
import { useProjectsStore } from "../store/projects";

/** 青蛙姿势（每次任务完成随机一种，保证形态/姿势不同）。 */
export type FrogPose = "jump" | "sit" | "wave" | "sleep";

/** 青蛙出现在聊天区域的哪个角（随机）。 */
export type FrogCorner = "tl" | "tr" | "bl" | "br";

/** 合法姿势集合。 */
export const FROG_POSES: FrogPose[] = ["jump", "sit", "wave", "sleep"];

/** 合法角落集合（左上/右上/左下/右下）。 */
export const FROG_CORNERS: FrogCorner[] = ["tl", "tr", "bl", "br"];

/** 从集合中随机挑一个姿势。rng 可注入以便测试。 */
export function pickFrogPose(rng: () => number = Math.random): FrogPose {
	const i = Math.floor(rng() * FROG_POSES.length);
	return FROG_POSES[i] ?? FROG_POSES[0];
}

/** 从集合中随机挑一个聊天区角落。rng 可注入以便测试。 */
export function pickFrogCorner(rng: () => number = Math.random): FrogCorner {
	const i = Math.floor(rng() * FROG_CORNERS.length);
	return FROG_CORNERS[i] ?? FROG_CORNERS[0];
}

let burstSeq = 0;

/** 触发一次任务完成青蛙动画：检查开关、仅当触发会话是当前会话才生效，并写入 store。
 *  返回生成的 burst；关闭开关或非当前会话时返回 null。 */
export function triggerTaskDoneFrog(sessionId: string): FrogBurst | null {
	if (!useUiPrefsStore.getState().frogTaskDone) return null;
	// 只有用户正在看这个会话（即该会话就是当前会话），青蛙才会出现在该会话的聊天区内。
	if (sessionId !== useProjectsStore.getState().currentSessionId) return null;
	const burst: FrogBurst = {
		id: ++burstSeq,
		pose: pickFrogPose(),
		corner: pickFrogCorner(),
		sessionId,
		createdAt: Date.now(),
	};
	useFrogStore.getState().setCurrent(burst);
	return burst;
}
