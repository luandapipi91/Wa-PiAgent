import { useEffect, useRef, useState } from "react";

/**
 * 实时展示子代理运行耗时（秒）。
 *
 * 后端 subagent-runner 只在事件到达时推送 elapsedMs（工具开始/结束、text_delta），
 * 子代理 LLM 思考阶段（thinking_delta）或长工具静默执行期间没有事件，若直接渲染
 * 推送值，计时会冻结在最后一次推送。本 hook 在 running 期间以最近一次推送的
 * elapsedMs 为基准、本地每秒推算流逝时间，保证计时连续递增；非 running（done/error）
 * 时冻结为后端终值。
 */
export function useLiveElapsed(
	elapsedMs: number | undefined,
	running: boolean,
): number {
	const [display, setDisplay] = useState(() => elapsedMs ?? 0);
	const baseRef = useRef({ elapsed: elapsedMs ?? 0, at: Date.now() });

	// 后端推送新值时重置基准，并立即同步显示
	useEffect(() => {
		if (elapsedMs == null) return;
		baseRef.current = { elapsed: elapsedMs, at: Date.now() };
		setDisplay(elapsedMs);
	}, [elapsedMs]);

	// running 期间每秒用基准推算一次；tick 读 ref 避免闭包捕获过期值
	useEffect(() => {
		if (!running || elapsedMs == null) return;
		const tick = () => {
			const { elapsed, at } = baseRef.current;
			setDisplay(elapsed + (Date.now() - at));
		};
		tick();
		const timer = setInterval(tick, 1000);
		return () => clearInterval(timer);
	}, [running, elapsedMs]);

	return Math.floor(display / 1000);
}
