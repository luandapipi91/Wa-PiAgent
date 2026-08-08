import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	playNeedsAction,
	playTaskDone,
	previewNeedsAction,
	previewTaskDone,
	resetSoundForTests,
} from "../src/util/sound";
import { useUiPrefsStore } from "../src/store/ui-prefs";

// 假 AudioContext：记录 oscillator 的频率与启停时刻
interface BeepRecord {
	freq: number;
	startSec: number;
	stopSec: number;
}
const beeps: BeepRecord[] = [];

class FakeAudioContext {
	state = "running";
	currentTime = 0;
	destination = {};
	resume() {
		return Promise.resolve();
	}
	createOscillator() {
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
	beeps.length = 0;
	resetSoundForTests();
	(globalThis as any).AudioContext = FakeAudioContext;
	useUiPrefsStore.setState({ soundTaskDone: true, soundNeedsAction: true });
});

afterEach(() => {
	delete (globalThis as any).AudioContext;
});

test("playTaskDone：开关开 → 播放上行两音（880 → 1320Hz）", () => {
	playTaskDone();
	expect(beeps).toHaveLength(2);
	expect(beeps[0].freq).toBe(880);
	expect(beeps[1].freq).toBe(1320);
});

test("playTaskDone：开关关 → 不播放", () => {
	useUiPrefsStore.getState().setSoundTaskDone(false);
	playTaskDone();
	expect(beeps).toHaveLength(0);
});

test("previewTaskDone：开关关也能试听", () => {
	useUiPrefsStore.getState().setSoundTaskDone(false);
	previewTaskDone();
	expect(beeps).toHaveLength(2);
});

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

test("AudioContext 不存在（老环境/策略阻止）→ 静默不抛错", () => {
	delete (globalThis as any).AudioContext;
	expect(() => playTaskDone()).not.toThrow();
	expect(() => playNeedsAction()).not.toThrow();
});
