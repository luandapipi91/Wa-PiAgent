# 提示音设置（任务完成 / 需要操作）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在系统设置「通用」分区新增「任务完成」「需要操作」两个提示音开关（各带试听），并在对应事件发生时用 WebAudio 蜂鸣提示。

**Architecture:** 纯前端方案。`ui-prefs`（zustand persist）存两个开关；新增 `src/util/sound.ts` WebAudio 播放器；在 `session.ts` 的 `agent_end` 终态分支与 `message_end`（含新 `ask_user_question` 工具调用）处接线触发；`GeneralSection.tsx` 加 UI（即时生效，不走保存草稿流）。

**Tech Stack:** React 19 + zustand 5 + i18next；测试栈为 **bun:test**（非 vitest）+ @testing-library/react + happy-dom；E2E 为 Playwright。

**Spec:** `docs/superpowers/specs/2026-08-08-sound-notification-design.md`

## Global Constraints

- 所有回复/代码注释用中文；标识符保持英文语义化命名。
- 测试栈是 `bun:test`（`bun --env-file=.env.test test --isolate`，在 `packages/frontend` 下执行），不是 vitest。
- 前端工具目录是 `packages/frontend/src/util/`（**单数**，spec 中写的 `utils/` 以本计划为准）。
- 提示音总是播放（不判断窗口聚焦）；浏览器自动播放策略阻止时静默降级，不报错、不弹 toast。
- 默认两个开关都为 `true`。
- 缩进风格跟随各文件现状：`ui-prefs.ts` / `session.ts` / `zh.ts` / `en.ts` 用 tab，`GeneralSection.tsx` 用 tab。
- 每个 Task 完成后按步骤 commit；commit message 用中文 conventional 格式（参照 git log 现状，如 `feat(frontend): ...`）。

---

### Task 1: ui-prefs 新增两个提示音开关

**Files:**
- Modify: `packages/frontend/src/store/ui-prefs.ts`
- Test: `packages/frontend/tests/store-ui-prefs-sound.test.ts`（新建）

**Interfaces:**
- Consumes: 无
- Produces:
  - `UiPrefsState.soundTaskDone: boolean`（默认 `true`）、`setSoundTaskDone(v: boolean): void`
  - `UiPrefsState.soundNeedsAction: boolean`（默认 `true`）、`setSoundNeedsAction(v: boolean): void`
  - 常量 `SOUND_TASK_DONE_DEFAULT = true`、`SOUND_NEEDS_ACTION_DEFAULT = true`
  - 后续 Task 2/4 依赖以上名字，不得改名。

- [ ] **Step 1: 写失败测试**

新建 `packages/frontend/tests/store-ui-prefs-sound.test.ts`：

```ts
import { beforeEach, expect, test } from "bun:test";
import {
	SOUND_NEEDS_ACTION_DEFAULT,
	SOUND_TASK_DONE_DEFAULT,
	useUiPrefsStore,
} from "../src/store/ui-prefs";

beforeEach(() => {
	localStorage.clear();
	useUiPrefsStore.setState({
		soundTaskDone: SOUND_TASK_DONE_DEFAULT,
		soundNeedsAction: SOUND_NEEDS_ACTION_DEFAULT,
	});
});

test("提示音开关默认均为 true", () => {
	expect(SOUND_TASK_DONE_DEFAULT).toBe(true);
	expect(SOUND_NEEDS_ACTION_DEFAULT).toBe(true);
	expect(useUiPrefsStore.getState().soundTaskDone).toBe(true);
	expect(useUiPrefsStore.getState().soundNeedsAction).toBe(true);
});

test("setSoundTaskDone：更新状态并持久化到 localStorage", () => {
	useUiPrefsStore.getState().setSoundTaskDone(false);
	expect(useUiPrefsStore.getState().soundTaskDone).toBe(false);
	const raw = localStorage.getItem("wa-pi-ui-prefs");
	expect(raw).toBeTruthy();
	expect(JSON.parse(raw!).state.soundTaskDone).toBe(false);
	// 不影响另一个开关
	expect(useUiPrefsStore.getState().soundNeedsAction).toBe(true);
});

test("setSoundNeedsAction：更新状态并持久化到 localStorage", () => {
	useUiPrefsStore.getState().setSoundNeedsAction(false);
	expect(useUiPrefsStore.getState().soundNeedsAction).toBe(false);
	const raw = localStorage.getItem("wa-pi-ui-prefs");
	expect(JSON.parse(raw!).state.soundNeedsAction).toBe(false);
	expect(useUiPrefsStore.getState().soundTaskDone).toBe(true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/frontend && bun --env-file=.env.test test --isolate tests/store-ui-prefs-sound.test.ts`
Expected: FAIL（`SOUND_TASK_DONE_DEFAULT` 等导出不存在）

- [ ] **Step 3: 实现**

修改 `packages/frontend/src/store/ui-prefs.ts`：

1. `UiPrefsState` 接口末尾（`setLanguage` 之后）追加：

```ts
	/** 任务完成提示音开关（默认 true），即时生效。 */
	soundTaskDone: boolean;
	setSoundTaskDone: (v: boolean) => void;
	/** 需要操作（ask_user_question 待回答）提示音开关（默认 true），即时生效。 */
	soundNeedsAction: boolean;
	setSoundNeedsAction: (v: boolean) => void;
```

2. 常量区（`LANGUAGE_DEFAULT` 之后）追加：

```ts
export const SOUND_TASK_DONE_DEFAULT = true;
export const SOUND_NEEDS_ACTION_DEFAULT = true;
```

3. `create<UiPrefsState>()(persist((set) => ({ ... })))` 的状态对象末尾（`setLanguage` 实现之后）追加：

```ts
			soundTaskDone: SOUND_TASK_DONE_DEFAULT,
			setSoundTaskDone: (v) => set({ soundTaskDone: v }),
			soundNeedsAction: SOUND_NEEDS_ACTION_DEFAULT,
			setSoundNeedsAction: (v) => set({ soundNeedsAction: v }),
```

说明：zustand persist 默认浅合并，旧的 localStorage 数据没有这两个字段时会用初始值兜底，无需 migration。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/frontend && bun --env-file=.env.test test --isolate tests/store-ui-prefs-sound.test.ts tests/store-ui-prefs.test.ts`
Expected: PASS（新旧测试都过）

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/store/ui-prefs.ts packages/frontend/tests/store-ui-prefs-sound.test.ts
git commit -m "feat(frontend): ui-prefs 新增任务完成/需要操作提示音开关"
```

---

### Task 2: WebAudio 提示音播放器 util/sound.ts

**Files:**
- Create: `packages/frontend/src/util/sound.ts`
- Test: `packages/frontend/tests/sound.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `useUiPrefsStore.getState().soundTaskDone / .soundNeedsAction`
- Produces（后续 Task 3/4 依赖，不得改名）:
  - `playTaskDone(): void` — 受 `soundTaskDone` 开关控制；上行两音 880→1320Hz
  - `playNeedsAction(): void` — 受 `soundNeedsAction` 开关控制 + 500ms 去抖；660Hz 两次
  - `previewTaskDone(): void` — 试听，**不受开关控制**
  - `previewNeedsAction(): void` — 试听，不受开关控制、不去抖
  - `resetSoundForTests(): void` — 重置模块内 AudioContext 单例与去抖时间戳

- [ ] **Step 1: 写失败测试**

新建 `packages/frontend/tests/sound.test.ts`。happy-dom 无 AudioContext，用假实现注入 `globalThis`：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/frontend && bun --env-file=.env.test test --isolate tests/sound.test.ts`
Expected: FAIL（`../src/util/sound` 模块不存在）

- [ ] **Step 3: 实现**

新建 `packages/frontend/src/util/sound.ts`：

```ts
// WebAudio 提示音：任务完成 / 需要操作。无音频资源文件，代码生成蜂鸣。
// 浏览器自动播放策略阻止（AudioContext 创建失败/挂起）时静默降级，不报错。
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
		if (ctx!.state === "suspended") void ctx!.resume();
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

/** 任务完成音色：上行两音（880 → 1320Hz，各 120ms）。 */
function taskDoneSound() {
	const ac = getCtx();
	if (!ac) return;
	try {
		beep(ac, 880, 0, 0.12);
		beep(ac, 1320, 0.14, 0.12);
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/frontend && bun --env-file=.env.test test --isolate tests/sound.test.ts`
Expected: PASS（9 个用例全过）

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/util/sound.ts packages/frontend/tests/sound.test.ts
git commit -m "feat(frontend): WebAudio 提示音播放器 sound.ts"
```

---

### Task 3: session.ts 接线两个触发点

**Files:**
- Modify: `packages/frontend/src/store/session.ts`（`agent_end` 分支约 :874-879；`message_end` 分支约 :752-771）
- Test: `packages/frontend/tests/session-sound.test.ts`（新建）

**Interfaces:**
- Consumes: Task 2 的 `playTaskDone()` / `playNeedsAction()`
- Produces: 无新导出

- [ ] **Step 1: 写失败测试**

新建 `packages/frontend/tests/session-sound.test.ts`。参照 `tests/store-session.test.ts` 的写法：mock api-client，用 `handleSDKEvent` 注入事件信封；同时 mock `../src/util/sound` 记录调用次数。

```ts
// 提示音触发接线：agent_end 终态 → playTaskDone；新 ask_user_question → playNeedsAction
import { beforeEach, expect, mock, test } from "bun:test";
import type { SDKEventEnvelope } from "@wa-pi/shared";

const soundCalls = { taskDone: 0, needsAction: 0 };

mock.module("../src/util/sound", () => ({
	playTaskDone: () => soundCalls.taskDone++,
	playNeedsAction: () => soundCalls.needsAction++,
	previewTaskDone: () => {},
	previewNeedsAction: () => {},
	resetSoundForTests: () => {},
}));

// session store 会经 api-client 拉历史/统计，mock 掉避免真实请求
mock.module("../src/api-client", () => ({
	api: {
		get: () => Promise.resolve({ messages: [] }),
		post: () => Promise.resolve({}),
		put: () => Promise.resolve({}),
		del: () => Promise.resolve({}),
	},
}));

import { useSessionStore } from "../src/store/session";
import { useProjectsStore } from "../src/store/projects";

function envelope(
	event: SDKEventEnvelope["event"],
	sessionId = "s1",
): SDKEventEnvelope {
	return {
		type: "sdk:event",
		projectId: "p1",
		sessionId,
		agentName: "dev",
		event,
	};
}

beforeEach(() => {
	soundCalls.taskDone = 0;
	soundCalls.needsAction = 0;
	useSessionStore.setState({
		messagesBySession: {},
		streamingBySession: {},
		statusBySession: {},
		thinkingSinceBySession: {},
		retryBySession: {},
		optimisticEchoBySession: {},
		unreadBySession: {},
		lastUsageBySession: {},
	});
	useProjectsStore.setState({ currentSessionId: "s1" });
});

test("agent_end 终态（willRetry:false）→ 播放任务完成提示音一次", () => {
	useSessionStore
		.getState()
		.handleSDKEvent("s1", envelope({ type: "agent_end", willRetry: false } as any));
	expect(soundCalls.taskDone).toBe(1);
});

test("agent_end 中间态（willRetry:true，自动重试退避中）→ 不播放", () => {
	useSessionStore
		.getState()
		.handleSDKEvent("s1", envelope({ type: "agent_end", willRetry: true } as any));
	expect(soundCalls.taskDone).toBe(0);
});

test("message_end 含新 ask_user_question 工具调用 → 播放需要操作提示音", () => {
	useSessionStore.getState().handleSDKEvent(
		"s1",
		envelope({
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc-1",
						name: "ask_user_question",
						arguments: { question: "选哪个？" },
					},
				],
			},
		} as any),
	);
	expect(soundCalls.needsAction).toBe(1);
});

test("message_end 普通文本回复 → 不播放需要操作提示音", () => {
	useSessionStore.getState().handleSDKEvent(
		"s1",
		envelope({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "你好" }],
			},
		} as any),
	);
	expect(soundCalls.needsAction).toBe(0);
});

test("message_end toolResult → 不播放需要操作提示音", () => {
	useSessionStore.getState().handleSDKEvent(
		"s1",
		envelope({
			type: "message_end",
			message: { role: "toolResult", toolCallId: "tc-1", content: [] },
		} as any),
	);
	expect(soundCalls.needsAction).toBe(0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/frontend && bun --env-file=.env.test test --isolate tests/session-sound.test.ts`
Expected: FAIL（`soundCalls.taskDone` / `needsAction` 均为 0，因为 session.ts 尚未调用）

- [ ] **Step 3: 实现**

修改 `packages/frontend/src/store/session.ts`：

1. 文件顶部 import 区追加（与既有 relative import 并列）：

```ts
import { playNeedsAction, playTaskDone } from "../util/sound";
```

2. `case "agent_end": {` 分支（约 :874-879），在 `if (event.willRetry === true) break;` 之后追加一行：

```ts
					if (event.willRetry === true) break;
					// 任务完成提示音：仅终态播放（自动重试中间态上面已 break）
					playTaskDone();
```

3. `case "message_end": {` 分支（约 :771），在 `if (msg.role !== "assistant") break;` 之后追加：

```ts
					if (msg.role !== "assistant") break;
					// 需要操作提示音：assistant 消息含新的 ask_user_question 工具调用时播放。
					// 历史消息经 api 加载直接 set、不经过 message_end，不会误触发。
					if (
						Array.isArray(msg.content) &&
						msg.content.some(
							(b: any) => b?.type === "toolCall" && b.name === "ask_user_question",
						)
					) {
						playNeedsAction();
					}
```

说明：SDK 对同 turn 的每个 block 发独立 message_end，含 ask_user_question 的那个 block 的 message_end 到达即播放一次，与该分支后面的 content 合并逻辑互不干扰。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/frontend && bun --env-file=.env.test test --isolate tests/session-sound.test.ts tests/store-session.test.ts`
Expected: PASS（新测试 5 个用例 + 既有 store-session 测试不回归）

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/store/session.ts packages/frontend/tests/session-sound.test.ts
git commit -m "feat(frontend): agent_end 终态与新 ask_user_question 触发提示音"
```

---

### Task 4: GeneralSection 提示音设置 UI + i18n

**Files:**
- Modify: `packages/frontend/src/components/settings/GeneralSection.tsx`
- Modify: `packages/frontend/src/i18n/locales/zh.ts`（`settings.general` 内，约 :596 `language` 块之后）
- Modify: `packages/frontend/src/i18n/locales/en.ts`（对应同位置）
- Test: `packages/frontend/tests/GeneralSection-sound.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 1 的 `soundTaskDone/setSoundTaskDone/soundNeedsAction/setSoundNeedsAction`；Task 2 的 `previewTaskDone/previewNeedsAction`
- Produces: 无新导出

- [ ] **Step 1: 写失败测试**

新建 `packages/frontend/tests/GeneralSection-sound.test.tsx`（api mock 写法参照 `tests/GeneralSection.test.tsx`）：

```tsx
import { beforeEach, expect, mock, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const previewCalls = { taskDone: 0, needsAction: 0 };

mock.module("../src/util/sound", () => ({
	playTaskDone: () => {},
	playNeedsAction: () => {},
	previewTaskDone: () => previewCalls.taskDone++,
	previewNeedsAction: () => previewCalls.needsAction++,
	resetSoundForTests: () => {},
}));

mock.module("../src/api-client", () => ({
	api: {
		get: () =>
			Promise.resolve({ retry: { maxRetries: 3, baseDelayMs: 2000 } }),
		post: () => Promise.resolve({}),
		put: () => Promise.resolve({}),
		del: () => Promise.resolve({}),
	},
}));

import { GeneralSection } from "../src/components/settings/GeneralSection";
import { useUiPrefsStore } from "../src/store/ui-prefs";

beforeEach(() => {
	previewCalls.taskDone = 0;
	previewCalls.needsAction = 0;
	localStorage.clear();
	useUiPrefsStore.setState({ soundTaskDone: true, soundNeedsAction: true });
});

async function renderLoaded() {
	render(<GeneralSection />);
	// 等通用设置加载完（重试输入框出现即表示 loading 结束）
	await waitFor(() => screen.getByTestId("retry-max-input"));
}

test("渲染两个提示音开关（默认勾选）与试听按钮", async () => {
	await renderLoaded();
	const taskDone = screen.getByTestId(
		"sound-task-done-toggle",
	) as HTMLInputElement;
	const needsAction = screen.getByTestId(
		"sound-needs-action-toggle",
	) as HTMLInputElement;
	expect(taskDone.checked).toBe(true);
	expect(needsAction.checked).toBe(true);
	expect(screen.getByTestId("sound-task-done-preview")).toBeTruthy();
	expect(screen.getByTestId("sound-needs-action-preview")).toBeTruthy();
});

test("切换任务完成开关：即时写入 store 并持久化，无需点保存", async () => {
	await renderLoaded();
	fireEvent.click(screen.getByTestId("sound-task-done-toggle"));
	expect(useUiPrefsStore.getState().soundTaskDone).toBe(false);
	const raw = localStorage.getItem("wa-pi-ui-prefs");
	expect(JSON.parse(raw!).state.soundTaskDone).toBe(false);
	// 另一个开关不受影响
	expect(useUiPrefsStore.getState().soundNeedsAction).toBe(true);
});

test("切换需要操作开关：即时写入 store", async () => {
	await renderLoaded();
	fireEvent.click(screen.getByTestId("sound-needs-action-toggle"));
	expect(useUiPrefsStore.getState().soundNeedsAction).toBe(false);
	expect(useUiPrefsStore.getState().soundTaskDone).toBe(true);
});

test("点试听按钮调用对应 preview（开关关着也能试听）", async () => {
	useUiPrefsStore.setState({ soundTaskDone: false, soundNeedsAction: false });
	await renderLoaded();
	fireEvent.click(screen.getByTestId("sound-task-done-preview"));
	fireEvent.click(screen.getByTestId("sound-needs-action-preview"));
	expect(previewCalls.taskDone).toBe(1);
	expect(previewCalls.needsAction).toBe(1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/frontend && bun --env-file=.env.test test --isolate tests/GeneralSection-sound.test.tsx`
Expected: FAIL（`sound-task-done-toggle` 等 testid 不存在）

- [ ] **Step 3: 实现**

3a. `packages/frontend/src/i18n/locales/zh.ts`：`settings.general` 对象内 `language: { ... }` 块之后追加：

```ts
			sound: {
				label: "提示音",
				desc: "任务完成或等待你操作时播放提示音，即时生效。",
				taskDone: "任务完成",
				needsAction: "需要操作",
				preview: "试听",
			},
```

3b. `packages/frontend/src/i18n/locales/en.ts`：对应 `settings.general` 内 `language` 块之后追加：

```ts
			sound: {
				label: "Sound",
				desc: "Play a sound when a task finishes or needs your action. Effective immediately.",
				taskDone: "Task complete",
				needsAction: "Action required",
				preview: "Preview",
			},
```

3c. `packages/frontend/src/components/settings/GeneralSection.tsx`：

- import 区追加：

```ts
import { previewNeedsAction, previewTaskDone } from "../../util/sound";
```

- store 订阅（既有 `const setLanguage = ...` 行之后）追加：

```ts
	const soundTaskDone = useUiPrefsStore((s) => s.soundTaskDone);
	const setSoundTaskDone = useUiPrefsStore((s) => s.setSoundTaskDone);
	const soundNeedsAction = useUiPrefsStore((s) => s.soundNeedsAction);
	const setSoundNeedsAction = useUiPrefsStore((s) => s.setSoundNeedsAction);
```

- JSX 中，在最后的「保存」按钮行（`<div className="flex items-center gap-3">` 包裹 `retry-save-btn` 的那个 div）**之后**、最外层闭合 `</div>` 之前追加（提示音即时生效，不走保存草稿流，故与草稿控件分开放底部）：

```tsx
			{/* 提示音：即时生效，不参与上面的草稿 + 保存流程 */}
			<div className="flex flex-col gap-1">
				<span className="text-sm font-medium text-primary">
					{t("settings.general.sound.label")}
				</span>
				<span className="text-xs text-tertiary">
					{t("settings.general.sound.desc")}
				</span>
			</div>
			<div className="flex items-center gap-2">
				<label className="flex items-center gap-2 text-sm text-primary cursor-pointer">
					<input
						type="checkbox"
						checked={soundTaskDone}
						onChange={(e) => setSoundTaskDone(e.target.checked)}
						style={{ accentColor: "var(--brand)" }}
						data-testid="sound-task-done-toggle"
					/>
					{t("settings.general.sound.taskDone")}
				</label>
				<button
					onClick={previewTaskDone}
					className="px-2 py-0.5 rounded-sm border border-hairline bg-surface text-xs text-secondary cursor-pointer"
					data-testid="sound-task-done-preview"
				>
					{t("settings.general.sound.preview")}
				</button>
			</div>
			<div className="flex items-center gap-2">
				<label className="flex items-center gap-2 text-sm text-primary cursor-pointer">
					<input
						type="checkbox"
						checked={soundNeedsAction}
						onChange={(e) => setSoundNeedsAction(e.target.checked)}
						style={{ accentColor: "var(--brand)" }}
						data-testid="sound-needs-action-toggle"
					/>
					{t("settings.general.sound.needsAction")}
				</label>
				<button
					onClick={previewNeedsAction}
					className="px-2 py-0.5 rounded-sm border border-hairline bg-surface text-xs text-secondary cursor-pointer"
					data-testid="sound-needs-action-preview"
				>
					{t("settings.general.sound.preview")}
				</button>
			</div>
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/frontend && bun --env-file=.env.test test --isolate tests/GeneralSection-sound.test.tsx tests/GeneralSection.test.tsx tests/GeneralSection-language.test.tsx`
Expected: PASS（新测试 4 个用例 + 既有 GeneralSection 测试不回归）

- [ ] **Step 5: 跑 typecheck**

Run: `cd packages/frontend && bun run typecheck`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/components/settings/GeneralSection.tsx packages/frontend/src/i18n/locales/zh.ts packages/frontend/src/i18n/locales/en.ts packages/frontend/tests/GeneralSection-sound.test.tsx
git commit -m "feat(frontend): 通用设置新增提示音开关与试听"
```

---

### Task 5: E2E 验证 + 全量回归 + CHANGELOG

**Files:**
- Create: `packages/frontend/e2e/settings-sound.spec.ts`
- Modify: `CHANGELOG.md`（顶部加条目）

**Interfaces:**
- Consumes: Task 4 的 testid（`settings-btn`、`settings-modal`、`sound-task-done-toggle` 等）
- Produces: 无

- [ ] **Step 1: 写 E2E 测试**

新建 `packages/frontend/e2e/settings-sound.spec.ts`（写法参照 `e2e/app-flow.spec.ts`；不需要建项目/发消息，设置弹窗在空态也能打开）：

```ts
import { expect, test } from "@playwright/test";

// 提示音设置 UI E2E：声音本身无法在自动化中断言，只验证设置项存在、
// 开关可切换并持久化到 localStorage（wa-pi-ui-prefs）。
test("设置-通用：提示音开关可切换并持久化", async ({ page }) => {
	await page.goto("/");
	await page.getByTestId("settings-btn").click();
	await expect(page.getByTestId("settings-modal")).toBeVisible();
	// 通用是默认 tab，两个开关应直接可见
	const taskDone = page.getByTestId("sound-task-done-toggle");
	const needsAction = page.getByTestId("sound-needs-action-toggle");
	await expect(taskDone).toBeVisible();
	await expect(needsAction).toBeVisible();
	await expect(taskDone).toBeChecked();
	await expect(needsAction).toBeChecked();

	// 关闭任务完成提示音 → 持久化到 localStorage
	await taskDone.click();
	await expect(taskDone).not.toBeChecked();
	const persisted = await page.evaluate(() => {
		const raw = localStorage.getItem("wa-pi-ui-prefs");
		return raw ? JSON.parse(raw).state : null;
	});
	expect(persisted?.soundTaskDone).toBe(false);
	expect(persisted?.soundNeedsAction).toBe(true);

	// 刷新后保持
	await page.reload();
	await page.getByTestId("settings-btn").click();
	await expect(page.getByTestId("sound-task-done-toggle")).not.toBeChecked();
});
```

- [ ] **Step 2: 跑 E2E**

Run: `cd packages/frontend && bun run e2e settings-sound.spec.ts`
Expected: PASS。若本机 5180/9776 被 dev 占用，按 `playwright.config.ts` 注释用 `WA_PI_E2E_WS_PORT` / `WA_PI_E2E_WEB_PORT` 偏移（如 `WA_PI_E2E_WS_PORT=19776 WA_PI_E2E_WEB_PORT=15180 bun run e2e settings-sound.spec.ts`）。

- [ ] **Step 3: 全量回归**

Run: `cd packages/frontend && bun --env-file=.env.test test --isolate`
Expected: 全部 PASS（重点确认 store-session、GeneralSection 相关旧测试无回归）

- [ ] **Step 4: 更新 CHANGELOG.md**

在 `CHANGELOG.md` 顶部 `## 2026-08-08` 的 `### 变更` 列表最前追加（若当天小节不存在则新建）：

```markdown
- **新增(frontend)：系统设置-通用新增「提示音」设置**。任务完成（agent_end 终态）与需要操作（新 ask_user_question 待回答）时播放 WebAudio 蜂鸣提示音，两种事件独立开关（默认开）、各带试听按钮，即时生效并持久化到 localStorage；浏览器自动播放策略阻止时静默降级。需要操作提示音带 500ms 去抖防叠加。
  - 影响范围：`packages/frontend/src/util/sound.ts`（新增）、`packages/frontend/src/store/ui-prefs.ts`、`packages/frontend/src/store/session.ts`、`packages/frontend/src/components/settings/GeneralSection.tsx`、`packages/frontend/src/i18n/locales/{zh,en}.ts`。
```

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/e2e/settings-sound.spec.ts CHANGELOG.md
git commit -m "feat(frontend): 提示音设置 E2E 与变更日志"
```
