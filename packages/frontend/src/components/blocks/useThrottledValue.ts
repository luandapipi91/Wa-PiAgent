import { useEffect, useRef, useState } from "react";

/**
 * 流式渲染节流：值高频变化期间，展示值每 throttleMs 同步一次（窗口内返回旧值），
 * 结束（active=false）后立即同步真实值。
 *
 * 用于替代「纯文本 ↔ markdown 停顿降级」（用户实测闪烁：阈值下每条 delta 都可能
 * 触发 plain↔markdown 交替；切换会话时流式行也先纯文本再格式化闪一下）。
 * 节流方案下流式中始终渲染 markdown，只是解析频率被限制（20ms ≈ 50 次/秒），
 * 消除闪烁的同时把每帧全量解析降为低频。
 *
 * 实现要点（节流 ≠ 防抖）：定时器延迟按「上次提交时刻 + 窗口」对齐，而不是每次
 * value 变化都重置——流式按帧提交（约 16ms）密于窗口，重置式写法会让定时器永远
 * 被清掉、展示值长期停在挂载旧值（思考卡挂载值是 ""，整段思考期间显示空白）。
 */
export function useThrottledValue(
	value: string,
	active: boolean,
	throttleMs = 20,
): string {
	const [display, setDisplay] = useState(value);
	// 上次提交（展示值同步）的时间戳；0 = 从未提交，首次变化立即同步
	const lastCommitRef = useRef(0);

	useEffect(() => {
		const now = Date.now();
		if (!active) {
			// 非流式：立即同步（历史消息/定稿零延迟）
			lastCommitRef.current = now;
			setDisplay(value);
			return;
		}
		const elapsed = now - lastCommitRef.current;
		if (elapsed >= throttleMs) {
			// 已过窗口：立即同步（含首次）
			lastCommitRef.current = now;
			setDisplay(value);
			return;
		}
		// 窗口内：排到本窗口末尾提交；value 再变只是把同一 deadline 的定时器重排，
		// deadline 不变，因此窗口结束必然刷新一次
		const t = setTimeout(() => {
			lastCommitRef.current = Date.now();
			setDisplay(value);
		}, throttleMs - elapsed);
		return () => clearTimeout(t);
	}, [value, active, throttleMs]);
	return active ? display : value;
}
