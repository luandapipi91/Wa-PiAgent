// startup-timeline.cjs 单元测试。
//
// 背景：启动卡顿查不下去的根因是「内核就绪 → 主窗口首次出帧」这一段**没有任何耗时日志**。
// 用户报的「启动页空白、进度条卡住、很久才出界面」正好全落在这一段里（两个平台都报过）。
// 这里提供一条极轻量的时间线：main.cjs 在各阶段 mark 一次，最后打一行摘要日志。
import { test, expect } from "bun:test";
import { createStartupTimeline } from "../src/util/startup-timeline.cjs";

test("mark 返回相对第一条 mark（进程起点）的毫秒数，summary 按顺序拼接", () => {
	let t = 1000;
	const tl = createStartupTimeline(() => t);
	expect(tl.mark("start")).toBe(0);
	t = 1120;
	expect(tl.mark("ready")).toBe(120);
	t = 2400;
	tl.mark("splashCreated");
	t = 5000;
	tl.mark("kernelReady");
	expect(tl.summary()).toBe(
		"start=+0ms ready=+120ms splashCreated=+1400ms kernelReady=+4000ms",
	);
});

test("重复 mark 同名阶段不覆盖：都要留在时间线里（重试场景不能丢证据）", () => {
	let t = 0;
	const tl = createStartupTimeline(() => t);
	tl.mark("kernelSpawn");
	t = 3000;
	tl.mark("kernelSpawn");
	expect(tl.summary()).toBe("kernelSpawn=+0ms kernelSpawn=+3000ms");
});

test("marks() 返回副本，外部改动不影响内部状态", () => {
	const tl = createStartupTimeline(() => 0);
	tl.mark("a");
	const copy = tl.marks();
	copy.push(["injected", 999]);
	expect(tl.marks()).toHaveLength(1);
});

test("没有 mark 时 summary 为空串（不产出半截日志）", () => {
	expect(createStartupTimeline(() => 0).summary()).toBe("");
});
