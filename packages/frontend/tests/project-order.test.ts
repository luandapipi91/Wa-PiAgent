import { test, expect } from "bun:test";
import type { SessionEntity } from "@wa-pi/shared";
import { orderSessions } from "../src/util/projectOrder";

// 会话工厂：lastActivity 可指定
const mk = (id: string, lastActivity: number): SessionEntity => ({
	id,
	projectId: "p1",
	primaryAgent: "dev",
	title: `t-${id}`,
	createdAt: 0,
	lastActivity,
	piSessionFile: "",
});

const list = [mk("old", 1000), mk("mid", 2000), mk("new", 3000)];

test("首次（lastOrder 为空）按 lastActivity 倒序", () => {
	expect(orderSessions(list, null, false).map((s) => s.id)).toEqual([
		"new",
		"mid",
		"old",
	]);
});

test("shouldReorder 时无视旧顺序，按 lastActivity 倒序重排", () => {
	// 旧稳定顺序与 lastActivity 排序不一致，强制重排后应按 lastActivity
	const staleOrder = ["old", "new", "mid"];
	expect(orderSessions(list, staleOrder, true).map((s) => s.id)).toEqual([
		"new",
		"mid",
		"old",
	]);
});

test("稳定顺序：保持 lastOrder 相对顺序，新会话按 lastActivity 插入", () => {
	const lastOrder = ["new", "mid", "old"];
	const withNewcomer = [...list, mk("fresh", 1500)];
	// fresh(1500) 应插到 mid(2000) 之后、old(1000) 之前
	expect(orderSessions(withNewcomer, lastOrder, false).map((s) => s.id)).toEqual([
		"new",
		"mid",
		"fresh",
		"old",
	]);
});

test("稳定顺序：lastOrder 中已删除的会话被剔除", () => {
	const lastOrder = ["new", "gone", "mid", "old"]; // gone 已不在 list
	expect(orderSessions(list, lastOrder, false).map((s) => s.id)).toEqual([
		"new",
		"mid",
		"old",
	]);
});

test("lastActivity 相等时保持输入顺序（稳定排序）", () => {
	const tie = [mk("a", 1000), mk("b", 1000), mk("c", 1000)];
	expect(orderSessions(tie, null, false).map((s) => s.id)).toEqual([
		"a",
		"b",
		"c",
	]);
});
