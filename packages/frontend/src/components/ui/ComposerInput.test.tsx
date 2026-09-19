// ComposerInput 附件选文件原生能力测试：
// 1. Electron 下点击 📎 走系统文件选择对话框（waPiApp.showOpenFileDialog），不打开内置 FilePicker
// 2. 非 Electron 环境回退到内置 FilePicker
import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";

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

import { ComposerInput } from "./ComposerInput";
import { useProjectsStore } from "../../store/projects";
import { useProvidersStore } from "../../store/providers";
import { useSkillsStore } from "../../store/skills";
import { useAgentsStore } from "../../store/agents";
import { useCommandsStore } from "../../store/commands";
import { useSessionStore } from "../../store/session";
import { _setFsTransport } from "../../fs-client";

const showOpenFileDialog = mock(async () => [] as string[]);

// FilePicker 回退场景用：注入伪 fs 传输层，避免依赖真实 api-client
function mockFsTransport() {
	_setFsTransport({
		get: async (path: string) => {
			if (path === "/api/fs/roots") return { roots: ["C:\\"] };
			if (path === "/api/fs/home") return { home: "C:\\Users\\co" };
			return {};
		},
		post: async () => ({}),
		del: async () => ({}),
	});
}

function seedStores() {
	useProjectsStore.setState({
		projects: [{ id: "proj-1", name: "P1", cwd: "/p1", createdAt: 0 }] as any,
		sessions: [],
		currentProjectId: "proj-1",
		currentSessionId: null,
	} as any);
	useProvidersStore.setState({ providers: [] } as any);
	useSkillsStore.setState({
		allSkills: [],
		skills: [],
		dirs: [],
		disabledSkills: [],
		builtinDir: "",
	} as any);
	useAgentsStore.setState({ list: [] } as any);
	useCommandsStore.setState({ commands: [], load: mock(() => {}) } as any);
	useSessionStore.setState({ openFilePreview: mock(() => {}) } as any);
}

function renderComposer() {
	return render(
		<ComposerInput
			text=""
			setText={() => {}}
			model={null}
			setModel={() => {}}
			thinking="high"
			setThinking={() => {}}
			attachments={[]}
			setAttachments={() => {}}
			projectId="proj-1"
			sessionId="s1"
			onSend={() => {}}
			isNewSession
			modelAutoSelectEnabled
		/>,
	);
}

beforeEach(() => {
	getMock.mockImplementation(async () => ({}));
	postMock.mockImplementation(async () => ({ path: "/uploads/x" }));
	showOpenFileDialog.mockClear();
	showOpenFileDialog.mockImplementation(async () => []);
	(window as any).waPiApp = { showOpenFileDialog };
	mockFsTransport();
	seedStores();
});

afterEach(() => {
	delete (window as any).waPiApp;
	_setFsTransport(null);
});

test("Electron 下点击附件按钮调用系统文件选择对话框", async () => {
	renderComposer();
	fireEvent.click(screen.getByTestId("composer-attach-btn"));
	await new Promise((r) => setTimeout(r, 0));

	expect(showOpenFileDialog).toHaveBeenCalledTimes(1);
	expect(screen.queryByTestId("file-picker")).toBeNull();
});

test("非 Electron 环境点击附件按钮打开内置文件选择器", async () => {
	delete (window as any).waPiApp;
	renderComposer();
	fireEvent.click(screen.getByTestId("composer-attach-btn"));

	expect(await screen.findByTestId("file-picker")).toBeTruthy();
	expect(showOpenFileDialog).not.toHaveBeenCalled();
});

test("附件按钮渲染 SVG 图标而非 emoji", () => {
	renderComposer();
	const btn = screen.getByTestId("composer-attach-btn");
	expect(btn.querySelector("svg")).toBeTruthy();
	expect(btn.textContent).not.toContain("📎");
});

// ===== /发送给 IM 联系人 命令 → 弹窗 → 插入 chip token =====

import { useState } from "react";
import { useContactsStore } from "../../store/contacts";
import { useChannelsStore } from "../../store/channels";

const e2eContact = {
	id: "ct_ui1",
	channelId: "ch_ui1",
	kind: "person",
	userId: "ZhangSan",
	remark: "张三",
	firstChatAt: 0,
	lastChatAt: 0,
};
const e2eContact2 = {
	id: "ct_ui2",
	channelId: "ch_ui1",
	kind: "person",
	userId: "LiSi",
	remark: "李四",
	firstChatAt: 0,
	lastChatAt: 0,
};

function seedImStores() {
	useContactsStore.setState({ contacts: [e2eContact, e2eContact2] } as any);
	useChannelsStore.setState({ bots: [{ id: "ch_ui1", name: "企微机器人" }] } as any);
}

function ControlledComposer() {
	const [text, setText] = useState("/");
	return (
		<ComposerInput
			text={text}
			setText={setText}
			model={null}
			setModel={() => {}}
			thinking="high"
			setThinking={() => {}}
			attachments={[]}
			setAttachments={() => {}}
			projectId="proj-1"
			sessionId="s1"
			onSend={() => {}}
			modelAutoSelectEnabled
		/>
	);
}

function NewSessionComposer() {
	const [text, setText] = useState("/");
	return (
		<ComposerInput
			text={text}
			setText={setText}
			model={null}
			setModel={() => {}}
			thinking="high"
			setThinking={() => {}}
			attachments={[]}
			setAttachments={() => {}}
			projectId="proj-1"
			sessionId="s1"
			onSend={() => {}}
			isNewSession
			modelAutoSelectEnabled
		/>
	);
}

test("新建会话（isNewSession）时「发送给 IM 联系人」命令也可用，点击弹出联系人弹窗", async () => {
	getMock.mockImplementation(async (path: string) => {
		if (path === "/api/contacts") return { contacts: [e2eContact] };
		return {};
	});
	seedImStores();
	render(<NewSessionComposer />);

	const menu = await screen.findByTestId("quick-invoke-menu");
	expect(menu.textContent).toContain("发送给 IM 联系人");
	// 命令未禁用：点击应弹出联系人弹窗（全局推送不依赖会话状态）
	fireEvent.click(screen.getByText("发送给 IM 联系人"));
	const dialog = await screen.findByTestId("contact-picker-dialog");
	expect(dialog.textContent).toContain("张三");
});

test("/ 命令菜单含「发送给 IM 联系人」；选中 → 弹窗多选 → 插入多个 @im-push-to chip", async () => {
	// loadContacts 会重置 store：让 api mock 返回联系人（覆盖 beforeEach 的默认 {}）
	getMock.mockImplementation(async (path: string) => {
		if (path === "/api/contacts") return { contacts: [e2eContact, e2eContact2] };
		if (path === "/api/channels") return { channels: [{ id: "ch_ui1", name: "企微机器人" }] };
		return {};
	});
	seedImStores();
	render(<ControlledComposer />);

	// text="/" → 命令菜单打开，含目标命令且位于首位（需求：/ 菜单第一位）
	const menu = await screen.findByTestId("quick-invoke-menu");
	expect(menu.textContent).toContain("发送给 IM 联系人");
	expect(screen.getByTestId("quick-invoke-item-0").textContent).toContain(
		"发送给 IM 联系人",
	);

	// 选中命令 → 打开联系人弹窗（/ 触发文本被清除）
	fireEvent.click(screen.getByText("发送给 IM 联系人"));
	const dialog = await screen.findByTestId("contact-picker-dialog");
	expect(dialog.textContent).toContain("张三");

	// 多选两人 → 确认 → 输入框插入两个 chip（data-token 为 @im-push-to 标记）
	fireEvent.click(screen.getByTestId("contact-picker-item-ct_ui1"));
	fireEvent.click(screen.getByTestId("contact-picker-item-ct_ui2"));
	await new Promise((r) => setTimeout(r, 0));
	fireEvent.click(screen.getByTestId("contact-picker-ok"));
	const chip1 = await screen.findByText("发送给：张三");
	const chip2 = screen.getByText("发送给：李四");
	expect(chip1.closest("[data-token]")?.getAttribute("data-token")).toBe(
		"@im-push-to(ch_ui1,ct_ui1)",
	);
	expect(chip2.closest("[data-token]")?.getAttribute("data-token")).toBe(
		"@im-push-to(ch_ui1,ct_ui2)",
	);
});
