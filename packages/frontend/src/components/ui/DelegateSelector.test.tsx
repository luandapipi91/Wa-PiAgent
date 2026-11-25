// DelegateSelector 组件测试：断言行为（展开/选择/收起/回显），不断言定位
// （happy-dom 无布局引擎，getBoundingClientRect 全 0，组件在测试环境跳过定位）。
// 面板文案 i18n 锁 zh（.env.test 的 WA_PI_LANG）。
import { test, expect, mock, afterEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";

import { DelegateSelector } from "./DelegateSelector";
import { delegateLabel } from "../../store/composer-prefs";

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

test("默认（未设置委派）按钮文案为 delegateLabel 输出「委派 · 跟随」", () => {
	renderSelector();
	const expected = delegateLabel(undefined, undefined);
	expect(expected).toBe("委派 · 跟随");
	expect(screen.getByTestId("delegate-selector").textContent).toBe(expected);
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

test("点模型列表某项 → onChange 收到单字段 patch { model } 且面板收起", () => {
	const { onChange } = renderSelector();
	fireEvent.click(screen.getByTestId("delegate-selector"));
	expect(screen.getByTestId("delegate-selector-menu")).toBeDefined();
	fireEvent.click(screen.getByTestId("delegate-item-model-prov/m1"));
	expect(onChange).toHaveBeenCalledWith({ model: "prov/m1" });
	// 面板收起
	expect(screen.queryByTestId("delegate-selector-menu")).toBeNull();
});

test("点思考某档 → onChange 收到单字段 patch { thinking } 且面板收起", () => {
	const { onChange } = renderSelector();
	fireEvent.click(screen.getByTestId("delegate-selector"));
	expect(screen.getByTestId("delegate-selector-menu")).toBeDefined();
	fireEvent.click(screen.getByTestId("delegate-item-thinking-max"));
	expect(onChange).toHaveBeenCalledWith({ thinking: "max" });
	expect(screen.queryByTestId("delegate-selector-menu")).toBeNull();
});

test("已设置 model/thinking 时按钮回显「委派 · m1 / max」", () => {
	renderSelector({ model: "prov/m1", thinking: "max" });
	const expected = delegateLabel("prov/m1", "max");
	expect(expected).toBe("委派 · m1 / max");
	expect(screen.getByTestId("delegate-selector").textContent).toBe(expected);
});

test("点面板外区域 → 面板收起", () => {
	renderSelector();
	fireEvent.click(screen.getByTestId("delegate-selector"));
	expect(screen.getByTestId("delegate-selector-menu")).toBeDefined();
	// mousedown 落在 body（面板外；面板虽也挂在 body 下但不在组件 root/menu 交集内）
	fireEvent.mouseDown(document.body);
	expect(screen.queryByTestId("delegate-selector-menu")).toBeNull();
});
