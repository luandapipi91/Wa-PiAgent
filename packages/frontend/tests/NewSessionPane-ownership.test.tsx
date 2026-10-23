// NewSessionPane-ownership.test.tsx — 新建会话归属显式化（2026-10-08 事故修复 · 任务组二 B1）
//
// 缺陷背景：项目下拉默认静默跟随全局 currentProjectId（= 上一个查看会话的项目），
// 用户不碰下拉直接发送 → 新会话生而归属错误项目（会话 2 带会话 1 目录的头号根因）。
// 目标行为：发送前「将归属项目」常驻可见，且实时跟随下拉选择——归属错了用户看得见。
import "./mock-composer-db";
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import {
	render,
	screen,
	fireEvent,
	act,
	cleanup,
} from "@testing-library/react";
import type { AgentConfig } from "@wa-pi/shared";
import { composerDbDefaults, composerDbSessions } from "./mock-composer-db";

const sent: { path: string; body?: any }[] = [];
const composerDbNewSessionIds: Record<string, string> = {};

mock.module("../src/api-client", () => ({
	api: {
		get: () => Promise.resolve({}),
		post: (path: string, body?: any) => {
			sent.push({ path, body });
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

mock.module("../src/store/composer-db", () => ({
	getDefaults: async () => ({ ...composerDbDefaults }),
	setDefaults: async () => {},
	getSessionPrefs: async (sessionId: string) => composerDbSessions[sessionId],
	setSessionPrefs: async () => {},
	deleteSessionPrefs: async () => {},
	getRecordingPrefs: async () => ({}),
	setRecordingPrefs: async () => {},
	getNewSessionIds: async () => ({ ...composerDbNewSessionIds }),
	setNewSessionIds: async (ids: Record<string, string>) => {
		for (const k of Object.keys(composerDbNewSessionIds))
			delete composerDbNewSessionIds[k];
		Object.assign(composerDbNewSessionIds, ids);
	},
}));

import { disconnectEvents } from "../src/events";
import { NewSessionPane } from "../src/components/NewSessionPane";
import { useProjectsStore } from "../src/store/projects";
import { useAgentsStore } from "../src/store/agents";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { useRecordingStore } from "../src/store/recording";
import { _setRecordingManager } from "../src/recording/recorder";
import { useSkillsStore } from "../src/store/skills";

const agentCfg = (displayName: string): AgentConfig => ({
	displayName,
	avatar: "",
	avatarColor: "",
	description: "",
	model: "m",
	thinking: "medium",
	tools: [],
	skills: [],
	mcpServers: [],
	partners: { askTo: [] },
});

const originalFetch = globalThis.fetch;

function mockFetch(path: string) {
	globalThis.fetch = mock(() =>
		Promise.resolve({ ok: true, json: () => Promise.resolve({ path }) }),
	) as any;
}

describe("新建会话归属显式化（B1）", () => {
	afterEach(() => cleanup());

	beforeEach(() => {
		composerDbDefaults.model = null;
		composerDbDefaults.thinking = "disabled";
		for (const k of Object.keys(composerDbSessions)) delete composerDbSessions[k];
		for (const k of Object.keys(composerDbNewSessionIds))
			delete composerDbNewSessionIds[k];
		sent.length = 0;
		disconnectEvents();
		mockFetch("/a/.wa-pi/uploads/note.txt");

		useProjectsStore.setState({
			projects: [
				{ id: "p1", name: "项目A", cwd: "/a", createdAt: 0 },
				{ id: "p2", name: "项目B", cwd: "/b", createdAt: 0 },
			],
			sessions: [],
			currentProjectId: "p1",
			currentSessionId: null,
		});
		useComposerPrefsStore.setState({
			defaults: { model: null, thinking: "disabled" },
			bySession: {},
			newSessionIds: {},
		});
		useAgentsStore.setState({
			list: [agentCfg("技术实现")],
		});
		useRecordingStore.setState({
			status: "idle",
			source: "mic",
			owningProjectId: "",
			owningSessionId: "",
			ownerLabel: "",
			startedAt: 0,
			elapsedMs: 0,
			error: undefined,
		});
		_setRecordingManager({
			start: async () => {},
			pause: () => {},
			resume: () => {},
			stop: async () => ({ path: "", size: 0, durationMs: 0 }),
		});
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
	});

	afterEach(() => {
		useSkillsStore.setState(useSkillsStore.getInitialState(), true);
		globalThis.fetch = originalFetch;
	});

	it("发送前常驻显示「将归属项目」标识，且跟随项目选择", async () => {
		render(<NewSessionPane />);
		await act(async () => {});
		// 红灯：现状无归属标识（归属信息只藏在下拉框里，静默跟随全局）
		const tag = screen.getByTestId("new-session-project-tag");
		expect(tag.textContent).toContain("将归属项目");
		expect(tag.textContent).toContain("项目A");

		// 切项目 → 标识实时跟随
		fireEvent.change(screen.getByTestId("project-select"), {
			target: { value: "p2" },
		});
		expect(tag.textContent).toContain("项目B");
	});
});
