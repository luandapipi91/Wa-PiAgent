import { describe, expect, test } from "bun:test";
import {
	AUTO_COMPACT_OUTPUT_RESERVE,
	AUTO_COMPACT_USAGE_RATIO,
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

describe("shouldCompactBeforeSend：条件② 输入 + 最大输出 + 预留余量越窗口", () => {
	test("占用未到 80%，但叠加最大输出后越窗口 → 触发", () => {
		// 10000 > 20000*0.8=16000？否；10000+16000+4096=30096 > 20000 → 是
		expect(shouldCompactBeforeSend(10_000, 20_000, 16_000)).toBe(true);
	});

	test("占用与输出预算都在安全区 → 不触发", () => {
		// 1000 > 80000？否；1000+8192+4096=13288 < 100000 → 否
		expect(shouldCompactBeforeSend(1_000, 100_000, 8_192)).toBe(false);
	});

	test("恰好等于窗口边界时不触发（严格大于才触发）", () => {
		// 9904+6000+4096 = 20000，恰等窗口
		expect(shouldCompactBeforeSend(9_904, 20_000, 6_000)).toBe(false);
		// 9915+5000+4096 = 19011 < 20000；改大一点越界
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

	test("双条件真值表交叉验证", () => {
		// [used, window, maxOut, 期望]
		const cases: Array<[number, number, number | undefined, boolean]> = [
			[0, 100_000, 8_192, false], // 两条都不满足
			[80_001, 100_000, 8_192, true], // 仅条件①
			[75_000, 100_000, 32_000, true], // 仅条件②（75000+32000+4096=111096>100000）
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
