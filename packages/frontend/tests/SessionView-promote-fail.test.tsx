// SessionView-promote-fail.test.tsx — 队列「引导」提升失败必须回执 UI（任务 2）
//
// 缺陷背景（2026-10-08 事故三缺口之一）：SessionView.handlePromote 乐观把消息
// 从排队区移到引导区后 `void api.post(.../steer)` 无 catch——失败时零反馈，
// 消息从面板上「消失」（既不在 followUp 也没真正投出）。
// 目标行为：失败 → toast 错误提示 + 乐观移动回滚（消息回到排队区，可重试）。
import "./mock-composer-db";
import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, act, cleanup } from "@testing-library/react";
import { SessionView } from "../src/components/SessionView";
import { VirtuosoMockContext } from "react-virtuoso";
import type { SessionMessage } from "@wa-pi/shared";
import { useProjectsStore } from "../src/store/projects";
import { useSessionStore } from "../src/store/session";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { useProvidersStore } from "../src/store/providers";
import { useSkillsStore } from "../src/store/skills";
import { useCommandsStore } from "../src/store/commands";
import { composerDbDefaults, composerDbSessions } from "./mock-composer-db";
import { disconnectEvents } from "../src/events";
import { useToastStore } from "../src/store/toast";

const apiCalls: { method: string; path: string; body?: any }[] = [];
// 控制 /steer 是否失败（红灯阶段：handlePromote 的 void 调用无 catch，零回执）
let steerFail = false;

mock.module("../src/api-client", () => ({
	api: {
		get: (path: string) => {
			apiCalls.push({ method: "get", path });
			if (path.includes("/messages")) {
				return Promise.resolve({
					messages: [] as SessionMessage[],
					isActive: false,
				});
			}
			return Promise.resolve({});
		},
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

afterEach(() => cleanup());

beforeEach(() => {
	steerFail = false;
	apiCalls.length = 0;
	disconnectEvents();
	composerDbDefaults.model = "openai/gpt-4o";
	composerDbDefaults.thinking = "disabled";
	for (const k of Object.keys(composerDbSessions)) delete composerDbSessions[k];

	useProjectsStore.setState({
		projects: [{ id: "p1", name: "P", cwd: "/work/p1", createdAt: 0 }],
		sessions: [
			{
				id: "s1",
				projectId: "p1",
				primaryAgent: "dev",
				title: "测试",
				createdAt: 0,
				lastActivity: 0,
				piSessionFile: "",
			},
		],
		currentProjectId: "p1",
		currentSessionId: "s1",
	});
	useSessionStore.setState({
		messagesBySession: {},
		historyLoadingBySession: {},
		lastUsageBySession: {},
		tokenTotals: {},
		contextUsageBySession: {},
		statusBySession: {},
		streamingBySession: {},
		queueBySession: {},
		optimisticEchoBySession: {},
	});
	useComposerPrefsStore.setState({
		bySession: {},
		defaults: { model: null, thinking: "disabled" },
	});
	useProvidersStore.setState({ providers: [] });
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

async function renderSessionView(sessionId: string) {
	const result = render(
		<VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 60 }}>
			<SessionView sessionId={sessionId} />
		</VirtuosoMockContext.Provider>,
	);
	await act(async () => {});
	return result;
}

test("队列「引导」提升失败 → toast 错误提示 + 消息回滚到排队区", async () => {
	steerFail = true;
	useSessionStore.setState({
		statusBySession: { s1: "idle" },
		queueBySession: { s1: { steering: [], followUp: ["消息A"] } },
	});
	await renderSessionView("s1");

	const btn = screen.getAllByTestId("btn-promote")[0];
	await act(async () => {
		btn.click();
	});
	// 等 catch 链与 React 状态更新落定
	await act(async () => {
		await new Promise((r) => setTimeout(r, 30));
	});

	// 1) 失败回执：错误提示对用户可见（此前 void 无 catch，零感知）
	const toasts = useToastStore.getState().toasts;
	expect(toasts.some((t) => t.type === "error")).toBe(true);

	// 2) 乐观移动回滚：消息从引导区回到排队区（此前失败时消息从面板上「消失」）
	const q = useSessionStore.getState().queueBySession["s1"]!;
	expect(q.steering).not.toContain("消息A");
	expect(q.followUp).toContain("消息A");
});
