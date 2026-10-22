// modkey-tracker.cjs / modkey-relay.cjs 单元测试。
//
// 背景（2026-10-10）：预览「选择元素」的 Cmd/Ctrl 单按切换原先在两处 DOM 监听
// （预览 iframe 内注入脚本 + 主应用 window）双通道并存，按用户决策收敛为
// 「Electron 主进程 before-input-event 单点监听 → IPC 下发渲染进程 → postMessage
// 下发 iframe」。tracker 负责把原始按键流判成「Ctrl/Meta 单按松开」（期间无其他
// 按键、非 autoRepeat），relay 负责注册监听并转发。
import { test, expect } from "bun:test";
import { createModKeyTracker } from "../src/modkey-tracker.cjs";
import { wireModKeyRelay } from "../src/modkey-relay.cjs";

/** 快捷造 Electron before-input-event 的 input 对象 */
const key = (
	type: "keyDown" | "keyUp",
	k: string,
	isAutoRepeat = false,
) => ({ type, key: k, isAutoRepeat });

test("tracker：Ctrl 单按松开 → 触发一次", () => {
	const t = createModKeyTracker();
	expect(t.feed(key("keyDown", "Control"))).toBe(false);
	expect(t.feed(key("keyUp", "Control"))).toBe(true);
});

test("tracker：Cmd(Meta) 单按松开 → 触发一次", () => {
	const t = createModKeyTracker();
	expect(t.feed(key("keyDown", "Meta"))).toBe(false);
	expect(t.feed(key("keyUp", "Meta"))).toBe(true);
});

test("tracker：组合键（⌘C）不触发——期间按下其他键取消待翻转", () => {
	const t = createModKeyTracker();
	expect(t.feed(key("keyDown", "Meta"))).toBe(false);
	expect(t.feed(key("keyDown", "c"))).toBe(false);
	expect(t.feed(key("keyUp", "c"))).toBe(false);
	// ⌘C 松开后：pending 已被 c 清掉，Meta keyUp 不触发
	expect(t.feed(key("keyUp", "Meta"))).toBe(false);
});

test("tracker：autoRepeat 的修饰键 keyDown 不建立待翻转（按住不松不会误触发）", () => {
	const t = createModKeyTracker();
	expect(t.feed(key("keyDown", "Control", true))).toBe(false);
	expect(t.feed(key("keyUp", "Control"))).toBe(false);
});

test("tracker：一次 keyDown 只配对一次 keyUp，重复 keyUp 不再触发", () => {
	const t = createModKeyTracker();
	t.feed(key("keyDown", "Meta"));
	expect(t.feed(key("keyUp", "Meta"))).toBe(true);
	expect(t.feed(key("keyUp", "Meta"))).toBe(false);
});

test("tracker：非修饰键的 keyUp 不触发", () => {
	const t = createModKeyTracker();
	expect(t.feed(key("keyDown", "a"))).toBe(false);
	expect(t.feed(key("keyUp", "a"))).toBe(false);
});

test("tracker：150ms 去抖——双发 Meta keydown/keyup 配对只翻转一次（可注入时钟）", () => {
	let clock = 0;
	const t = createModKeyTracker({ now: () => clock });
	// 第一次配对：触发
	t.feed(key("keyDown", "Meta"));
	expect(t.feed(key("keyUp", "Meta"))).toBe(true);
	// 100ms 后键盘双发的第二对：窗口内忽略
	clock = 100;
	t.feed(key("keyDown", "Meta"));
	expect(t.feed(key("keyUp", "Meta"))).toBe(false);
	// 200ms 后的正常再按：恢复触发
	clock = 300;
	t.feed(key("keyDown", "Meta"));
	expect(t.feed(key("keyUp", "Meta"))).toBe(true);
});

test("relay：注册 before-input-event，判定触发时向该 webContents send 一次", () => {
	const handlers: Record<string, Function> = {};
	const sent: unknown[][] = [];
	const wc = {
		on: (ev: string, fn: Function) => {
			handlers[ev] = fn;
		},
		send: (...args: unknown[]) => {
			sent.push(args);
		},
	} as any;
	wireModKeyRelay(wc);
	expect(typeof handlers["before-input-event"]).toBe("function");
	expect(sent).toHaveLength(0);
	// 模拟 Ctrl 单按
	handlers["before-input-event"](
		{ preventDefault: () => {} },
		key("keyDown", "Control"),
	);
	handlers["before-input-event"](
		{ preventDefault: () => {} },
		key("keyUp", "Control"),
	);
	expect(sent).toEqual([["wa-pi:modkey-tap"]]);
	// 组合键不转发
	handlers["before-input-event"](
		{ preventDefault: () => {} },
		key("keyDown", "Meta"),
	);
	handlers["before-input-event"](
		{ preventDefault: () => {} },
		key("keyDown", "s"),
	);
	handlers["before-input-event"](
		{ preventDefault: () => {} },
		key("keyUp", "Meta"),
	);
	expect(sent).toHaveLength(1);
});
