import { describe, expect, test } from "bun:test";
import {
	AUTO_COMPACT_OUTPUT_RESERVE,
	AUTO_COMPACT_USAGE_RATIO,
	clampedRequestMaxTokens,
	shouldCompactBeforeSend,
} from "../auto-compact";

describe("shouldCompactBeforeSend", () => {
	test("占用远低于 80% 时不压缩", () => {
		expect(shouldCompactBeforeSend(122_000, 1_000_000)).toBe(false);
	});

	test("占用不足 80% 时不压缩", () => {
		expect(shouldCompactBeforeSend(799_999, 1_000_000)).toBe(false);
	});

	test("恰好等于 80% 边界时不压缩（严格大于才触发）", () => {
		expect(shouldCompactBeforeSend(800_000, 1_000_000)).toBe(false);
	});

	test("占用超过 80% 时触发压缩", () => {
		expect(shouldCompactBeforeSend(800_001, 1_000_000)).toBe(true);
	});

	test("1M 窗口 70 万占用不触发，96.8 万触发", () => {
		expect(shouldCompactBeforeSend(700_000, 1_000_000)).toBe(false);
		expect(shouldCompactBeforeSend(968_000, 1_000_000)).toBe(true);
	});

	test("窗口非法时（<=0）不压缩", () => {
		expect(shouldCompactBeforeSend(100, 0)).toBe(false);
		expect(shouldCompactBeforeSend(100, -1)).toBe(false);
	});

	test("80% 阈值常量正确", () => {
		expect(AUTO_COMPACT_USAGE_RATIO).toBe(0.8);
	});

	test("预留余量常量正确", () => {
		expect(AUTO_COMPACT_OUTPUT_RESERVE).toBe(4096);
	});
});

describe("shouldCompactBeforeSend：条件② 钳制后输出预算不足（< 8192）时压缩", () => {
	test("占用未到 80%，但钳制后输出预算不足 → 触发", () => {
		// 条件①不触发（10000 ≤ 20000*0.8=16000）；钳制后 = min(16000, 20000-10000-4096=5904) = 5904 < 8192 → 触发
		expect(shouldCompactBeforeSend(10_000, 20_000, 16_000)).toBe(true);
	});

	test("占用与输出预算都在安全区 → 不触发", () => {
		// 条件①不触发（1000 ≤ 80000）；钳制后 = min(8192, 100000-1000-4096=94904) = 8192 ≥ 8192 → 不触发
		expect(shouldCompactBeforeSend(1_000, 100_000, 8_192)).toBe(false);
	});

	test("恰好等于窗口边界时不触发（严格大于才触发）", () => {
		// 钳制后 = min(6000, 20000-9904-4096=6000) = 6000，恰等 min(标称, 8192)=6000 → 不触发
		expect(shouldCompactBeforeSend(9_904, 20_000, 6_000)).toBe(false);
		// 钳制后 = 20000-9905-4096 = 5999 < min(6000, 8192) = 6000 → 触发
		expect(shouldCompactBeforeSend(9_905, 20_000, 6_000)).toBe(true);
	});

	test("maxOutputTokens 未知（undefined）时条件②跳过，只看比例", () => {
		expect(shouldCompactBeforeSend(10_000, 20_000)).toBe(false);
		expect(shouldCompactBeforeSend(10_000, 20_000, undefined)).toBe(false);
	});

	test("maxOutputTokens 非正数时条件②跳过", () => {
		expect(shouldCompactBeforeSend(10_000, 20_000, 0)).toBe(false);
		expect(shouldCompactBeforeSend(10_000, 20_000, -5)).toBe(false);
	});

	test("条件②：钳制后输出预算充足时不压缩（标称输出再大也不误触发）", () => {
		// 窗口 400K / 标称 384K / 占用 300K：上游钳制后仍可输出 55000
		expect(shouldCompactBeforeSend(300_000, 400_000, 384_000)).toBe(false);
	});

	test("条件②：钳制后输出预算不足时压缩", () => {
		// 窗口 200K / 标称 384K / 占用 190K：上游钳制后只剩 5904（< 8192）
		expect(shouldCompactBeforeSend(190_000, 200_000, 384_000)).toBe(true);
	});

	test("双条件真值表交叉验证", () => {
		// [used, window, maxOut, 期望]
		const cases: Array<[number, number, number | undefined, boolean]> = [
			[0, 100_000, 8_192, false], // 两条都不满足
			[80_001, 100_000, 8_192, true], // 仅条件①
			[75_000, 100_000, 32_000, false], // 钳制后 = min(32000, 20904) = 20904 ≥ 8192 → 不压缩
			[80_001, 100_000, undefined, true], // 仅条件①，无 maxOut
			[75_000, 100_000, undefined, false], // 无 maxOut 时条件②无法判定
			[95_000, 100_000, 0, true], // 仅条件①，maxOut 非法
			[10_000, 20_000, 16_000, true], // 仅条件②
		];
		for (const [used, win, maxOut, expected] of cases) {
			expect(shouldCompactBeforeSend(used, win, maxOut)).toBe(expected);
		}
	});

	test("窗口非法（<=0）时无论输出预算都不压缩", () => {
		expect(shouldCompactBeforeSend(100, 0, 10_000)).toBe(false);
		expect(shouldCompactBeforeSend(100, -1, 10_000)).toBe(false);
	});
});

describe("clampedRequestMaxTokens：上游钳制公式", () => {
	test("clampedRequestMaxTokens 复刻上游公式", () => {
		expect(clampedRequestMaxTokens(300_000, 1_000_000, 384_000)).toBe(384_000);
		expect(clampedRequestMaxTokens(300_000, 400_000, 384_000)).toBe(55_000);
		expect(clampedRequestMaxTokens(190_000, 200_000, 384_000)).toBe(5_904);
		expect(clampedRequestMaxTokens(10_000, 200_000, 384_000)).toBe(185_904);
		expect(clampedRequestMaxTokens(790_000, 1_000_000, 384_000)).toBe(91_500);
	});
});
