// 扩展状态条/挂件渲染范围契约（trace 卡顿修复④）：
// E2E 探针实测 extension_status×20 → SessionView 整树渲染 20 次（每条事件新建
// extStatusBySession 整表对象，SessionView 订阅对象引用被逐条击穿，2.1s 长任务）。
// 修复：状态条/挂件的订阅下沉到子组件（ExtStatusBar/ExtWidgetDock 自订阅 + memo），
// extension_status 只重渲染状态条本身，SessionView 不再感知。
import { test, expect, beforeEach } from "bun:test";
import { render, screen, act } from "@testing-library/react";
import { Profiler } from "react";
import * as SV from "../../src/components/SessionView";
import { useSessionStore } from "../../src/store/session";

beforeEach(() => {
	useSessionStore.setState({
		extStatusBySession: {},
		extWidgetBySession: {},
	});
});

test("ExtStatusBar 存在且是 memo 组件", () => {
	const C = (SV as any).ExtStatusBar;
	expect(C).toBeTruthy();
	expect(C.$$typeof).toBe(Symbol.for("react.memo"));
});

test("ExtWidgetDock 是 memo 组件", () => {
	const C = (SV as any).ExtWidgetDock;
	expect(C).toBeTruthy();
	expect(C.$$typeof).toBe(Symbol.for("react.memo"));
});

test("ExtStatusBar：无关字段 set 不重渲染，extStatus 更新才渲染且内容正确", () => {
	const C = (SV as any).ExtStatusBar;
	let renders = 0;
	render(
		<Profiler
			id="ext-status"
			onRender={() => {
				renders++;
			}}
		>
			<C sessionId="s-x" />
		</Profiler>,
	);
	expect(screen.queryByTestId("ext-status-bar")).toBeNull();
	// 无关字段（streamingBySession）set：不重渲染
	act(() => {
		useSessionStore.setState({ statusBySession: {} });
	});
	// extStatus set：渲染并显示内容
	act(() => {
		useSessionStore.setState({
			extStatusBySession: { "s-x": { task: "**进行中**" } },
		});
	});
	expect(screen.getByTestId("ext-status-bar")).toBeTruthy();
	// 注意：无关字段 set 与 extStatus set 的两次 act 至少后者触发渲染
	expect(renders).toBeGreaterThan(0);
	const before = renders;
	// 再次无关字段 set：不再渲染
	act(() => {
		useSessionStore.setState({ statusBySession: { "s-x": "thinking" } });
	});
	expect(renders).toBe(before);
});
