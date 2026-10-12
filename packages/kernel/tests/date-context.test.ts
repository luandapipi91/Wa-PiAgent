import { describe, expect, test } from "bun:test";
import {
	buildDateContextContent,
	DATE_CONTEXT_CUSTOM_TYPE,
	localDateStr,
	shouldInjectDateContext,
} from "../src/date-context";

/** 本地时区构造：new Date(y, m, d) 即本地时间，避免 UTC 偏移干扰断言 */
describe("date-context 纯逻辑", () => {
	test("localDateStr 输出本地日期 YYYY-MM-DD", () => {
		// 2026-10-12 本地 09:30
		expect(localDateStr(new Date(2026, 9, 12, 9, 30))).toBe("2026-10-12");
		// 月/日补零
		expect(localDateStr(new Date(2026, 0, 3, 0, 5))).toBe("2026-01-03");
	});

	test("shouldInjectDateContext：未注入过（undefined）→ 注入", () => {
		expect(shouldInjectDateContext(undefined, new Date(2026, 9, 12))).toBe(true);
	});

	test("shouldInjectDateContext：同一天已注入 → 不注入（同一天单会话最多一条）", () => {
		expect(shouldInjectDateContext("2026-10-12", new Date(2026, 9, 12, 23, 59))).toBe(false);
	});

	test("shouldInjectDateContext：跨天后 → 注入", () => {
		expect(shouldInjectDateContext("2026-10-12", new Date(2026, 9, 13, 0, 0, 1))).toBe(true);
	});

	test("buildDateContextContent：含日期与星期，供模型直接采信", () => {
		// 2026-10-12 是周一
		const text = buildDateContextContent(new Date(2026, 9, 12));
		expect(text).toContain("2026-10-12");
		expect(text).toContain("周一");
		// 文案需表明这是系统注入的权威日期，覆盖历史上下文中的旧日期
		expect(text).toMatch(/以本条为准|不一致/);
	});

	test("DATE_CONTEXT_CUSTOM_TYPE：稳定的 customType 标识", () => {
		expect(DATE_CONTEXT_CUSTOM_TYPE).toBe("wa-pi-date-context");
	});
});
