// WebAudio 提示音：任务完成（真实音频）/ 需要操作（代码生成蜂鸣）。
// 浏览器自动播放策略阻止（AudioContext 创建失败/挂起、audio.play() 被拒）时静默降级，不报错。
import { useUiPrefsStore } from "../store/ui-prefs";

let ctx: AudioContext | null = null;
let lastNeedsActionAt = 0;

/** 需要操作提示音去抖窗口：同一轮可能连续出现多个 ask 事件，避免叠加轰炸。 */
const NEEDS_ACTION_DEBOUNCE_MS = 500;

function getCtx(): AudioContext | null {
	try {
		if (!ctx) {
			const AC = (globalThis as any).AudioContext;
			if (!AC) return null;
			ctx = new AC();
		}
		// resume() 返回 Promise：自动播放策略阻止时（如 Safari）会 reject，必须捕获，否则产生 unhandled rejection 控制台报错
		if (ctx!.state === "suspended") void ctx!.resume().catch(() => {});
		return ctx;
	} catch {
		return null;
	}
}

/** 在 startSec 偏移处播放 freq Hz、durationSec 的短音（简单包络防爆音）。 */
function beep(
	ac: AudioContext,
	freq: number,
	startSec: number,
	durationSec: number,
) {
	const osc = ac.createOscillator();
	const gain = ac.createGain();
	osc.type = "sine";
	osc.frequency.value = freq;
	const t0 = ac.currentTime + startSec;
	gain.gain.setValueAtTime(0, t0);
	gain.gain.linearRampToValueAtTime(0.15, t0 + 0.01);
	gain.gain.linearRampToValueAtTime(0, t0 + durationSec);
	osc.connect(gain);
	gain.connect(ac.destination);
	osc.start(t0);
	osc.stop(t0 + durationSec + 0.05);
}

/** 任务完成提示音随机池：6 个新音效（各截取前 1 秒，public/ 资源）。原青蛙叫与 event-done-3 重复，已移除，只用新音效。 */
export const TASK_DONE_SOUND_POOL: string[] = [
	"/sounds/event-done-1.mp3",
	"/sounds/event-done-2.mp3",
	"/sounds/event-done-3.mp3",
	"/sounds/event-done-4.mp3",
	"/sounds/event-done-5.mp3",
	"/sounds/event-done-6.mp3",
];

/** 从随机池中等概率选一个音效。 */
function pickTaskDoneSound(): string {
	return TASK_DONE_SOUND_POOL[
		Math.floor(Math.random() * TASK_DONE_SOUND_POOL.length)
	];
}

/** 任务完成音色：从随机池播放一个音效（受自动播放策略影响时静默降级）。 */
function taskDoneSound() {
	try {
		const audio = new Audio(pickTaskDoneSound());
		audio.volume = 0.8;
		void audio.play().catch(() => {});
	} catch {
		/* 静默降级 */
	}
}

/** 需要操作音色：660Hz 短音两次。 */
function needsActionSound() {
	const ac = getCtx();
	if (!ac) return;
	try {
		beep(ac, 660, 0, 0.1);
		beep(ac, 660, 0.18, 0.1);
	} catch {
		/* 静默降级 */
	}
}

/** 事件触发：任务完成提示音。受 soundTaskDone 开关控制。 */
export function playTaskDone(): void {
	if (!useUiPrefsStore.getState().soundTaskDone) return;
	taskDoneSound();
}

/** 事件触发：需要操作提示音。受 soundNeedsAction 开关控制，500ms 去抖。 */
export function playNeedsAction(): void {
	if (!useUiPrefsStore.getState().soundNeedsAction) return;
	const now = Date.now();
	if (now - lastNeedsActionAt < NEEDS_ACTION_DEBOUNCE_MS) return;
	lastNeedsActionAt = now;
	needsActionSound();
}

/** 设置页试听：不受开关控制，让用户关着开关也能听到音色。 */
export function previewTaskDone(): void {
	taskDoneSound();
}

export function previewNeedsAction(): void {
	needsActionSound();
}

/** 测试用：重置模块内 AudioContext 单例与去抖时间戳。 */
export function resetSoundForTests(): void {
	ctx = null;
	lastNeedsActionAt = 0;
}
