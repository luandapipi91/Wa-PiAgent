// SessionView-queue-tri-state.test.tsx — 队列面板三态可见化（2026-10-08 事故修复 · 任务 5）
//
// 目标行为：
// 1. 收到 kernel pending_update → 面板出现「待投递」区（条目文本可见）——
//    此前消息落了 WAL 但前端零展示，用户看不到「已排队等进程就绪」
// 2. queue_update 到达 → 已进内存队列的文本从「待投递」对账到「已入队」
// 3. 用户消息落盘（message_end role=user）→ 对应待投递条目清除（已真正投出）
// 4. 「立即」提升失败 → toast 错误提示 + 乐观移动回滚（同 handlePromote，任务 2 补齐）
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
// 控制 /steer/immediate 是否失败（红灯阶段：handleImmediate 的 void 调用无 catch）
let immediateFail = false;

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
			if (immediateFail && path.includes("/steer")) {
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
	immediateFail = false;
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
		pendingBySession: {},
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

test("收到 pending_update → 队列面板出现「待投递」区（条目文本可见）", async () => {
	await renderSessionView("s1");
	await act(async () => {
		useSessionStore.getState().handleSDKEvent("s1", {
			event: { type: "pending_update", count: 1, texts: ["交接消息"] },
		} as any);
	});
	// 红灯：面板不渲染待投递区（pending_update 未被消费）
	expect(screen.getByTestId("queue-pending")).toBeTruthy();
	expect(screen.getByTestId("queue-pending").textContent).toContain("交接消息");
});

test("queue_update 到达 → 已进内存队列的文本从「待投递」对账到「已入队」", async () => {
	await renderSessionView("s1");
	await act(async () => {
		useSessionStore.getState().handleSDKEvent("s1", {
			event: { type: "pending_update", count: 1, texts: ["消息A"] },
		} as any);
	});
	expect(screen.getByTestId("queue-pending").textContent).toContain("消息A");

	await act(async () => {
		useSessionStore.getState().handleSDKEvent("s1", {
			event: { type: "queue_update", steering: [], followUp: ["消息A"] },
		} as any);
	});
	// 对账：消息A 已在排队区（已入队），待投递区随空列表整体消失，不重复展示
	expect(screen.queryByTestId("queue-pending")).toBeNull();
	expect(screen.getByTestId("queue-panel-content").textContent).toContain("消息A");
});

test("用户消息落盘（message_end）→ 对应待投递条目清除", async () => {
	await renderSessionView("s1");
	await act(async () => {
		useSessionStore.getState().handleSDKEvent("s1", {
			event: { type: "pending_update", count: 1, texts: ["直发消息"] },
		} as any);
	});
	expect(screen.getByTestId("queue-pending").textContent).toContain("直发消息");

	await act(async () => {
		useSessionStore.getState().handleSDKEvent("s1", {
			event: {
				type: "message_end",
				message: {
					role: "user",
					content: [{ type: "text", text: "直发消息" }],
					timestamp: Date.now(),
				},
			},
		} as any);
	});
	expect(screen.queryByTestId("queue-pending")).toBeNull();
});

test("「立即」提升失败 → toast 错误提示 + 消息回滚到排队区", async () => {
	immediateFail = true;
	useSessionStore.setState({
		statusBySession: { s1: "idle" },
		queueBySession: { s1: { steering: [], followUp: ["消息B"] } },
	});
	await renderSessionView("s1");

	const btn = screen.getAllByTestId("btn-immediate")[0];
	await act(async () => {
		btn.click();
	});
	// 红灯：handleImmediate 的 void api.post 无 catch——无 toast、乐观移动不回滚
	expect(useToastStore.getState().toasts.length).toBeGreaterThan(0);
	expect(
		useSessionStore.getState().queueBySession.s1?.followUp.includes("消息B"),
	).toBe(true);
});
