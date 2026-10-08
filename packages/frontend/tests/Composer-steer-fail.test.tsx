// Composer-steer-fail.test.tsx — 引导（steer）发送失败必须回执 UI（任务 2）
//
// 缺陷背景（2026-10-08 事故三缺口之一）：Composer 运行中 Ctrl+Enter 引导发送
// 失败时仅 console.error（Composer.tsx 的 api.post(...).catch），用户零感知，
// 且乐观加入队列面板的引导条目永久残留，误导用户「引导已发出」。
// 目标行为：失败 → toast 错误提示（提示区可见）+ 乐观入队回滚。
import "./mock-composer-db";
import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import {
	render,
	screen,
	fireEvent,
	act,
	cleanup,
	waitFor,
} from "@testing-library/react";
import { composerDbDefaults, composerDbSessions } from "./mock-composer-db";

const apiCalls: { method: string; path: string; body?: any }[] = [];
// 控制 /steer 是否失败（红灯阶段：组件只 console.error，不产生任何 UI 回执）
let steerFail = false;

mock.module("../src/api-client", () => ({
	api: {
		get: () => Promise.resolve({}),
		post: (path: string, body?: any) => {
			apiCalls.push({ method: "post", path, body });
			if (steerFail && path.includes("/steer")) {
				return Promise.reject(new Error("EPIPE: broken pipe"));
			}
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

import { Composer } from "../src/components/Composer";
import { useCommandsStore } from "../src/store/commands";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { useProjectsStore } from "../src/store/projects";
import { useProvidersStore } from "../src/store/providers";
import { useSessionStore } from "../src/store/session";
import { useSkillsStore } from "../src/store/skills";
import { useToastStore } from "../src/store/toast";

function typeIntoComposer(value: string) {
	const textbox = screen
		.getByTestId("composer-input")
		.querySelector('[role="textbox"]') as HTMLElement;
	textbox.textContent = value;
	fireEvent.input(textbox);
	return textbox;
}

beforeEach(() => {
	steerFail = false;
	apiCalls.length = 0;
	composerDbDefaults.model = "openai/gpt-4o";
	composerDbDefaults.thinking = "disabled";
	for (const k of Object.keys(composerDbSessions)) delete composerDbSessions[k];
	useProjectsStore.setState({
		projects: [],
		sessions: [
			{
				id: "s1",
				projectId: "p1",
				primaryAgent: "dev",
				title: "t",
				createdAt: 0,
				lastActivity: 0,
				piSessionFile: "",
			},
		],
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
		bySession: {},
		loadedBySession: {},
	});
	useSessionStore.setState({
		messagesBySession: {},
		streamingBySession: {},
		statusBySession: {},
		optimisticEchoBySession: {},
		queueBySession: {},
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

afterEach(() => {
	cleanup();
	useSkillsStore.setState(useSkillsStore.getInitialState(), true);
});

test("引导发送失败 → toast 错误提示 + 乐观入队回滚", async () => {
	steerFail = true;
	useComposerPrefsStore.setState({
		bySession: {
			s1: {
				model: "anthropic/claude-sonnet",
				thinking: "disabled",
				attachments: [],
			},
		},
	});
	composerDbSessions.s1 = {
		model: "anthropic/claude-sonnet",
		thinking: "disabled",
		attachments: [],
	};

	render(<Composer sessionId="s1" agentName="dev" isRunning />);
	await act(async () => {});
	const textbox = typeIntoComposer("引导消息");
	fireEvent.keyDown(textbox, { key: "Enter", ctrlKey: true });

	await waitFor(() => {
		// steer 请求确实发出去了（失败发生在响应侧）
		expect(apiCalls.some((c) => c.path.includes("/steer"))).toBe(true);
	});
	// 等 catch 链与 React 状态更新落定
	await act(async () => {
		await new Promise((r) => setTimeout(r, 30));
	});

	// 1) 失败回执：错误提示对用户可见（此前仅 console.error，零感知）
	const toasts = useToastStore.getState().toasts;
	expect(toasts.some((t) => t.type === "error")).toBe(true);

	// 2) 乐观入队回滚：kernel 未收到引导，队列面板不得残留该条目误导用户
	const steering =
		useSessionStore.getState().queueBySession["s1"]?.steering ?? [];
	expect(steering).not.toContain("引导消息");
});
