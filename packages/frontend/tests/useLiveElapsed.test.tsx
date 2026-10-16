import { test, expect } from "bun:test";
import { renderHook } from "@testing-library/react";
import { useLiveElapsed } from "../src/components/blocks/useLiveElapsed";

// 子代理运行计时 hook 的行为契约。
//
// 回归背景（2026-09-23 线上案例「运行中 · 153s」）：子代理静默期（长工具执行中）
// 后端只在事件时推送相对值 elapsedMs；DelegateCard 卸载重挂载（如切会话回来）后，
// 组件 state 里推算的起点丢失，只能拿 store 里过期的相对值重推起点 → 计时从
// 153s 重新起算，而子代理实际已运行约 26 分钟。
// 修复契约：进度事件携带绝对起点 startedAtMs（后端 startedAt 的 epoch ms），
// hook 优先用绝对起点推算——重挂载、SSE 滞后都不影响；startedAtMs 缺失（旧数据）
// 时退回旧行为（从 elapsedMs 反推），保证兼容。

test("回归：凭 startedAtMs 绝对起点推算，不吃过期 elapsedMs（153s bug）", () => {
	const startedAtMs = Date.now() - 1_599_000; // 实际已运行 ~26.6 分钟
	const { result } = renderHook(() => useLiveElapsed(153_000, true, startedAtMs));
	// ≈1599s（±容差），绝不是 153s
	expect(result.current).toBeGreaterThanOrEqual(1595);
	expect(result.current).toBeLessThanOrEqual(1603);
});

test("startedAtMs 缺失（旧数据）→ 保持旧行为：从 elapsedMs 反推起点", () => {
	const { result } = renderHook(() => useLiveElapsed(5_000, true));
	expect(result.current).toBe(5);
});

test("running=false → 冻结为后端终值 elapsedMs（与后端记录一致）", () => {
	const startedAtMs = Date.now() - 1_599_000;
	const { result } = renderHook(() => useLiveElapsed(42_000, false, startedAtMs));
	expect(result.current).toBe(42);
});

test("elapsedMs / startedAtMs 均缺失（首帧前）→ 显示 0，不报错", () => {
	const { result } = renderHook(() => useLiveElapsed(undefined, true));
	expect(result.current).toBe(0);
});
