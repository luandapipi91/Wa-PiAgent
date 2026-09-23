import { useEffect, useState } from "react";

/**
 * 实时展示子代理运行耗时（秒）。
 *
 * 计时来源（按优先级）：
 * 1. startedAtMs（进度事件携带的绝对起点，epoch ms）——直接采用，零推算。
 *    静默期（长工具执行中）只剩最后一次推送的相对 elapsedMs，卡片重挂载（切会话
 *    回来）后若按过期相对值重推起点，计时会回跳（2026-09-23「运行中 · 153s」
 *    案例：实际已跑 26 分钟仍显示 153s）。绝对起点存在 store 的事件里，重挂载
 *    不丢，秒数天然连续。
 * 2. startedAtMs 缺失（旧数据）→ 首次收到有效 elapsedMs 时按「elapsedMs 是后端
 *    发出时刻已耗时长」反推出本地开始时刻，只推一次后锁死（旧行为兜底）。
 *
 * running 期间每秒用 Date.now() - startAt 本地推算——与 SSE 推送节奏完全解耦，
 * 秒数连续、不回跳、静默期不冻结。
 * 完成（done/error）时冻结为后端终值 elapsedMs，与后端记录一致。
 */
export function useLiveElapsed(
	elapsedMs: number | undefined,
	running: boolean,
	startedAtMs?: number,
): number {
	const [display, setDisplay] = useState(() => elapsedMs ?? 0);
	// 旧行为兜底：仅在无绝对起点时推导本地起点（锁死一次，后续推送不再更新）
	const [derivedStartAt, setDerivedStartAt] = useState<number | null>(null);

	useEffect(() => {
		if (startedAtMs != null || derivedStartAt != null || elapsedMs == null)
			return;
		setDerivedStartAt(Date.now() - elapsedMs);
	}, [elapsedMs, startedAtMs, derivedStartAt]);

	// 有效起点：绝对起点优先，兜底取推导值
	const startAt = startedAtMs ?? derivedStartAt;

	// running 期间每秒本地推算；起点稳定后定时器不随推送重建，高频进度推送下仍稳定 tick。
	useEffect(() => {
		if (!running || startAt == null) return;
		const tick = () => setDisplay(Date.now() - startAt);
		tick();
		const timer = setInterval(tick, 1000);
		return () => clearInterval(timer);
	}, [running, startAt]);

	// 完成态：冻结为后端终值（与后端记录一致，避免停在最后一次本地推算的秒数）。
	// setDisplay 幂等：终值不变时 set 相同值，React 跳过重渲染。
	useEffect(() => {
		if (running || elapsedMs == null) return;
		setDisplay(elapsedMs);
	}, [running, elapsedMs]);

	return Math.floor(display / 1000);
}
