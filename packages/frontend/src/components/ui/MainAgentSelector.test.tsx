// MainAgentSelector 组件测试：断言行为（按钮文案/面板两栏/点选/收起/自动选模型/失效重钉），不断言定位
// （happy-dom 无布局引擎，getBoundingClientRect 全 0，组件在测试环境跳过定位）。
// 文案锁 zh（.env.test 的 WA_PI_LANG），文案断言直接锁 zh 措辞。
import { test, expect, mock, afterEach, beforeEach } from "bun:test";
import { render, screen, fireEvent, act } from "@testing-library/react";

import { MainAgentSelector } from "./MainAgentSelector";
import { useProvidersStore } from "../../store/providers";

// 只 unmount 本文件渲染的实例，不用全局 cleanup：bun:test 多文件同进程时 RTL 的
// 自动 cleanup 只对首个加载它的文件生效，其他文件容器残留；全局 cleanup 会去
// unmount 前面文件的残留容器，在 happy-dom 下抛 removeChild 并波及本文件测试
let unmountCurrent: (() => void) | null = null;
afterEach(() => {
	unmountCurrent?.();
	unmountCurrent = null;
});

beforeEach(() => {
	useProvidersStore.setState({
		providers: [
			{
				id: "p1",
				name: "prov",
				slug: "prov",
				baseUrl: "https://api.prov.com/v1",
				apiKey: "k",
				api: "openai-completions",
				models: [
					{ id: "m1", contextWindow: 128000, maxTokens: 4096 },
					{ id: "m2", contextWindow: 128000, maxTokens: 4096 },
				],
			},
		] as any,
	} as any);
});

function renderSelector(
	props: Partial<Parameters<typeof MainAgentSelector>[0]> = {},
) {
	const onModelChange = mock(() => {});
	const onThinkingChange = mock(() => {});
	const utils = render(
		<MainAgentSelector
			value="prov/m1"
			thinking="max"
			onModelChange={onModelChange}
			onThinkingChange={onThinkingChange}
			{...props}
		/>,
	);
	unmountCurrent = utils.unmount;
	return { onModelChange, onThinkingChange, ...utils };
}

test("按钮文案为「厂商/模型 | 思考」，并带 data-value / data-thinking", () => {
	renderSelector();
	const btn = screen.getByTestId("main-selector");
	expect(btn.textContent).toBe("prov/m1 | max");
	expect(btn.getAttribute("data-value")).toBe("prov/m1");
	expect(btn.getAttribute("data-thinking")).toBe("max");
});

test("按钮文字与箭头使用主题色（text-brand）", () => {
	renderSelector();
	const btn = screen.getByTestId("main-selector");
	expect(btn.className.split(/\s+/)).toContain("text-brand");
	expect(btn.querySelector("svg")?.getAttribute("class") ?? "").toContain("text-brand");
});

test("无 provider：不渲染按钮，显示「未配置模型」", () => {
	useProvidersStore.setState({ providers: [] } as any);
	const { container } = renderSelector({ value: null });
	expect(screen.queryByTestId("main-selector")).toBeNull();
	expect(container.textContent).toContain("未配置模型");
});

test("value=null 且允许自动选择：onModelChange 恰好调用一次选中第一个模型", () => {
	const { onModelChange } = renderSelector({ value: null });
	expect(onModelChange).toHaveBeenCalledTimes(1);
	expect(onModelChange).toHaveBeenCalledWith("prov/m1");
});

test("value=null 且 autoSelectEnabled=false：不自动选模型，按钮显示「选择模型」占位", () => {
	const { onModelChange } = renderSelector({ value: null, autoSelectEnabled: false });
	expect(onModelChange).not.toHaveBeenCalled();
	expect(screen.getByTestId("main-selector").textContent).toBe("选择模型");
});

test("value 的 slug 过期但短 id 唯一命中：onModelChange 重钉到正确 id", () => {
	const { onModelChange } = renderSelector({ value: "old/m2" });
	expect(onModelChange).toHaveBeenCalledWith("prov/m2");
});

test("value 已完整匹配某个模型：不调用 onModelChange", () => {
	const { onModelChange } = renderSelector({ value: "prov/m1" });
	expect(onModelChange).not.toHaveBeenCalled();
});

test("点开面板：模型 / 思考强度两栏；模型项无「跟随主代理」；思考项按序四档", () => {
	renderSelector();
	fireEvent.click(screen.getByTestId("main-selector"));
	const menu = screen.getByTestId("main-selector-menu");
	expect(menu.querySelector('[data-testid="main-col-model"]')).toBeDefined();
	expect(menu.querySelector('[data-testid="main-col-thinking"]')).toBeDefined();
	expect(menu.textContent).toContain("模型");
	expect(menu.textContent).toContain("思考强度");
	// 模型项：厂商/模型 全名，无「跟随主代理」首项
	expect(screen.getByTestId("main-item-model-prov/m1").textContent).toContain(
		"prov/m1",
	);
	expect(screen.getByTestId("main-item-model-prov/m2")).toBeDefined();
	expect(screen.queryByText("跟随主代理")).toBeNull();
	// 思考项顺序：default / disabled / high / max
	const ids = Array.from(
		menu.querySelectorAll('[data-testid^="main-item-thinking-"]'),
	).map((el) => el.getAttribute("data-testid"));
	expect(ids).toEqual([
		"main-item-thinking-default",
		"main-item-thinking-disabled",
		"main-item-thinking-high",
		"main-item-thinking-max",
	]);
});

test("点模型项 → onModelChange，面板不收起；点思考项 → onThinkingChange，面板不收起", () => {
	const { onModelChange, onThinkingChange } = renderSelector();
	fireEvent.click(screen.getByTestId("main-selector"));
	fireEvent.click(screen.getByTestId("main-item-model-prov/m2"));
	expect(onModelChange).toHaveBeenCalledWith("prov/m2");
	expect(screen.getByTestId("main-selector-menu")).toBeDefined();
	fireEvent.click(screen.getByTestId("main-item-thinking-high"));
	expect(onThinkingChange).toHaveBeenCalledWith("high");
	expect(screen.getByTestId("main-selector-menu")).toBeDefined();
});

test("点面板外区域 → 面板收起", () => {
	renderSelector();
	fireEvent.click(screen.getByTestId("main-selector"));
	expect(screen.getByTestId("main-selector-menu")).toBeDefined();
	// mousedown 落在 body（面板外；面板虽也挂在 body 下但不在组件 root/menu 交集内）
	fireEvent.mouseDown(document.body);
	expect(screen.queryByTestId("main-selector-menu")).toBeNull();
});

test("外部容器滚动（回复期间消息列表自动贴底）→ 面板保持打开，不自动收起", () => {
	renderSelector();
	fireEvent.click(screen.getByTestId("main-selector"));
	expect(screen.getByTestId("main-selector-menu")).toBeDefined();
	// 原生 dispatchEvent 不经 RTL 的 act 包装，需手动 act 让 React flush 状态更新
	const scroller = document.createElement("div");
	document.body.appendChild(scroller);
	act(() => {
		scroller.dispatchEvent(new Event("scroll"));
	});
	expect(screen.getByTestId("main-selector-menu")).toBeDefined();
});

// ===== 以下四条从已删除的 tests/ModelSelector.test.tsx 移植（行为原样搬入本组件）=====

test("短 id 在多个厂商下都存在（歧义）：不重钉", () => {
	useProvidersStore.setState({
			providers: [
				{ id: "p1", name: "A", slug: "a", baseUrl: "http://x", apiKey: "k", api: "openai-completions", models: [{ id: "m1", contextWindow: 128000, maxTokens: 4096 }] },
				{ id: "p2", name: "B", slug: "b", baseUrl: "http://y", apiKey: "k", api: "openai-completions", models: [{ id: "m1", contextWindow: 128000, maxTokens: 4096 }] },
			] as any,
		} as any);
		const { onModelChange } = renderSelector({ value: "old/m1" });
		expect(onModelChange).not.toHaveBeenCalled();
	});

test("auto-select 触发后 value 被清空（切换会话）仍能再次触发", () => {
		const onThinkingChange = mock(() => {});
		const { onModelChange, rerender } = renderSelector({
			value: null,
			onThinkingChange,
		});
		expect(onModelChange).toHaveBeenCalledTimes(1);
		rerender(
			<MainAgentSelector value="prov/m1" thinking="max" onModelChange={onModelChange} onThinkingChange={onThinkingChange} />,
		);
		// 切换会话：value 变回 null → 应再次 auto-select
		rerender(
			<MainAgentSelector value={null} thinking="max" onModelChange={onModelChange} onThinkingChange={onThinkingChange} />,
		);
		expect(onModelChange).toHaveBeenCalledTimes(2);
	});

test("autoSelectEnabled=false 期间不自动选，启用后补触发", () => {
		const onThinkingChange = mock(() => {});
		const { onModelChange, rerender } = renderSelector({
			value: null,
			autoSelectEnabled: false,
			onThinkingChange,
		});
		expect(onModelChange).not.toHaveBeenCalled();
		rerender(
			<MainAgentSelector value={null} thinking="max" onModelChange={onModelChange} onThinkingChange={onThinkingChange} />,
		);
		expect(onModelChange).toHaveBeenCalledWith("prov/m1");
	});

test("providers 从空到加载完成（models 0 → n）不触发 hooks 顺序报错，按钮随之出现", () => {
		useProvidersStore.setState({ providers: [] } as any);
		const { rerender } = renderSelector({ value: null, autoSelectEnabled: false });
		expect(screen.queryByTestId("main-selector")).toBeNull();
		useProvidersStore.setState({
			providers: [
				{
					id: "p1",
					name: "prov",
					slug: "prov",
					baseUrl: "https://api.prov.com/v1",
					apiKey: "k",
					api: "openai-completions",
					models: [
						{ id: "m1", contextWindow: 128000, maxTokens: 4096 },
						{ id: "m2", contextWindow: 128000, maxTokens: 4096 },
					],
				},
			] as any,
		} as any);
		rerender(
			<MainAgentSelector value="prov/m1" thinking="max" onModelChange={() => {}} onThinkingChange={() => {}} />,
		);
		expect(screen.getByTestId("main-selector").textContent).toBe("prov/m1 | max");
	});
