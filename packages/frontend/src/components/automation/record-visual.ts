import type { ExecutionRecord } from "@wa-pi/shared";

/**
 * 执行记录的状态视觉（图标/前景色/底色）。
 *
 * 状态枚举仍是三态（running/success/failed），用户主动取消的记录落在 failed +
 * errorCode=scheduler.taskCancelled——这里按 errorCode 细分展示为灰色「⊘ 已取消」，
 * 避免把「用户自己停的」渲染成执行故障（红色 ✕）。
 * （未扩枚举是有意取舍：扩枚举会牵动筛选、状态点、字典与既有记录数据的兼容。）
 */
export function recordVisual(record: {
	status: ExecutionRecord["status"];
	errorCode?: string;
}): { icon: string; color: string; bg: string; label: string } {
	if (record.status === "success")
		return {
			icon: "✓",
			color: "#4ade80",
			bg: "rgba(34,197,94,0.1)",
			label: "成功",
		};
	if (record.status === "running")
		return {
			icon: "⟳",
			color: "#60a5fa",
			bg: "rgba(59,130,246,0.1)",
			label: "运行中",
		};
	if (record.errorCode === "scheduler.taskCancelled")
		return {
			icon: "⊘",
			color: "#94a3b8",
			bg: "rgba(148,163,184,0.12)",
			label: "已取消",
		};
	return { icon: "✕", color: "#f87171", bg: "rgba(239,68,68,0.1)", label: "失败" };
}

/**
 * 是否展示耗时：中断记录的耗时不可知（running 的 startedAt 到「对账发现」之间可能隔着
 * 应用关闭的整段时间），老版本据此写出过「耗时 1560996s」这类假数据——展示侧一并隐去，
 * 存量记录立刻不再显示。
 */
export function recordShowsDuration(record: {
	status: ExecutionRecord["status"];
	errorCode?: string;
}): boolean {
	return record.errorCode !== "scheduler.taskInterrupted";
}
