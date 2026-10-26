// 任务完成通知请求：requestTaskDoneNotice 组装 i18n 文案 → 主进程系统通知桥（send）
import { beforeEach, expect, mock, test } from "bun:test";
import type { SessionEntity } from "@wa-pi/shared";

// send 调用记录：每个用例断言 payload 形状与文案
const sendCalls: Record<string, unknown>[] = [];

// projects store 顶层 import api-client，mock 掉避免真实请求（参照 session-sound.test.ts）
mock.module("../src/api-client", () => ({
	api: {
		get: () => Promise.resolve({ messages: [] }),
		post: () => Promise.resolve({}),
		put: () => Promise.resolve({}),
		del: () => Promise.resolve({}),
	},
}));

import i18n from "../src/i18n";
import { requestTaskDoneNotice } from "../src/store/notice";
import { useProjectsStore } from "../src/store/projects";

function session(id: string, title: string): SessionEntity {
	return {
		id,
		projectId: "p1",
		primaryAgent: "dev",
		title,
		createdAt: 0,
		lastActivity: 0,
		piSessionFile: "",
	};
}

beforeEach(async () => {
	sendCalls.length = 0;
	// 桌面版桥 mock：send 透传记录 payload；onAction 本任务不消费
	(window as any).waPiNotice = {
		send: (payload: Record<string, unknown>) => {
			sendCalls.push(payload);
			return Promise.resolve({ sent: true });
		},
		onAction: () => () => {},
	};
	useProjectsStore.setState({ sessions: [] });
	await i18n.changeLanguage("zh");
});

test("桥缺失 → requestTaskDoneNotice 静默返回不抛", () => {
	delete (window as any).waPiNotice;
	expect(() => requestTaskDoneNotice("s1")).not.toThrow();
});

test("zh：组装 标题=任务完成，正文=「会话A」已完成，点击查看", () => {
	useProjectsStore.setState({ sessions: [session("s1", "会话A")] });
	requestTaskDoneNotice("s1");
	expect(sendCalls).toHaveLength(1);
	expect(sendCalls[0].title).toBe("任务完成");
	expect(sendCalls[0].body).toBe("「会话A」已完成，点击查看");
});

test("en：组装 Task Completed / \"sessionA\" finished, click to view", async () => {
	await i18n.changeLanguage("en");
	useProjectsStore.setState({ sessions: [session("s1", "sessionA")] });
	requestTaskDoneNotice("s1");
	expect(sendCalls).toHaveLength(1);
	expect(sendCalls[0].title).toBe("Task Completed");
	expect(sendCalls[0].body).toBe('"sessionA" finished, click to view');
});

test("title 为空串 → 正文用「未命名会话」词条", () => {
	useProjectsStore.setState({ sessions: [session("s1", "")] });
	requestTaskDoneNotice("s1");
	expect(sendCalls).toHaveLength(1);
	expect(sendCalls[0].body).toBe("未命名会话");
});

test("会话不在 projectsStore.sessions → 同样不抛、用默认文案", () => {
	expect(() => requestTaskDoneNotice("missing")).not.toThrow();
	expect(sendCalls).toHaveLength(1);
	expect(sendCalls[0].body).toBe("未命名会话");
});

test("payload 形状：{ title, body, action:{type:'session',sessionId}, backgroundOnly:true }", () => {
	useProjectsStore.setState({ sessions: [session("s1", "会话A")] });
	requestTaskDoneNotice("s1");
	expect(sendCalls[0]).toEqual({
		title: "任务完成",
		body: "「会话A」已完成，点击查看",
		action: { type: "session", sessionId: "s1" },
		backgroundOnly: true,
	});
});
