// DelegateSelector 组件测试：断言行为（展开/选择/收起/回显），不断言定位
// （happy-dom 无布局引擎，getBoundingClientRect 全 0，组件在测试环境跳过定位）。
// 面板文案与按钮回显 i18n 锁 zh（.env.test 的 WA_PI_LANG），文案断言直接锁 zh 措辞。
import { test, expect, mock, afterEach } from "bun:test";
import { useState } from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";

import type { ThinkingLevel } from "@wa-pi/shared";
import { DelegateSelector } from "./DelegateSelector";

const MODELS = [
	{ id: "prov/m1", label: "Provider m1" },
	{ id: "prov/m2", label: "Provider m2" },
];

// 只 unmount 本文件渲染的实例，不用全局 cleanup：bun:test 多文件同进程时 RTL 的
// 自动 cleanup 只对首个加载它的文件生效，其他文件容器残留；全局 cleanup 会去
// unmount 前面文件的残留容器，在 happy-dom 下抛 removeChild 并波及本文件测试
let unmountCurrent: (() => void) | null = null;
afterEach(() => {
	unmountCurrent?.();
	unmountCurrent = null;
});

function renderSelector(
	props: Partial<Parameters<typeof DelegateSelector>[0]> = {},
) {
	const onChange = mock(() => {});
	const utils = render(
		<DelegateSelector
			model={undefined}
			thinking={undefined}
			models={MODELS}
			onChange={onChange}
			{...props}
		/>,
	);
	unmountCurrent = utils.unmount;
	return { onChange, ...utils };
}

/** 持有 state 的受控包装：模拟真实父层（onChange 更新 props），用于断言「选完不收起 + 按钮实时回显」 */
function renderSelectorStateful(
	initial: { model?: string | null; thinking?: ThinkingLevel | null } = {},
) {
	function Wrapper() {
		const [model, setModel] = useState<string | null | undefined>(initial.model);
		const [thinking, setThinking] = useState<ThinkingLevel | null | undefined>(
			initial.thinking,
		);
		return (
			<DelegateSelector
				model={model}
				thinking={thinking}
				models={MODELS}
				onChange={(patch) => {
					if ("model" in patch) setModel(patch.model);
					if ("thinking" in patch) setThinking(patch.thinking);
				}}
			/>
		);
	}
	const utils = render(<Wrapper />);
	unmountCurrent = utils.unmount;
	return utils;
}

test("默认（未设置委派）按钮文案为「跟随」", () => {
	renderSelector();
	expect(screen.getByTestId("delegate-selector").textContent).toBe("跟随");
});

test("点击展开：出现模型/思考强度两栏，各栏首项「跟随主代理」，思考栏四档", () => {
	renderSelector();
	fireEvent.click(screen.getByTestId("delegate-selector"));
	const menu = screen.getByTestId("delegate-selector-menu");

	// 两栏标题容器
	expect(menu.querySelector('[data-testid="delegate-col-model"]')).toBeDefined();
	expect(
		menu.querySelector('[data-testid="delegate-col-thinking"]'),
	).toBeDefined();

	// 各栏首项「跟随主代理」（两栏各一个）
	const follows = screen.getAllByTestId(/^delegate-item-follow-/);
	expect(follows.length).toBe(2);
	expect(follows[0].textContent).toContain("跟随主代理");
	expect(follows[1].textContent).toContain("跟随主代理");

	// 思考栏四档：default / disabled / high / max
	for (const level of ["default", "disabled", "high", "max"]) {
		expect(screen.getByTestId(`delegate-item-thinking-${level}`)).toBeDefined();
	}
});

test("点模型列表某项 → onChange 收到单字段 patch，面板保持打开、按钮实时回显", () => {
	const { onChange } = renderSelector();
	fireEvent.click(screen.getByTestId("delegate-selector"));
	expect(screen.getByTestId("delegate-selector-menu")).toBeDefined();
	fireEvent.click(screen.getByTestId("delegate-item-model-prov/m1"));
	expect(onChange).toHaveBeenCalledWith({ model: "prov/m1" });
	// 选完不收起（双栏需连续调整，点面板外才关闭）
	expect(screen.queryByTestId("delegate-selector-menu")).not.toBeNull();
});

test("选完不收起且父层接线后按钮实时回显（stateful 包装）", () => {
	renderSelectorStateful({ model: "prov/m1" });
	fireEvent.click(screen.getByTestId("delegate-selector"));
	fireEvent.click(screen.getByTestId("delegate-item-thinking-max"));
	// 面板保持打开，按钮实时回显两栏终态（模型栏为 models 列表的 厂商/模型 全名）
	expect(screen.queryByTestId("delegate-selector-menu")).not.toBeNull();
	expect(screen.getByTestId("delegate-selector").textContent).toBe(
		"Provider m1 | max",
	);
	// 继续选「跟随主代理」仍不收起，回显跟随
	fireEvent.click(screen.getByTestId("delegate-item-follow-model"));
	expect(screen.queryByTestId("delegate-selector-menu")).not.toBeNull();
	expect(screen.getByTestId("delegate-selector").textContent).toBe(
		"跟随 | max",
	);
});

test("已设置 model/thinking 时按钮回显「厂商/模型 | 思考」全名「Provider m1 | max」", () => {
	renderSelector({ model: "prov/m1", thinking: "max" });
	expect(screen.getByTestId("delegate-selector").textContent).toBe(
		"Provider m1 | max",
	);
});

test("按钮为普通文字色：已设委派模型/思考时也不再变品牌绿（主题色留给主代理）", () => {
	renderSelector({ model: "prov/m1", thinking: "max" });
	const btn = screen.getByTestId("delegate-selector");
	expect(btn.className.split(/\s+/)).toContain("text-secondary");
	expect(btn.className.split(/\s+/)).not.toContain("text-brand");
	expect(btn.querySelector("svg")?.getAttribute("class") ?? "").not.toContain("text-brand");
});

test("只设模型、思考跟随 → 回显「Provider m1 | 跟随」", () => {
	renderSelector({ model: "prov/m1", thinking: null });
	expect(screen.getByTestId("delegate-selector").textContent).toBe(
		"Provider m1 | 跟随",
	);
});

test("模型不在 models 列表（悬空）→ 回落显示 modelId 短名「gone | max」", () => {
	renderSelector({ model: "zzz/gone", thinking: "max" });
	expect(screen.getByTestId("delegate-selector").textContent).toBe("gone | max");
});

test("点面板外区域 → 面板收起", () => {
	renderSelector();
	fireEvent.click(screen.getByTestId("delegate-selector"));
	expect(screen.getByTestId("delegate-selector-menu")).toBeDefined();
	// mousedown 落在 body（面板外；面板虽也挂在 body 下但不在组件 root/menu 交集内）
	fireEvent.mouseDown(document.body);
	expect(screen.queryByTestId("delegate-selector-menu")).toBeNull();
});

test("外部容器滚动（回复期间消息列表自动贴底）→ 面板保持打开，不自动收起", () => {
	renderSelector();
	fireEvent.click(screen.getByTestId("delegate-selector"));
	expect(screen.getByTestId("delegate-selector-menu")).toBeDefined();
	// 模拟消息列表容器在流式回复期间被程序化滚动（scrollToEnd）产生的 scroll 事件：
	// 非用户操作，面板不得自行关闭
	const scroller = document.createElement("div");
	document.body.appendChild(scroller);
	// 原生 dispatchEvent 不经 RTL 的 act 包装，需手动 act 让 React flush 状态更新
	act(() => {
		scroller.dispatchEvent(new Event("scroll"));
	});
	expect(screen.getByTestId("delegate-selector-menu")).toBeDefined();
});
