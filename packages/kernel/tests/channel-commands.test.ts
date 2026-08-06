import { expect, test } from "bun:test";
import { parseCommand } from "../src/channels/commands";

const ctx = {
	projects: [
		{ id: "__system__", name: "默认工作区" },
		{ id: "p1", name: "hiagent" },
	],
	currentProjectId: "__system__",
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
