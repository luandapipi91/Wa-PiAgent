// 通知队列管理器单测：同会话合并（只刷内容、不动位置）、循环切换、移除后索引前移/回退/应关闭信号。
// 纯逻辑模块（零 Electron 依赖），直接导入 .cjs 单测（同 log.cjs.test.ts 先例）。
import { test, expect } from "bun:test";
// @ts-ignore 无类型的 cjs 模块
import { createNoticeQueue } from "../src/notice/notice-queue.cjs";

function item(sessionId: string, title: string) {
	return { title, body: `body-${sessionId}`, sessionId };
}

test("空队列首条入队：index=0，count=1", () => {
	const q = createNoticeQueue();
	expect(q.count).toBe(0);
	expect(q.index).toBe(-1); // 空队列无当前条
	q.enqueue({ title: "t1", body: "b1", action: { type: "update" } });
	expect(q.count).toBe(1);
	expect(q.index).toBe(0);
	expect(q.items[0]).toMatchObject({ title: "t1", body: "b1" });
});

test("新 sessionId 追加到队尾，index 指向新条", () => {
	const q = createNoticeQueue();
	q.enqueue({ ...item("a", "t1"), action: { type: "session", sessionId: "a" } });
	q.enqueue({ ...item("b", "t2"), action: { type: "session", sessionId: "b" } });
	expect(q.count).toBe(2);
	expect(q.index).toBe(1);
	expect(q.items[1]).toMatchObject({ title: "t2" });
});

test("同 sessionId 已存在：仅刷新该条 title/body/action，位置与条数不变", () => {
	const q = createNoticeQueue();
	q.enqueue({ ...item("a", "t1"), action: { type: "update" } });
	q.enqueue({ ...item("b", "t2"), action: { type: "session", sessionId: "b" } });
	q.enqueue({ ...item("a", "t1-v2"), action: { type: "session", sessionId: "a" } });
	expect(q.count).toBe(2); // 条数不变：同会话多轮只保留一条
	expect(q.index).toBe(1); // 当前位置不动
	expect(q.items[0].title).toBe("t1-v2"); // 仍是第 0 条，仅内容刷新
	expect(q.items[0].body).toBe("body-a"); // body 同步刷新
	expect(q.items[0].action).toEqual({ type: "session", sessionId: "a" });
});

test("合并的会话不是当前条：当前 index 不动", () => {
	const q = createNoticeQueue();
	q.enqueue(item("a", "t1"));
	q.enqueue(item("b", "t2"));
	expect(q.index).toBe(1);
	q.enqueue(item("a", "t1-v2")); // 合并的是第 0 条
	expect(q.index).toBe(1);
	expect(q.items[0].title).toBe("t1-v2");
});

test("合并的会话正是当前条：index 不动，内容已刷新", () => {
	const q = createNoticeQueue();
	q.enqueue(item("a", "t1"));
	q.enqueue(item("b", "t2"));
	q.prev(); // 回到 t1（index=0）
	q.enqueue(item("a", "t1-v2"));
	expect(q.index).toBe(0);
	expect(q.items[0].title).toBe("t1-v2");
	expect(q.count).toBe(2);
});

test("无 sessionId 的入队各自成条，不参与合并", () => {
	const q = createNoticeQueue();
	q.enqueue({ title: "t1", body: "b1" });
	q.enqueue({ title: "t2", body: "b2" });
	expect(q.count).toBe(2);
	expect(q.index).toBe(1);
});

test("removeCurrent：移除非末条，index 指向下一条件目", () => {
	const q = createNoticeQueue();
	q.enqueue(item("a", "t1"));
	q.enqueue(item("b", "t2"));
	q.enqueue(item("c", "t3"));
	q.prev(); // 从 t3（index=2）回到 t2（index=1）
	expect(q.index).toBe(1);
	const shouldClose = q.removeCurrent();
	expect(shouldClose).toBe(false);
	expect(q.count).toBe(2);
	expect(q.index).toBe(1); // 原 t3 滑入 index=1
	expect(q.items[1].title).toBe("t3");
});

test("removeCurrent：移除末条，index 回退到前一条", () => {
	const q = createNoticeQueue();
	q.enqueue(item("a", "t1"));
	q.enqueue(item("b", "t2"));
	// 当前在末条 t2（index=1）
	const shouldClose = q.removeCurrent();
	expect(shouldClose).toBe(false);
	expect(q.count).toBe(1);
	expect(q.index).toBe(0);
	expect(q.items[0].title).toBe("t1");
});

test("removeCurrent：移除最后一条 → 返回应关闭信号，index 重置 -1", () => {
	const q = createNoticeQueue();
	q.enqueue(item("a", "t1"));
	expect(q.removeCurrent()).toBe(true);
	expect(q.count).toBe(0);
	expect(q.index).toBe(-1);
});

test("removeCurrent：空队列调用也返回应关闭信号（幂等）", () => {
	const q = createNoticeQueue();
	expect(q.removeCurrent()).toBe(true);
	expect(q.index).toBe(-1);
});

test("next：末条 → 首条循环", () => {
	const q = createNoticeQueue();
	q.enqueue(item("a", "t1"));
	q.enqueue(item("b", "t2"));
	expect(q.index).toBe(1); // 当前末条
	q.next();
	expect(q.index).toBe(0); // 绕回首条
	q.next();
	expect(q.index).toBe(1);
});

test("prev：首条 → 末条循环", () => {
	const q = createNoticeQueue();
	q.enqueue(item("a", "t1"));
	q.enqueue(item("b", "t2"));
	q.prev(); // 末条 → 首条
	expect(q.index).toBe(0);
	q.prev(); // 首条 → 末条
	expect(q.index).toBe(1);
});

test("单条 next/prev：循环后仍是本条", () => {
	const q = createNoticeQueue();
	q.enqueue(item("a", "t1"));
	q.next();
	expect(q.index).toBe(0);
	q.prev();
	expect(q.index).toBe(0);
});

test("空队列 next/prev：no-op，index 保持 -1", () => {
	const q = createNoticeQueue();
	q.next();
	q.prev();
	expect(q.index).toBe(-1);
});

test("count 与条数一致；clear 清空队列并重置 index", () => {
	const q = createNoticeQueue();
	q.enqueue(item("a", "t1"));
	q.enqueue(item("b", "t2"));
	expect(q.count).toBe(2);
	q.clear();
	expect(q.count).toBe(0);
	expect(q.items).toHaveLength(0);
	expect(q.index).toBe(-1);
});

test("action 载荷原样透传（同引用），不解析不变形", () => {
	const q = createNoticeQueue();
	const sessionAction = { type: "session", sessionId: "a" };
	q.enqueue({ ...item("a", "t1"), action: sessionAction });
	const updateAction = { type: "update" };
	q.enqueue({ ...item("b", "t2"), action: updateAction });
	q.next();
	expect(q.items[0].action).toBe(sessionAction); // 引用不变
	expect(q.items[1].action).toBe(updateAction);
});
