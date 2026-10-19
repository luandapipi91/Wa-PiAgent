// Composer-send-guard.test.tsx — 发送前归属硬校验（2026-10-08 事故修复 · 任务组二 B2）
//
// 缺陷背景：Composer.doSend 的 projectId 派生是 `session?.projectId ?? currentProjectId`
// ——会话不在列表（切换竞态/快照滞后窗口）时静默回落「当前选中项目」发出，
// pid 带错 → kernel 按错误项目建会话/定位进程 → 会话 2 操作会话 1 的工作目录。
// 目标行为：查不到会话 → 禁止发送（不发请求）+ toast 错误提示，宁可不发不可发错。
import "./mock-composer-db";
import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { Composer } from "../src/components/Composer";
import { VirtuosoMockContext } from "react-virtuoso";
import { useProjectsStore } from "../src/store/projects";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { useProvidersStore } from "../src/store/providers";
import { useCommandsStore } from "../src/store/commands";
import { useSkillsStore } from "../src/store/skills";
import { useSessionStore } from "../src/store/session";
import { useToastStore } from "../src/store/toast";
import { composerDbDefaults, composerDbSessions } from "./mock-composer-db";
import { disconnectEvents } from "../src/events";

const apiCalls: { method: string; path: string; body?: any }[] = [];

mock.module("../src/api-client", () => ({
	api: {
		get: (path: string) => {
			apiCalls.push({ method: "get", path });
			if (path.includes("/messages")) {
				return Promise.resolve({ messages: [], isActive: false });
			}
			return Promise.resolve({});
		},
		post: (path: string, body?: any) => {
			apiCalls.push({ method: "post", path, body });
			return Promise.resolve({});
		},
		put: () => Promise.resolve({}),
		del: () => Promise.resolve({}),
	},
	ApiError: class extends Error {
		status: number;
		constructor(m: string, s: number) {
			super(m);
			this.status = s;
			this.name = "ApiError";
		}
	},
}));

afterEach(() => cleanup());

function typeIntoComposer(value: string) {
	const textbox = screen
		.getByTestId("composer-input")
		.querySelector('[role="textbox"]') as HTMLElement;
	textbox.textContent = value;
	fireEvent.input(textbox);
	return textbox;
}

beforeEach(() => {
	apiCalls.length = 0;
	disconnectEvents();
	composerDbDefaults.model = "openai/gpt-4o";
	composerDbDefaults.thinking = "disabled";
	for (const k of Object.keys(composerDbSessions)) delete composerDbSessions[k];
	// 关键：sessions 列表不含 s1（切换竞态/快照滞后窗口），仅 currentProjectId="p1"
	useProjectsStore.setState({
		projects: [{ id: "p1", name: "P", cwd: "/work/p1", createdAt: 0 }],
		sessions: [],
		currentProjectId: "p1",
		currentSessionId: "s1",
	});
	useProvidersStore.setState({
		providers: [
			{
				id: "prov-anthropic",
				name: "anthropic",
				api: "anthropic-messages",
				baseUrl: "",
				apiKey: "",
				models: [{ id: "claude-sonnet", contextWindow: 200000, maxTokens: 8192 }],
			},
		],
	});
	useComposerPrefsStore.setState({
		defaults: { model: null, thinking: "disabled" },
		bySession: {
			s1: { model: "anthropic/claude-sonnet", thinking: "disabled", attachments: [] },
		},
		loadedBySession: { s1: true },
	});
	useSessionStore.setState({
		messagesBySession: {},
		streamingBySession: {},
		statusBySession: {},
		optimisticEchoBySession: {},
		queueBySession: {},
		pendingBySession: {},
	});
	useCommandsStore.setState({ commands: [], allCommands: [], loading: false });
	useSkillsStore.setState({
		skills: [],
		allSkills: [],
		dirs: [],
		disabledSkills: [],
		builtinDir: "",
		loading: false,
		load: () => {},
		setAll: () => {},
		toggleSkill: () => {},
	});
	useToastStore.setState({ toasts: [] });
});

test("会话不在列表 → 禁止回落全局项目发送 + toast 错误提示", async () => {
	render(
		<VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 60 }}>
			<Composer sessionId="s1" agentName="dev" />
		</VirtuosoMockContext.Provider>,
	);
	await act(async () => {});
	const textbox = typeIntoComposer("归属未知的消息");
	fireEvent.keyDown(textbox, { key: "Enter" });
	await act(async () => {});

	// 红灯：现状回落 currentProjectId=p1 照发（会话 2 带会话 1 目录的前端根因之一）
	expect(apiCalls.some((c) => c.path.includes("/prompt"))).toBe(false);
	expect(useToastStore.getState().toasts.length).toBeGreaterThan(0);
});
