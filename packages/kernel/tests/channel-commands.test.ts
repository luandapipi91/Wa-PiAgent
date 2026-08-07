import { expect, test } from "bun:test";
import { parseCommand } from "../src/channels/commands";

const ctx = {
	projects: [
		{ id: "__system__", name: "默认工作区" },
		{ id: "p1", name: "hiagent" },
	],
	currentProjectId: "__system__",
	allowSwitch: true,
};

test("非指令文本 → handled=false", () => {
	expect(parseCommand("你好", ctx).handled).toBe(false);
	expect(parseCommand("/usego", ctx).handled).toBe(true); // 以 / 开头即按指令处理
});

test("/new → 重置会话", () => {
	const r = parseCommand("/new", ctx);
	expect(r.handled).toBe(true);
	expect(r.resetSession).toBe(true);
	expect(r.reply).toContain("新会话");
});

test("/projects → 列出工作区并标注当前", () => {
	const r = parseCommand("/projects", ctx);
	expect(r.reply).toContain("hiagent");
	expect(r.reply).toContain("默认工作区");
	expect(r.reply).toContain("当前");
});

test("/use 命中项目名 → switchProjectId", () => {
	const r = parseCommand("/use hiagent", ctx);
	expect(r.switchProjectId).toBe("p1");
	expect(r.reply).toContain("hiagent");
});

test("/use 未命中 → 报错并列出可用", () => {
	const r = parseCommand("/use 不存在的项目", ctx);
	expect(r.switchProjectId).toBeUndefined();
	expect(r.reply).toContain("未找到");
	expect(r.reply).toContain("hiagent");
});

test("/help 与未知指令 → 帮助文本", () => {
	expect(parseCommand("/help", ctx).reply).toContain("/new");
	expect(parseCommand("/xxx", ctx).reply).toContain("/new");
});

const PROJECTS = [
	{ id: "__system__", name: "默认工作区" },
	{ id: "proj_a", name: "项目A" },
];

test("allowSwitch=false：/use 被拒", () => {
	const r = parseCommand("/use 项目A", {
		projects: PROJECTS,
		currentProjectId: "__system__",
		allowSwitch: false,
	});
	expect(r.handled).toBe(true);
	expect(r.switchProjectId).toBeUndefined();
	expect(r.reply).toContain("不支持切换工作目录");
});

test("allowSwitch=false：/projects 被拒", () => {
	const r = parseCommand("/projects", {
		projects: PROJECTS,
		currentProjectId: "__system__",
		allowSwitch: false,
	});
	expect(r.handled).toBe(true);
	expect(r.reply).toContain("不支持切换工作目录");
});

test("allowSwitch=false：/help 文案不含 /use 和 /projects", () => {
	const r = parseCommand("/help", {
		projects: PROJECTS,
		currentProjectId: "__system__",
		allowSwitch: false,
	});
	expect(r.handled).toBe(true);
	expect(r.reply).not.toContain("/use");
	expect(r.reply).not.toContain("/projects");
	expect(r.reply).toContain("/new");
});

test("allowSwitch=true：/use 行为不变（切换成功）", () => {
	const r = parseCommand("/use 项目A", {
		projects: PROJECTS,
		currentProjectId: "__system__",
		allowSwitch: true,
	});
	expect(r.handled).toBe(true);
	expect(r.switchProjectId).toBe("proj_a");
});

test("allowSwitch=true：/help 含 /use 和 /projects", () => {
	const r = parseCommand("/help", {
		projects: PROJECTS,
		currentProjectId: "__system__",
		allowSwitch: true,
	});
	expect(r.reply).toContain("/use");
	expect(r.reply).toContain("/projects");
});
