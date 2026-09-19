// session:stats 的 token 合并/拆分逻辑：主代理（pi 官方 stats / jsonl 降级）+ 子代理（toolResult.usage）
import { test, expect } from "bun:test";
import {
	mergeTokenUsage,
	splitOfficialTokens,
	toTokenSummary,
} from "../src/ws-server";

test("toTokenSummary：缺省字段补 0、缺 total 按四项求和", () => {
	expect(toTokenSummary({ input: 100, output: 50 })).toEqual({
		input: 100,
		output: 50,
		cacheRead: 0,
		cacheWrite: 0,
		total: 150,
	});
	// total 已有时不重复计算
	expect(toTokenSummary({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 99 }).total).toBe(99);
	expect(toTokenSummary(undefined)).toEqual({
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	});
});

test("mergeTokenUsage：平铺字段 = 主 + 子合计，附带 main/subagent 拆分", () => {
	const main = { input: 1000, output: 500, cacheRead: 5000, cacheWrite: 0, total: 6500 };
	const sub = { input: 300, output: 130, cacheRead: 1000, cacheWrite: 0, total: 1430 };
	const merged = mergeTokenUsage(main, sub);
	expect(merged.total).toBe(7930);
	expect(merged.input).toBe(1300);
	expect(merged.cacheRead).toBe(6000);
	expect(merged.main).toEqual(main);
	expect(merged.subagent).toEqual(sub);
});

test("mergeTokenUsage：无子代理消耗时拆分为全 0，合计等于主代理", () => {
	const main = { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, total: 1500 };
	const merged = mergeTokenUsage(main, undefined);
	expect(merged.total).toBe(1500);
	expect(merged.subagent).toEqual({
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	});
});

test("splitOfficialTokens：官方 total 已含子代理，main = 合计 − 子代理", () => {
	// pi 官方 stats（delegate/fleet toolResult 携带 usage 后，total 原生含子代理）
	const total = { input: 1300, output: 630, cacheRead: 6000, cacheWrite: 0, total: 7930 };
	const sub = { input: 300, output: 130, cacheRead: 1000, cacheWrite: 0, total: 1430 };
	const split = splitOfficialTokens(total, sub);
	// 平铺字段保持官方合计（不再叠加子代理，避免双计）
	expect(split.total).toBe(7930);
	expect(split.input).toBe(1300);
	expect(split.main).toEqual({
		input: 1000,
		output: 500,
		cacheRead: 5000,
		cacheWrite: 0,
		total: 6500,
	});
	expect(split.subagent).toEqual(sub);
});

test("splitOfficialTokens：无子代理拆分（旧会话无 toolResult.usage）时 main = 合计", () => {
	const total = { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, total: 1500 };
	const split = splitOfficialTokens(total, undefined);
	expect(split.main).toEqual(total);
	expect(split.subagent.total).toBe(0);
});

test("splitOfficialTokens：子代理大于合计时 clamp 到 0（防御数据不一致）", () => {
	const total = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 };
	const sub = { input: 300, output: 0, cacheRead: 0, cacheWrite: 0, total: 300 };
	const split = splitOfficialTokens(total, sub);
	expect(split.main.input).toBe(0);
	expect(split.main.total).toBe(0);
});
