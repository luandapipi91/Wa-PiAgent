// 随机青蛙姿势/聊天区角落生成器：纯函数，第一层单元测试。
// 目标：任务完成时每次跳出不同姿势、出现在不同角落，且随机可被 rng 控制以便测试。
import { describe, expect, test } from "bun:test";
import {
	FROG_CORNERS,
	FROG_POSES,
	type FrogCorner,
	type FrogPose,
	pickFrogCorner,
	pickFrogPose,
} from "../src/util/frog";

describe("pickFrogPose", () => {
	test("返回的值一定是合法姿势集合之一", () => {
		for (let i = 0; i < 200; i++) {
			expect(FROG_POSES).toContain(pickFrogPose());
		}
	});

	test("受 rng 控制：rng→0 取第一个，rng→接近 1 取最后一个", () => {
		expect(pickFrogPose(() => 0)).toBe(FROG_POSES[0]);
		expect(pickFrogPose(() => 0.999)).toBe(FROG_POSES[FROG_POSES.length - 1]);
	});

	test("能覆盖所有姿势：不同 rng 可产生集合中每个元素（满足『每次不同』）", () => {
		const seen = new Set<FrogPose>();
		for (let i = 0; i < FROG_POSES.length; i++) {
			const rng = () => (i + 0.5) / FROG_POSES.length;
			seen.add(pickFrogPose(rng));
		}
		expect(seen.size).toBe(FROG_POSES.length);
	});
});

describe("pickFrogCorner", () => {
	test("返回的聊天区角落一定是四角之一", () => {
		for (let i = 0; i < 100; i++) {
			expect(FROG_CORNERS).toContain(pickFrogCorner());
		}
	});

	test("受 rng 控制：rng→0 取第一个，rng→接近 1 取最后一个", () => {
		expect(pickFrogCorner(() => 0)).toBe(FROG_CORNERS[0]);
		expect(pickFrogCorner(() => 0.999)).toBe(
			FROG_CORNERS[FROG_CORNERS.length - 1],
		);
	});

	test("能覆盖所有角落：满足『随机出现在聊天区四角』", () => {
		const seen = new Set<FrogCorner>();
		for (let i = 0; i < FROG_CORNERS.length; i++) {
			const rng = () => (i + 0.5) / FROG_CORNERS.length;
			seen.add(pickFrogCorner(rng));
		}
		expect(seen.size).toBe(FROG_CORNERS.length);
	});
});
