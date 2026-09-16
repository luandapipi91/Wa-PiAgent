import { useEffect, useState } from "react";

/**
 * 实时展示子代理运行耗时（秒）。
 *
 * 计时来源：首次收到有效 elapsedMs 时，按「elapsedMs 是后端发出时刻已耗时长」反推
 * 出子代理在本机时钟上的开始时刻 startAt；此后 running 期间只用 Date.now() - startAt
 * 本地推算——与 SSE 推送节奏完全解耦，秒数天然连续、不回跳、静默期不冻结。
 * 完成（done/error）时冻结为后端终值 elapsedMs，与后端记录一致。
 *
 * 为什么不用推送值直接驱动显示：
 * 1. 后端只在事件到达时推送 elapsedMs（工具开始/结束、text_delta），子代理 LLM 思考
 *    阶段或长工具静默执行期间没有事件，直接渲染推送值会冻结。
 * 2. 推送值是后端发出时刻的耗时，经 SSE 到达前端已滞后；若用它覆盖显示会把本地已
 *    推算的秒数拉回、回跳。startAt 只推导一次后锁死，后续任何推送（哪怕滞后/回跳）
 *    都不再影响显示。
 */
export function useLiveElapsed(
	elapsedMs: number | undefined,
	running: boolean,
): number {
	const [display, setDisplay] = useState(() => elapsedMs ?? 0);
	const [startAt, setStartAt] = useState<number | null>(null);

	// 首次收到有效 elapsedMs 时推导本地开始时刻（只推一次，之后锁死；
	// 后续推送值不再更新 startAt，保证秒数单调递增、不回跳）。
	useEffect(() => {
		if (elapsedMs == null || startAt != null) return;
		setStartAt(Date.now() - elapsedMs);
	}, [elapsedMs, startAt]);

	// running 期间每秒用 Date.now() - startAt 推算；startAt 锁死后定时器不随推送重建，
	// 高频进度推送下本地推算仍稳定每秒 tick。
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
