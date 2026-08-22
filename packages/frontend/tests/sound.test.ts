import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	playNeedsAction,
	playTaskDone,
	previewNeedsAction,
	previewTaskDone,
	resetSoundForTests,
} from "../src/util/sound";
import { useUiPrefsStore } from "../src/store/ui-prefs";

// --- Fake Audio：任务完成提示音改为播放真实 mp3（HTMLAudioElement）---
let audioCalls: { url: string; volume: number }[] = [];
// 模拟自动播放策略阻止 play() 返回的 promise reject
let fakePlayRejects = false;
class FakeAudio {
	url: string;
	volume = 0;
	constructor(url: string) {
		this.url = url;
		audioCalls.push({ url, volume: this.volume });
	}
	play() {
		if (fakePlayRejects) {
			return Promise.reject(new Error("mock: 自动播放策略阻止 play"));
		}
		return Promise.resolve();
	}
}

// --- Fake AudioContext：需要操作提示音仍用 Web Audio 合成 ---
interface BeepRecord {
	freq: number;
	startSec: number;
	stopSec: number;
}
const beeps: BeepRecord[] = [];

// 可配置的 Fake 行为：分别模拟 suspended / resume 被策略拒绝 / createOscillator 抛错 / 构造抛错
let fakeState = "running";
let fakeResumeRejects = false;
let fakeThrowOnCreateOscillator = false;
let fakeCtx: FakeAudioContext | null = null;
// 记录 sound.ts 是否对 resume() 返回的 promise 调用了 .catch（锁定重要 1 的修复）
let resumeCatchCalled = false;

class FakeAudioContext {
	state = fakeState;
	resumeCalls = 0;
	currentTime = 0;
	destination = {};
	constructor() {
		fakeCtx = this;
	}
	resume() {
		this.resumeCalls++;
		if (fakeResumeRejects) {
			// 返回一个可追踪 .catch 调用的伪 promise：模拟 Safari 自动播放策略阻止 resume()
			const p = Promise.reject(new Error("mock: 自动播放策略阻止 resume"));
			return {
				catch: (fn: () => void) => {
					resumeCatchCalled = true;
					return p.catch(fn);
				},
			} as unknown as Promise<void>;
		}
		this.state = "running";
		return Promise.resolve();
	}
	createOscillator() {
		if (fakeThrowOnCreateOscillator) {
			throw new Error("mock: createOscillator 失败");
		}
		const rec: BeepRecord = { freq: 0, startSec: 0, stopSec: 0 };
		beeps.push(rec);
		return {
			type: "",
			frequency: {
				set value(v: number) {
					rec.freq = v;
				},
			},
			connect() {},
			start(t: number) {
				rec.startSec = t;
			},
			stop(t: number) {
				rec.stopSec = t;
			},
		};
	}
	createGain() {
		return {
			gain: {
				setValueAtTime() {},
				linearRampToValueAtTime() {},
			},
			connect() {},
		};
	}
}

beforeEach(() => {
	audioCalls = [];
	fakePlayRejects = false;
	beeps.length = 0;
	fakeState = "running";
	fakeResumeRejects = false;
	fakeThrowOnCreateOscillator = false;
	fakeCtx = null;
	resumeCatchCalled = false;
	resetSoundForTests();
	(globalThis as any).Audio = FakeAudio;
	(globalThis as any).AudioContext = FakeAudioContext;
	useUiPrefsStore.setState({ soundTaskDone: true, soundNeedsAction: true });
});

afterEach(() => {
	delete (globalThis as any).Audio;
	delete (globalThis as any).AudioContext;
});

// --- 任务完成提示音：播放青蛙叫 mp3 ---
test("playTaskDone：开关开 → 播放青蛙叫音频（frog-croak.mp3）", () => {
	playTaskDone();
	expect(audioCalls).toHaveLength(1);
	expect(audioCalls[0].url).toContain("frog-croak.mp3");
});

test("playTaskDone：开关关 → 不播放", () => {
	useUiPrefsStore.getState().setSoundTaskDone(false);
	playTaskDone();
	expect(audioCalls).toHaveLength(0);
});

test("previewTaskDone：开关关也能试听", () => {
	useUiPrefsStore.getState().setSoundTaskDone(false);
	previewTaskDone();
	expect(audioCalls).toHaveLength(1);
});

test("playTaskDone：play() 被自动播放策略拒绝 → 静默不抛错", () => {
	fakePlayRejects = true;
	expect(() => playTaskDone()).not.toThrow();
	expect(audioCalls).toHaveLength(1);
});

// --- 需要操作提示音：Web Audio 合成 ---
test("playNeedsAction：开关开 → 660Hz 短音两次", () => {
	playNeedsAction();
	expect(beeps).toHaveLength(2);
	expect(beeps[0].freq).toBe(660);
	expect(beeps[1].freq).toBe(660);
});

test("playNeedsAction：500ms 内去抖，第二次不播放", () => {
	playNeedsAction();
	playNeedsAction();
	expect(beeps).toHaveLength(2);
});

test("playNeedsAction：开关关 → 不播放", () => {
	useUiPrefsStore.getState().setSoundNeedsAction(false);
	playNeedsAction();
	expect(beeps).toHaveLength(0);
});

test("previewNeedsAction：开关关也能试听，且不受去抖影响", () => {
	useUiPrefsStore.getState().setSoundNeedsAction(false);
	previewNeedsAction();
	previewNeedsAction();
	expect(beeps).toHaveLength(4);
});

// --- 异常降级 ---
test("AudioContext 不存在（老环境/策略阻止）→ 静默不抛错", () => {
	delete (globalThis as any).AudioContext;
	expect(() => playTaskDone()).not.toThrow();
	expect(() => playNeedsAction()).not.toThrow();
});

test("state=suspended → 调用 resume 且 needsAction 播放不抛错", () => {
	fakeState = "suspended";
	expect(() => playNeedsAction()).not.toThrow();
	expect(fakeCtx!.resumeCalls).toBe(1);
	expect(beeps).toHaveLength(2);
});

test("resume 被自动播放策略拒绝 → sound.ts 捕获其 rejection，静默降级不抛错", () => {
	fakeState = "suspended";
	fakeResumeRejects = true;
	expect(() => playNeedsAction()).not.toThrow();
	expect(fakeCtx!.resumeCalls).toBe(1);
	// 锁定修复：必须对 resume() 的 promise 调用 .catch，否则控制台会报 unhandled rejection
	expect(resumeCatchCalled).toBe(true);
	expect(beeps).toHaveLength(2);
});

test("createOscillator 抛错 → playNeedsAction 静默降级不抛错", () => {
	fakeThrowOnCreateOscillator = true;
	expect(() => playNeedsAction()).not.toThrow();
	expect(beeps).toHaveLength(0);
});

test("AudioContext 构造函数抛错 → 静默降级不抛错", () => {
	class ThrowingAudioContext {
		constructor() {
			throw new Error("mock: AudioContext 创建失败");
		}
	}
	(globalThis as any).AudioContext = ThrowingAudioContext;
	expect(() => playTaskDone()).not.toThrow();
	expect(() => playNeedsAction()).not.toThrow();
	expect(beeps).toHaveLength(0);
});
