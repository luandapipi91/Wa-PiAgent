import { describe, expect, test } from "bun:test";
import type { TuiFrame } from "../src/tui-host/frame.ts";
import { createWidgetHost } from "../src/tui-host/widget.ts";

describe("createWidgetHost", () => {
	test("factory 收到 tui 与 theme，采样得到渲染行", () => {
		const got: unknown[] = [];
		const host = createWidgetHost({
			cols: 60,
			factory: (tui, theme) => {
				got.push(tui, theme);
				return { render: () => ["dashboard line"], invalidate: () => {} };
			},
			theme: { name: "test" } as never,
		});
		host.start();
		const frame = host.sample();
		expect(frame?.lines).toEqual(["dashboard line"]);
		expect(got).toHaveLength(2);
		host.dispose();
	});

	test("内容未变化时 sample() 返回 null（不重复推送）", () => {
		const host = createWidgetHost({
			cols: 60,
			factory: () => ({ render: () => ["same"], invalidate: () => {} }),
			theme: {} as never,
		});
		host.start();
		expect(host.sample()?.lines).toEqual(["same"]);
		expect(host.sample()).toBeNull();
		host.dispose();
	});

	test("组件调 requestRender 后再次采样能拿到新内容", () => {
		let text = "v1";
		// 用对象属性承接 tui：局部 let 会被控制流分析窄化成 null（赋值发生在闭包里）
		const dumbTuiRef: { tui: { requestRender?: () => void } | null } = { tui: null };
		const host = createWidgetHost({
			cols: 60,
			factory: (tui) => {
				dumbTuiRef.tui = tui as unknown as { requestRender: () => void };
				return { render: () => [text], invalidate: () => {} };
			},
			theme: {} as never,
		});
		host.start();
		expect(host.sample()?.lines).toEqual(["v1"]);
		text = "v2";
		dumbTuiRef.tui?.requestRender?.();
		expect(host.sample()?.lines).toEqual(["v2"]);
		host.dispose();
	});

	test("resize 后按新宽度渲染", () => {
		const widths: number[] = [];
		const host = createWidgetHost({
			cols: 60,
			factory: () => ({
				render: (w: number) => {
					widths.push(w);
					return [`w=${w}`];
				},
				invalidate: () => {},
			}),
			theme: {} as never,
		});
		host.start();
		host.sample();
		host.resize(100);
		host.sample();
		expect(widths).toEqual([60, 100]);
		host.dispose();
	});

	test("dispose 调用组件 dispose（若提供）", () => {
		let disposed = 0;
		const host = createWidgetHost({
			cols: 60,
			factory: () => ({ render: () => ["x"], invalidate: () => {}, dispose: () => { disposed += 1; } }),
			theme: {} as never,
		});
		host.start();
		host.dispose();
		expect(disposed).toBe(1);
	});

	test("渲染抛错时不抛出，sample 返回 null", () => {
		const host = createWidgetHost({
			cols: 60,
			factory: () => ({ render: () => { throw new Error("bad"); }, invalidate: () => {} }),
			theme: {} as never,
		});
		host.start();
		expect(host.sample()).toBeNull();
		host.dispose();
	});

	test("onFrame 抛错时 sample 不抛出，内容变化后仍能取到新帧", () => {
		let text = "v1";
		let pushCount = 0;
		const host = createWidgetHost({
			cols: 60,
			factory: () => ({ render: () => [text], invalidate: () => {} }),
			theme: {} as never,
			onFrame: () => {
				pushCount += 1;
				throw new Error("sink boom");
			},
		});
		host.start();

		// 推送通道抛错时 sample 必须吃掉异常（不得逃逸到 pi 主循环），并照常交出该帧
		const frames: (TuiFrame | null)[] = [];
		frames.push(host.sample());
		expect(frames[0]?.lines).toEqual(["v1"]);
		expect(pushCount).toBe(1);

		// 推送失败不推进去重基线：同一帧下次采样会重试推送（宁可重发，不可丢帧）
		text = "v1";
		frames.push(host.sample());
		expect(frames[1]?.lines).toEqual(["v1"]);
		expect(pushCount).toBe(2);

		// 关键：这一帧不能因为推送失败被永久吞掉——内容变化后仍要能取到新帧
		text = "v2";
		frames.push(host.sample());
		expect(frames[2]?.lines).toEqual(["v2"]);
		expect(pushCount).toBe(3);
		host.dispose();
	});

	test("resize 收到非有限值时忽略，仍按旧宽度渲染", () => {
		const widths: number[] = [];
		const host = createWidgetHost({
			cols: 60,
			factory: () => ({
				render: (w: number) => {
					widths.push(w);
					return [`w=${w}`];
				},
				invalidate: () => {},
			}),
			theme: {} as never,
		});
		host.start();
		host.resize(Number.NaN);
		host.sample();
		host.resize(Number.POSITIVE_INFINITY);
		host.sample();
		expect(widths).toEqual([60, 60]);
		host.dispose();
	});

	test("factory 抛错时 sample 返回 null 且不抛给调用方", () => {
		const host = createWidgetHost({
			cols: 60,
			factory: () => { throw new Error("boom"); },
			theme: {} as never,
		});
		host.start();
		expect(host.sample()).toBeNull();
	});
});
