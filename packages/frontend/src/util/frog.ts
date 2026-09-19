// 任务完成青蛙动画：随机变体 + 随机聊天区位置生成器（纯函数）。
// 每个字段随 rng 可注入，便于测试确定性与覆盖度验证。
import { useFrogStore, type FrogBurst } from "../store/frog";
import { useUiPrefsStore } from "../store/ui-prefs";
import { useProjectsStore } from "../store/projects";

/** 动画变体（每次任务完成随机一种，不与上一次重复）。 */
export type FrogVariant =
	| "bounce"
	| "backflip"
	| "roll"
	| "lily"
	| "parachute"
	| "well"
	| "surf"
	| "spa"
	| "slingshot"
	| "flowers"
	| "sign"
	| "salute"
	| "tongue"
	| "sketch"
	| "pixel"
	| "magic"
	| "tadpole"
	| "chorus"
	| "gong";

/** 聊天区出现位置：上左/上中/上右/中左/中右/下左/下中/下右。 */
export type FrogSpot = "ul" | "um" | "ur" | "ml" | "mr" | "dl" | "dm" | "dr";

/** 合法变体集合。 */
export const FROG_VARIANTS: FrogVariant[] = [
	"bounce",
	"backflip",
	"roll",
	"lily",
	"parachute",
	"well",
	"surf",
	"spa",
	"slingshot",
	"flowers",
	"sign",
	"salute",
	"tongue",
	"sketch",
	"pixel",
	"magic",
	"tadpole",
	"chorus",
	"gong",
];

/** 合法位置集合（上左/上中/上右/中左/中右/下左/下中/下右）。 */
export const FROG_SPOTS: FrogSpot[] = [
	"ul",
	"um",
	"ur",
	"ml",
	"mr",
	"dl",
	"dm",
	"dr",
];

/** 上一次选中的变体：保证连续两次不重复（19 个差异大，重复观感明显）。 */
let lastVariant: FrogVariant | null = null;

/** 从集合中随机挑一个变体，不与上一次相同。rng 可注入以便测试。 */
export function pickFrogVariant(rng: () => number = Math.random): FrogVariant {
	const pool = FROG_VARIANTS.filter((v) => v !== lastVariant);
	const i = Math.floor(rng() * pool.length);
	const v = pool[i] ?? pool[0];
	lastVariant = v;
	return v;
}

/** 从集合中随机挑一个位置。rng 可注入以便测试。 */
export function pickFrogSpot(rng: () => number = Math.random): FrogSpot {
	const i = Math.floor(rng() * FROG_SPOTS.length);
	return FROG_SPOTS[i] ?? FROG_SPOTS[0];
}

/** 重置变体轮换记忆（仅测试用：隔离用例间的 lastVariant 状态）。 */
export function resetFrogVariantCycle(): void {
	lastVariant = null;
}

/** 触发一次任务完成青蛙动画：检查开关、仅当触发会话是当前会话才生效，并写入 store。
 *  返回生成的 burst；关闭开关或非当前会话时返回 null。 */
export function triggerTaskDoneFrog(sessionId: string): FrogBurst | null {
	if (!useUiPrefsStore.getState().frogTaskDone) return null;
	// 只有用户正在看这个会话（即该会话就是当前会话），青蛙才会出现在该会话的聊天区内。
	if (sessionId !== useProjectsStore.getState().currentSessionId) return null;
	const burst: FrogBurst = {
		id: ++burstSeq,
		variant: pickFrogVariant(),
		spot: pickFrogSpot(),
		sessionId,
		createdAt: Date.now(),
	};
	useFrogStore.getState().setCurrent(burst);
	return burst;
}

let burstSeq = 0;
