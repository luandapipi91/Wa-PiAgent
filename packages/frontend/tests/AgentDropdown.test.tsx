import { test, expect, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentDropdown } from "../src/components/ui/AgentDropdown";
import { useAgentsStore } from "../src/store/agents";
import type { AgentConfig } from "@wa-pi/shared";

const cfg = (name: string): AgentConfig => ({
	displayName: name,
	avatar: "🤖",
	avatarColor: "#06b6d4-#3b82f6",
	description: `${name}简介`,
	model: "m",
	thinking: "disabled",
	tools: [],
	skills: [],
	mcpServers: [],
	partners: { askTo: [] },
});

beforeEach(() => {
	useAgentsStore.setState({
		list: [cfg("dev"), cfg("代码审查"), cfg("质量验收")],
	});
});

test("显示当前选中智能体，点击展开带搜索框的列表", () => {
	render(
		<AgentDropdown
			agents={useAgentsStore.getState().list}
			value="dev"
			onPick={() => {}}
		/>,
	);
	expect(screen.getByTestId("agent-select")).toBeTruthy();
	fireEvent.click(screen.getByTestId("agent-select"));
	expect(screen.getByTestId("agent-search")).toBeTruthy();
	expect(screen.getByTestId("agent-item-代码审查")).toBeTruthy();
});

test("搜索框过滤智能体列表", () => {
	render(
		<AgentDropdown
			agents={useAgentsStore.getState().list}
			value="dev"
			onPick={() => {}}
		/>,
	);
	fireEvent.click(screen.getByTestId("agent-select"));
	fireEvent.change(screen.getByTestId("agent-search"), {
		target: { value: "验收" },
	});
	expect(screen.queryByTestId("agent-item-代码审查")).toBeNull();
	expect(screen.getByTestId("agent-item-质量验收")).toBeTruthy();
});

test("选中非当前项立即触发 onPick（无确认框）", () => {
	let picked = "";
	render(
		<AgentDropdown
			agents={useAgentsStore.getState().list}
			value="dev"
			onPick={(n) => {
				picked = n;
			}}
		/>,
	);
	fireEvent.click(screen.getByTestId("agent-select"));
	fireEvent.click(screen.getByTestId("agent-item-代码审查"));
	expect(picked).toBe("代码审查");
	// 选中后下拉关闭
	expect(screen.queryByTestId("agent-search")).toBeNull();
});

test("选中当前项也触发关闭但不重复 onPick", () => {
	let pickCount = 0;
	render(
		<AgentDropdown
			agents={useAgentsStore.getState().list}
			value="dev"
			onPick={() => {
				pickCount++;
			}}
		/>,
	);
	fireEvent.click(screen.getByTestId("agent-select"));
	fireEvent.click(screen.getByTestId("agent-item-dev"));
	expect(pickCount).toBe(0);
	expect(screen.queryByTestId("agent-search")).toBeNull();
});

test("missing=true 时 pill 显示警示态", () => {
	render(
		<AgentDropdown
			agents={useAgentsStore.getState().list}
			value="已删除者"
			onPick={() => {}}
			missing
		/>,
	);
	expect(screen.getByTestId("agent-missing")).toBeTruthy();
	// 警示态点击仍可展开
	fireEvent.click(screen.getByTestId("agent-select"));
	expect(screen.getByTestId("agent-search")).toBeTruthy();
});

test("点击组件外部关闭下拉", () => {
	render(
		<AgentDropdown
			agents={useAgentsStore.getState().list}
			value="dev"
			onPick={() => {}}
		/>,
	);
	fireEvent.click(screen.getByTestId("agent-select"));
	expect(screen.getByTestId("agent-search")).toBeTruthy();
	// 模拟点击外部
	fireEvent.mouseDown(document.body);
	expect(screen.queryByTestId("agent-search")).toBeNull();
});

/** 统一 mock 矩形：同时覆盖 pill（button）与菜单（div）两类元素的原型，返回原 restore 函数 */
function mockRect(rect: {
	left: number;
	right: number;
	top: number;
	bottom: number;
	width: number;
	height: number;
}) {
	const origDiv = HTMLDivElement.prototype.getBoundingClientRect;
	const origBtn = HTMLButtonElement.prototype.getBoundingClientRect;
	const fn = () =>
		({ ...rect, x: rect.left, y: rect.top, toJSON: () => ({}) }) as DOMRect;
	HTMLDivElement.prototype.getBoundingClientRect = fn;
	HTMLButtonElement.prototype.getBoundingClientRect = fn;
	return () => {
		HTMLDivElement.prototype.getBoundingClientRect = origDiv;
		HTMLButtonElement.prototype.getBoundingClientRect = origBtn;
	};
}

test("空间充足时菜单贴 pill 左对齐、无平移", () => {
	// mock pill 与菜单矩形：左缘 100、宽 240 → 右缘 340 远小于视口上限（1024-8），无需钳制
	const restore = mockRect({
		left: 100,
		right: 340,
		top: 0,
		bottom: 300,
		width: 240,
		height: 300,
	});
	try {
		render(
			<AgentDropdown
				agents={useAgentsStore.getState().list}
				value="dev"
				onPick={() => {}}
			/>,
		);
		fireEvent.click(screen.getByTestId("agent-select"));
		const menu = screen.getByTestId("agent-menu");
		// 左对齐 pill、顶部贴 pill 底部 +4（portal fixed 定位，不再用 transform 平移）
		expect(menu.style.left).toBe("100px");
		expect(menu.style.top).toBe("304px");
		expect(menu.style.transform).toBe("");
	} finally {
		restore();
	}
});

test("菜单超出视口右边缘时左移回屏幕内（fixed 定位钳制）", () => {
	// mock pill/菜单矩形：左缘 900、宽 240 → 右缘 1140 超出上限 1016 → left 钳到 776
	const restore = mockRect({
		left: 900,
		right: 1140,
		top: 0,
		bottom: 300,
		width: 240,
		height: 300,
	});
	try {
		render(
			<AgentDropdown
				agents={useAgentsStore.getState().list}
				value="dev"
				onPick={() => {}}
			/>,
		);
		fireEvent.click(screen.getByTestId("agent-select"));
		const menu = screen.getByTestId("agent-menu");
		// 右缘钳制：left = 视口宽 - 8 边距 - 菜单宽 = 1024 - 8 - 240 = 776
		expect(menu.style.left).toBe("776px");
		expect(menu.className).toContain("max-w-[calc(100vw-16px)]");
	} finally {
		restore();
	}
});

test("底部空间不足时菜单向上翻转（pill 顶部上方）", () => {
	// mock：pill 底部 760（视口 768 - 8 边距只剩 0），菜单高 300 → 向上翻转到 pill 顶部 700 上方
	const restore = mockRect({
		left: 100,
		right: 340,
		top: 700,
		bottom: 760,
		width: 240,
		height: 300,
	});
	try {
		render(
			<AgentDropdown
				agents={useAgentsStore.getState().list}
				value="dev"
				onPick={() => {}}
			/>,
		);
		fireEvent.click(screen.getByTestId("agent-select"));
		const menu = screen.getByTestId("agent-menu");
		// 向上翻转：top = pill.top(700) - 菜单高(300) - 间距 4 = 396
		expect(menu.style.top).toBe("396px");
	} finally {
		restore();
	}
});

test("搜索按 displayName 过滤（用户可见名称）", () => {
	const agents = [cfg("技术实现"), cfg("项目管理")];
	render(<AgentDropdown agents={agents} value="技术实现" onPick={() => {}} />);
	fireEvent.click(screen.getByTestId("agent-select"));
	fireEvent.change(screen.getByTestId("agent-search"), {
		target: { value: "技术" },
	});
	expect(screen.getByTestId("agent-item-技术实现")).toBeTruthy();
	expect(screen.queryByTestId("agent-item-项目管理")).toBeNull();
});

test("agents 为空时下拉显示无智能体", () => {
	render(<AgentDropdown agents={[]} value={null} onPick={() => {}} />);
	fireEvent.click(screen.getByTestId("agent-select"));
	expect(screen.getByText(/无智能体/)).toBeTruthy();
});

test('defaultLabel：列表顶部固定默认项，点击回调 onPick("")；搜索可过滤', () => {
	const picks: string[] = [];
	render(
		<AgentDropdown
			agents={useAgentsStore.getState().list}
			value="dev"
			onPick={(n) => {
				picks.push(n);
			}}
			defaultLabel="系统默认（列表第一项）"
		/>,
	);
	fireEvent.click(screen.getByTestId("agent-select"));
	// 默认项固定在列表顶部
	const def = screen.getByTestId("agent-item-default");
	expect(def.textContent).toContain("系统默认");
	fireEvent.click(def);
	expect(picks).toEqual([""]);

	// 搜索不命中默认项文案时默认项隐藏
	render(
		<AgentDropdown
			agents={useAgentsStore.getState().list}
			value={null}
			onPick={() => {}}
			defaultLabel="系统默认（列表第一项）"
			pillTestId="agent-select-2"
			itemTestIdPrefix="agent2"
		/>,
	);
	fireEvent.click(screen.getByTestId("agent-select-2"));
	expect(screen.getByTestId("agent2-item-default")).toBeTruthy();
	fireEvent.change(screen.getByTestId("agent2-search"), {
		target: { value: "验收" },
	});
	expect(screen.queryByTestId("agent2-item-default")).toBeNull();
	fireEvent.change(screen.getByTestId("agent2-search"), {
		target: { value: "默认" },
	});
	expect(screen.getByTestId("agent2-item-default")).toBeTruthy();
});

test("菜单内部列表滚动不关闭（可滚动查看完整列表）", () => {
	render(
		<AgentDropdown
			agents={useAgentsStore.getState().list}
			value="dev"
			onPick={() => {}}
		/>,
	);
	fireEvent.click(screen.getByTestId("agent-select"));
	expect(screen.getByTestId("agent-search")).toBeTruthy();
	// 模拟菜单内部滚动列表（scroll target 在菜单内）→ 不关闭
	const menu = screen.getByTestId("agent-menu");
	fireEvent.scroll(menu, { target: menu });
	expect(screen.getByTestId("agent-search")).toBeTruthy();
});

test("外部容器滚动关闭菜单（fixed 脱锚防护）", () => {
	render(
		<AgentDropdown
			agents={useAgentsStore.getState().list}
			value="dev"
			onPick={() => {}}
		/>,
	);
	fireEvent.click(screen.getByTestId("agent-select"));
	expect(screen.getByTestId("agent-search")).toBeTruthy();
	// 模拟弹窗内容区滚动（scroll target 是菜单外的任意元素）→ 关闭
	fireEvent.scroll(document.body);
	expect(screen.queryByTestId("agent-search")).toBeNull();
});
