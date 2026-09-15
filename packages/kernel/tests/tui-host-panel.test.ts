import { describe, expect, test } from "bun:test";
import { Text } from "@earendil-works/pi-tui";
import { createPanelHost } from "../src/tui-host/panel.ts";

/** 可控测试组件：记录收到的按键，可按需回写内容 */
function makeProbeComponent(getText: () => string) {
	const keys: string[] = [];
	return {
		keys,
		component: {
			render: (_width: number) => [getText()],
			invalidate: () => {},
			handleInput: (data: string) => {
				keys.push(data);
			},
		},
	};
}

describe("createPanelHost", () => {
	test("打开后 sample() 采到组件渲染的行", () => {
		const host = createPanelHost({
			title: "probe",
			cols: 40,
			rows: 10,
			factory: () => new Text("hello panel"),
			theme: undefined as never,
			keybindings: undefined as never,
		});
		const frame = host.sample();
		expect(frame?.lines.join("\n")).toContain("hello panel");
		host.dispose();
	});

	test("inject 把按键交给组件；done 回调结束并返回结果", async () => {
		// 用对象属性承接 done：局部 let 会被控制流分析窄化成 null（赋值发生在闭包里）
		const doneRef: { fn: ((r: string) => void) | null } = { fn: null };
		const probe = makeProbeComponent(() => "pick");
		const host = createPanelHost({
			title: "probe",
			cols: 40,
			rows: 10,
			factory: (_tui, _theme, _kb, done) => {
				doneRef.fn = done;
				return probe.component;
			},
			theme: undefined as never,
			keybindings: undefined as never,
		});
		host.start();
		host.inject("\u001b[B");
		expect(probe.keys).toEqual(["\u001b[B"]);
		doneRef.fn?.("confirmed");
		await expect(host.result).resolves.toEqual({ status: "done", value: "confirmed" });
	});

	test("cancel 结束并标记 cancelled", async () => {
		const host = createPanelHost({
			title: "probe",
			cols: 40,
			rows: 10,
			factory: () => new Text("x"),
			theme: undefined as never,
			keybindings: undefined as never,
		});
		host.start();
		host.cancel();
		await expect(host.result).resolves.toEqual({ status: "cancelled" });
	});

	test("resize 后新采样按新宽度渲染", () => {
		const widths: number[] = [];
		const host = createPanelHost({
			title: "probe",
			cols: 40,
			rows: 10,
			factory: () => ({
				render: (w: number) => {
					widths.push(w);
					return [`w=${w}`];
				},
				invalidate: () => {},
			}),
			theme: undefined as never,
			keybindings: undefined as never,
		});
		host.sample();
		host.resize(60, 12);
		host.sample();
		expect(widths).toEqual([40, 60]);
		host.dispose();
	});

	test("factory 抛错时以 cancelled 结束且不抛给调用方", async () => {
		const host = createPanelHost({
			title: "probe",
			cols: 40,
			rows: 10,
			factory: () => {
				throw new Error("boom");
			},
			theme: undefined as never,
			keybindings: undefined as never,
		});
		host.start();
		await expect(host.result).resolves.toEqual({ status: "cancelled" });
	});

	test("dispose 后 result 以 cancelled 结束（会话销毁兜底）", async () => {
		const host = createPanelHost({
			title: "probe",
			cols: 40,
			rows: 10,
			factory: () => new Text("x"),
			theme: undefined as never,
			keybindings: undefined as never,
		});
		host.start();
		host.dispose();
		await expect(host.result).resolves.toEqual({ status: "cancelled" });
	});
});
