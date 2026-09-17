import { useEffect, useState } from "react";

/**
 * 流式渲染节流：值高频变化期间，展示值每 throttleMs 才同步一次（返回旧值），
 * 结束（active=false）后立即同步真实值。
 *
 * 用于替代「纯文本 ↔ markdown 停顿降级」（用户实测闪烁：阈值下每条 delta 都可能
 * 触发 plain↔markdown 交替；切换会话时流式行也先纯文本再格式化闪一下）。
 * 节流方案下流式中始终渲染 markdown，只是解析频率被限制（150ms ≈ 7 次/秒），
 * 消除闪烁的同时把每帧全量解析降为低频。
 */
export function useThrottledValue(
	value: string,
	active: boolean,
	throttleMs = 150,
): string {
	const [display, setDisplay] = useState(value);
	useEffect(() => {
		if (!active) {
			// 非流式：立即同步（历史消息/定稿零延迟）
			setDisplay(value);
			return;
		}
		const t = setTimeout(() => setDisplay(value), throttleMs);
		return () => clearTimeout(t);
	}, [value, active, throttleMs]);
	return active ? display : value;
}
