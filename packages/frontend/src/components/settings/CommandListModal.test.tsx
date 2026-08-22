// packages/frontend/src/components/settings/CommandListModal.test.tsx
// 参照 tests/ExtensionSection.test.tsx / SkillSection.test.tsx 的风格（bun:test + RTL + happy-dom）。
import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { CommandListModal } from "./CommandListModal";

// 组件内部走 api.get("/api/extensions/commands") / api.post("/api/extensions/commands/toggle")，
// happy-dom 在 about:blank 下对相对 URL 抛 NotSupportedError，mock 掉 api-client。
const getMock = mock();
const postMock = mock();
mock.module("../../api-client", () => ({
	api: {
		get: getMock,
		post: postMock,
		put: () => Promise.resolve({}),
		del: () => Promise.resolve({}),
	},
}));

beforeEach(() => {
	getMock.mockClear();
	postMock.mockClear();
});

// 构造两条属于目标插件、一条属于其他插件的命令
const sampleCommands = () => [
	{
		name: "goal",
		description: "设定目标并拆解步骤",
		source: "extension",
		packageName: "superpowers-zh",
		enabled: false,
	},
	{
		name: "tui-cmd",
		description: "终端专属命令",
		source: "extension",
		packageName: "superpowers-zh",
		enabled: true,
	},
	{
		name: "other",
		description: "其他插件的命令",
		source: "extension",
		packageName: "demo-toolkit",
		enabled: false,
	},
];

test("打开时拉取命令并按 packageName 过滤，渲染命令列表 + 顶部提示条", async () => {
	getMock.mockImplementation(async () => ({ commands: sampleCommands() }));
	render(<CommandListModal packageName="superpowers-zh" onClose={() => {}} />);

	// 目标插件的命令出现（/前缀 + 描述）
	expect(await screen.findByText("/goal")).toBeTruthy();
	expect(screen.getByText("设定目标并拆解步骤")).toBeTruthy();
	expect(screen.getByText("/tui-cmd")).toBeTruthy();

	// 其他插件的命令被过滤掉
	expect(screen.queryByText("/other")).toBeNull();

	// 顶部提示条已移除（TUI 命令提示文案下线）
	expect(screen.queryByText(/TUI 命令不被支持/)).toBeNull();

	// 打开时调用了 GET
	expect(getMock).toHaveBeenCalledWith("/api/extensions/commands");
});

test("开关切换：立即翻转本地状态并调用 toggle API", async () => {
	getMock.mockImplementation(async () => ({ commands: sampleCommands() }));
	postMock.mockImplementation(async () => ({}));
	render(<CommandListModal packageName="superpowers-zh" onClose={() => {}} />);

	const toggle = await screen.findByTestId("cmd-toggle-goal");
	// 初始关：按钮背景为灰色
	const knob = toggle.querySelector("span");
	expect((knob as HTMLElement).style.background).toBe("var(--hairline-strong)");

	fireEvent.click(toggle);

	// 即切即存：POST 携带正确参数
	expect(postMock).toHaveBeenCalledWith("/api/extensions/commands/toggle", {
		packageName: "superpowers-zh",
		command: "goal",
		enabled: true,
	});
	// 乐观更新：开关立即变绿
	const knobAfter = toggle.querySelector("span");
	expect((knobAfter as HTMLElement).style.background).toBe("var(--brand)");
});

test("默认关：enabled=false 的命令开关初始为关闭状态", async () => {
	getMock.mockImplementation(async () => ({ commands: sampleCommands() }));
	render(<CommandListModal packageName="superpowers-zh" onClose={() => {}} />);

	const offToggle = await screen.findByTestId("cmd-toggle-goal");
	const offKnob = offToggle.querySelector("span");
	expect((offKnob as HTMLElement).style.background).toBe("var(--hairline-strong)");

	// enabled=true 的命令开关初始为开启（绿色）
	const onToggle = screen.getByTestId("cmd-toggle-tui-cmd");
	const onKnob = onToggle.querySelector("span");
	expect((onKnob as HTMLElement).style.background).toBe("var(--brand)");
});

test("空状态：该插件未注册斜杠命令", async () => {
	getMock.mockImplementation(async () => ({ commands: [] }));
	render(<CommandListModal packageName="empty-pkg" onClose={() => {}} />);
	expect(await screen.findByText("该插件未注册斜杠命令")).toBeTruthy();
});

test("点击关闭按钮触发 onClose", async () => {
	getMock.mockImplementation(async () => ({ commands: [] }));
	let closed = false;
	render(
		<CommandListModal
			packageName="empty-pkg"
			onClose={() => {
				closed = true;
			}}
		/>,
	);
	await screen.findByText("该插件未注册斜杠命令");
	fireEvent.click(screen.getByTestId("cmd-modal-close"));
	expect(closed).toBe(true);
});

test("加载中：api.get 未返回前显示加载指示，返回后切换为命令列表", async () => {
	// 可控 promise：先挂起 api.get，验证加载态出现，再 resolve 验证列表出现
	let resolveGet!: (v: any) => void;
	getMock.mockImplementation(
		() =>
			new Promise((res) => {
				resolveGet = res;
			}),
	);

	render(<CommandListModal packageName="superpowers-zh" onClose={() => {}} />);

	// 加载中：显示加载指示，且不显示空状态/命令列表
	expect(screen.getByTestId("cmd-loading")).toBeTruthy();
	expect(screen.queryByText("该插件未注册斜杠命令")).toBeNull();
	expect(screen.queryByText("/goal")).toBeNull();

	// resolve 后：加载指示消失，命令列表出现
	resolveGet({ commands: sampleCommands() });
	expect(await screen.findByText("/goal")).toBeTruthy();
	expect(screen.queryByTestId("cmd-loading")).toBeNull();
});
