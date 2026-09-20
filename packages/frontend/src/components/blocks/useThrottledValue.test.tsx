// useThrottledValue 节流语义契约（缺陷回归）：
// 现象——用户报告「流式期间思考卡经常是空的」。
// 根因——原实现每次 value 变化都重置定时器（防抖语义）：流式每帧提交（约 16ms）
// 都比窗口（50ms）密，定时器永远被清掉，展示值长期停在挂载时的旧值（思考卡多为 ""）
// → 整段思考期间显示空白。节流语义要求「按窗口刷新」，即高频更新下每窗口至少同步一次。
import { test, expect } from "bun:test";
import { render, act } from "@testing-library/react";
import { useThrottledValue } from "./useThrottledValue";

const WINDOW_MS = 50;

function Probe({ value, active }: { value: string; active: boolean }) {
	const shown = useThrottledValue(value, active, WINDOW_MS);
	return <span data-testid="shown">{shown}</span>;
}

/** 默认窗口探针（不传 throttleMs，走 hook 默认值） */
function DefaultProbe({ value, active }: { value: string; active: boolean }) {
	const shown = useThrottledValue(value, active);
	return <span data-testid="shown">{shown}</span>;
}

/** 等待 ms（act 包裹，确保 effect/定时器回调后 React 已提交） */
async function sleep(ms: number) {
	await act(async () => {
		await new Promise((r) => setTimeout(r, ms));
	});
}

test("流式高频更新期间展示值按窗口刷新，不会一直停在旧值", async () => {
	const { getByTestId, rerender } = render(<Probe value="" active />);
	let maxSeen = 0;
	// 模拟流式帧提交：每 16ms 一次（密于 50ms 窗口），持续 ~200ms（4 个窗口）
	for (let i = 1; i <= 12; i++) {
		await sleep(16);
		rerender(<Probe value={"x".repeat(i)} active />);
		maxSeen = Math.max(maxSeen, (getByTestId("shown").textContent ?? "").length);
	}
	// 4 个窗口内至少刷新 3 次（留一次调度余量）；防抖语义下恒为 0（挂载值为空）
	expect(maxSeen).toBeGreaterThanOrEqual(3);
});

test("默认窗口 20ms：高频流式更新期间展示值刷新足够密", async () => {
	// 每 16ms 一次更新共 ~160ms：20ms 窗口 ≈ 8 次刷新；50ms 窗口只有 3~4 次、
	// 150ms 窗口 1~2 次。取 ≥5 作为「默认窗口已降到 20ms 级」的判据。
	const seen = new Set<string>();
	const { getByTestId, rerender } = render(<DefaultProbe value="" active />);
	for (let i = 1; i <= 11; i++) {
		await sleep(16);
		rerender(<DefaultProbe value={"y".repeat(i)} active />);
		seen.add(getByTestId("shown").textContent ?? "");
	}
	expect(seen.size).toBeGreaterThanOrEqual(5);
});

test("非流式（active=false）零延迟同步完整值", () => {
	const { getByTestId, rerender } = render(<Probe value="abc" active={false} />);
	expect(getByTestId("shown").textContent).toBe("abc");
	rerender(<Probe value="abcdef" active={false} />);
	expect(getByTestId("shown").textContent).toBe("abcdef");
});

test("流式结束（active true→false）立即同步完整值，不等窗口", async () => {
	const { getByTestId, rerender } = render(<Probe value="" active />);
	await sleep(16);
	rerender(<Probe value="思考完成" active={false} />);
	// 同一轮渲染即同步，不经过节流窗口
	expect(getByTestId("shown").textContent).toBe("思考完成");
});
