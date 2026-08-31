// 随机青蛙变体/聊天区位置生成器：纯函数，第一层单元测试。
// 目标：任务完成时每次跳出不同变体（且不与上次重复）、出现在 8 处位置之一，随机可被 rng 控制以便测试。
import { beforeEach, describe, expect, test } from "bun:test";
import {
	FROG_SPOTS,
	FROG_VARIANTS,
	type FrogSpot,
	type FrogVariant,
	pickFrogSpot,
	pickFrogVariant,
	resetFrogVariantCycle,
} from "../src/util/frog";

beforeEach(() => {
	resetFrogVariantCycle();
});

describe("pickFrogVariant", () => {
	test("返回的值一定是合法变体集合之一", () => {
		for (let i = 0; i < 200; i++) {
			expect(FROG_VARIANTS).toContain(pickFrogVariant());
		}
	});

	test("不与上一次重复：连续抽取任意两次都不同", () => {
		for (let i = 0; i < 200; i++) {
			const a = pickFrogVariant();
			const b = pickFrogVariant();
			expect(b).not.toBe(a);
		}
	});

	test("受 rng 控制：rng→0 取（排除上次后的）第一个", () => {
		const first = pickFrogVariant(() => 0);
		expect(first).toBe(FROG_VARIANTS[0]);
		// 上一次是 FROG_VARIANTS[0]，再 rng→0 应取排除后的第一个（即原集合第二个）
		expect(pickFrogVariant(() => 0)).toBe(FROG_VARIANTS[1]);
	});

	test("能覆盖所有变体：足够多次确定性伪随机采样覆盖集合全部", () => {
		const seen = new Set<FrogVariant>();
		// 去重过滤使固定步进 rng 无法静态映射全集，改用可复现的 LCG 伪随机采样
		let seed = 0.12345;
		const rng = () => {
			seed = (seed * 9301 + 49297) % 233280;
			return seed / 233280;
		};
		for (let i = 0; i < 500; i++) {
			seen.add(pickFrogVariant(rng));
		}
		expect(seen.size).toBe(FROG_VARIANTS.length);
	});
});

describe("pickFrogSpot", () => {
	test("返回的聊天区位置一定是 8 处之一", () => {
		for (let i = 0; i < 100; i++) {
			expect(FROG_SPOTS).toContain(pickFrogSpot());
		}
	});

	test("受 rng 控制：rng→0 取第一个，rng→接近 1 取最后一个", () => {
		expect(pickFrogSpot(() => 0)).toBe(FROG_SPOTS[0]);
		expect(pickFrogSpot(() => 0.999)).toBe(FROG_SPOTS[FROG_SPOTS.length - 1]);
	});

	test("能覆盖所有位置：满足『随机出现在聊天区 8 处』", () => {
		const seen = new Set<FrogSpot>();
		for (let i = 0; i < FROG_SPOTS.length; i++) {
			const rng = () => (i + 0.5) / FROG_SPOTS.length;
			seen.add(pickFrogSpot(rng));
		}
		expect(seen.size).toBe(FROG_SPOTS.length);
	});
});
