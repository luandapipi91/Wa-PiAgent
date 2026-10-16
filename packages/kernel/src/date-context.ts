// date-context.ts —— 日期上下文注入的纯逻辑（无 ExtensionAPI 依赖，可单测）。
//
// 解决的问题：wa-pi 会话跨天后，模型对「今天」的认知仍停留在历史消息里的旧日期
// （上下文中没有任何权威日期来源）。本模块提供判定与文案，由 wa-pi-bridge 扩展
// 在 before_agent_start（主）与 tool_call（辅，覆盖长任务跨午夜）两个时机注入。
// 去重规则：同一天单会话最多注入一条（进程重启后内存清空，首次必注入，
// 天然覆盖 resume 跨天会话场景）。

/** custom_message 的 customType 标识（会话 jsonl 中可据此检索注入记录） */
export const DATE_CONTEXT_CUSTOM_TYPE = "wa-pi-date-context";

/** 本地时区日期串 YYYY-MM-DD（用 Date 的本地字段，勿用 toISOString——那是 UTC） */
export function localDateStr(d: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

/**
 * 是否需要注入：lastInjected 与今天不同（含从未注入）即为 true。
 * 调用方在注入成功后把 localDateStr(now) 记为 lastInjected。
 */
export function shouldInjectDateContext(
	lastInjected: string | undefined,
	d: Date,
): boolean {
	return lastInjected !== localDateStr(d);
}

/** 注入文案：带星期（模型推理「下周一」类排期需要），声明对历史日期的覆盖关系 */
export function buildDateContextContent(d: Date): string {
	return `[系统] 当前日期：${localDateStr(d)}（${WEEKDAY_CN[d.getDay()]}）。此前上下文中的日期信息若与本条不一致，以本条为准。`;
}
