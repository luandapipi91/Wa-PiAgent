// App 层集成测试：kernel 推送的 proxy:status 事件经 App.tsx 分发后：
// - unreachable → 弹常驻 toast（含代理地址与原因），重复推送不叠多条
// - ok → 收掉告警 toast 并提示恢复
//
// 为什么必须有这一层：中继只负责广播事件，前端若漏接/拼错事件名，
// 用户仍然「不知道代理失效了」——这正是本次要修的问题。
import "./mock-composer-db";
import { test, expect, mock, beforeEach } from "bun:test";
import { render, waitFor, cleanup } from "@testing-library/react";
import i18n from "i18next";

let proxyStatusResult: any = null;
mock.module("../src/api-client", () => ({
	api: {
		// 只应答代理状态快照；其余接口一律 null（App 挂载时各 store.load 的 if(data) 不触发）
		get: (path: string) =>
			path === "/api/proxy/status"
				? Promise.resolve(proxyStatusResult)
				: Promise.resolve(null),
		post: () => Promise.resolve({}),
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

const eventHandlers = new Set<(e: any) => void>();
mock.module("../src/events", () => ({
	onMessage: (cb: any) => {
		eventHandlers.add(cb);
		return () => eventHandlers.delete(cb);
	},
	onEventType: () => () => {},
	connectEvents: () => {},
	disconnectEvents: () => {
		eventHandlers.clear();
	},
	onReconnect: () => () => {},
	emitEventForTesting: (e: any) => {
		eventHandlers.forEach((h) => h(e));
	},
}));

import { App } from "../src/App";
import { useProjectsStore } from "../src/store/projects";
import { useToastStore } from "../src/store/toast";

const emitEvent = (e: any) => {
	eventHandlers.forEach((h) => h(e));
};

const UPSTREAM = "http://127.0.0.1:7890";

beforeEach(() => {
	eventHandlers.clear();
	proxyStatusResult = null;
	useToastStore.setState({ toasts: [] });
	useProjectsStore.setState({
		projects: [{ id: "p1", name: "P", cwd: "/p", createdAt: 0 }],
		sessions: [],
		currentSessionId: null,
	} as any);
});

test("挂载时补拉 /api/proxy/status：启动时已不可达也能弹提示", async () => {
	proxyStatusResult = {
		status: {
			state: "unreachable",
			upstream: UPSTREAM,
			reason: "connect ECONNREFUSED 127.0.0.1:7890",
		},
	};
	const { queryByText } = render(<App />);
	await waitFor(() => expect(queryByText(new RegExp("7890"))).toBeTruthy());
	expect(useToastStore.getState().toasts.length).toBe(1);
	cleanup();
});

test("proxy:status unreachable → 弹常驻 toast，重复推送不叠加", async () => {
	const { queryAllByTestId, queryByText } = render(<App />);

	emitEvent({
		type: "proxy:status",
		state: "unreachable",
		upstream: UPSTREAM,
		reason: "connect ECONNREFUSED 127.0.0.1:7890",
	});

	// 文案含代理地址（i18n 由 zh/en 任一语言渲染，都包含 upstream 串）
	await waitFor(() => expect(queryByText(new RegExp("7890"))).toBeTruthy());
	expect(queryAllByTestId("toast-container").length).toBe(1);
	expect(useToastStore.getState().toasts.length).toBe(1);

	// 同一状态再推一次（中继去重后一般不会，但前端也要自保）：仍只有一条
	emitEvent({
		type: "proxy:status",
		state: "unreachable",
		upstream: UPSTREAM,
		reason: "connect ECONNREFUSED 127.0.0.1:7890",
	});
	await new Promise((r) => setTimeout(r, 50));
	expect(useToastStore.getState().toasts.length).toBe(1);

	cleanup();
});

test("proxy:status ok → 收掉告警 toast，并提示已恢复", async () => {
	render(<App />);

	emitEvent({
		type: "proxy:status",
		state: "unreachable",
		upstream: UPSTREAM,
		reason: "connect ECONNREFUSED 127.0.0.1:7890",
	});
	await waitFor(() => expect(useToastStore.getState().toasts.length).toBe(1));

	emitEvent({ type: "proxy:status", state: "ok", upstream: UPSTREAM });
	await waitFor(() => {
		const msgs = useToastStore.getState().toasts.map((t) => t.message);
		expect(msgs).toEqual([i18n.t("app.proxyRecovered")]);
	});

	cleanup();
});

test("用户关代理（ok + upstream 空）→ 只收告警，不提示恢复", async () => {
	render(<App />);

	emitEvent({
		type: "proxy:status",
		state: "unreachable",
		upstream: UPSTREAM,
		reason: "connect ECONNREFUSED 127.0.0.1:7890",
	});
	await waitFor(() => expect(useToastStore.getState().toasts.length).toBe(1));

	emitEvent({ type: "proxy:status", state: "ok", upstream: "" });
	await waitFor(() => expect(useToastStore.getState().toasts.length).toBe(0));

	cleanup();
});

// 回归：刷新页面不该弹「代理已恢复」。
// 根因：补拉（GET /api/proxy/status）与 SSE 推送共用一个处理函数，补拉拿到
// ok 就把「当前状态是好的」当成「刚刚恢复」，于是每次刷新/重连都弹一次。
test("补拉拿到 ok：不弹「代理已恢复」（刷新页面不是恢复事件）", async () => {
	proxyStatusResult = { status: { state: "ok", upstream: UPSTREAM } };
	render(<App />);

	await new Promise((r) => setTimeout(r, 300));
	expect(useToastStore.getState().toasts.length).toBe(0);
	cleanup();
});

test("补拉拿到 unreachable 后 SSE 推 ok：仍按恢复处理（收告警 + 提示）", async () => {
	proxyStatusResult = {
		status: { state: "unreachable", upstream: UPSTREAM, reason: "ECONNREFUSED" },
	};
	render(<App />);
	await waitFor(() => expect(useToastStore.getState().toasts.length).toBe(1));

	emitEvent({ type: "proxy:status", state: "ok", upstream: UPSTREAM });
	await waitFor(() => {
		const msgs = useToastStore.getState().toasts.map((t) => t.message);
		expect(msgs).toEqual([i18n.t("app.proxyRecovered")]);
	});
	cleanup();
});

test("没有任何告警时收到 ok：不弹「代理已恢复」", async () => {
	render(<App />);
	emitEvent({ type: "proxy:status", state: "ok", upstream: UPSTREAM });
	await new Promise((r) => setTimeout(r, 200));
	expect(useToastStore.getState().toasts.length).toBe(0);
	cleanup();
});

// 回归：「代理连接失败反复弹」前端侧根因。
// ① unreachable 路径 dismiss+add 销毁重建：同一条告警第二次推送（如 reason 变化、
//    SSE 重连补拉）会重放入场动画，用户感知就是「又弹了一次」。
// ② proxyToastId 是模块级变量，dev HMR 后归 null 而 store 里告警还挂着：ok 收不掉、
//    下次 unreachable 叠加。修复：按 tag 在 store 里查找，不依赖易失变量。
test("重复 unreachable（reason 变化）→ 原地更新同一条 toast，id 不变不重建", async () => {
	render(<App />);

	emitEvent({
		type: "proxy:status",
		state: "unreachable",
		upstream: UPSTREAM,
		reason: "connect ECONNREFUSED 127.0.0.1:7890",
	});
	await waitFor(() => expect(useToastStore.getState().toasts.length).toBe(1));
	const firstId = useToastStore.getState().toasts[0].id;

	emitEvent({
		type: "proxy:status",
		state: "unreachable",
		upstream: UPSTREAM,
		reason: "connect ETIMEDOUT 127.0.0.1:7890",
	});
	await new Promise((r) => setTimeout(r, 50));
	// 仍只有一条，且 id 不变（原地更新，不销毁重建 → 不重放弹出动画）
	expect(useToastStore.getState().toasts.length).toBe(1);
	expect(useToastStore.getState().toasts[0].id).toBe(firstId);
	// 内容同步更新为最新原因
	expect(useToastStore.getState().toasts[0].message).toContain("ETIMEDOUT");

	cleanup();
});

test("按 tag 查找：store 里已有代理告警（模拟 HMR 后变量丢失）→ 不叠加、ok 能收", async () => {
	render(<App />);

	// 模拟 HMR：模块级 proxyToastId 归 null，但 store 里上一版模块创建的告警还挂着
	useToastStore.setState({
		toasts: [
			{ id: "toast-legacy", message: "代理不可达（旧）", type: "error", tag: "proxy-status" },
		],
	});

	emitEvent({
		type: "proxy:status",
		state: "unreachable",
		upstream: UPSTREAM,
		reason: "connect ECONNREFUSED 127.0.0.1:7890",
	});
	await new Promise((r) => setTimeout(r, 50));
	// 按 tag 找到既有告警 → 原地更新，不叠加第二条
	expect(useToastStore.getState().toasts.length).toBe(1);
	expect(useToastStore.getState().toasts[0].id).toBe("toast-legacy");

	emitEvent({ type: "proxy:status", state: "ok", upstream: UPSTREAM });
	await waitFor(() => {
		// 告警（tag）被收掉；upstream 非空 → 若恢复提示还在（3s 自动消失）也只剩它
		const rest = useToastStore.getState().toasts;
		expect(rest.find((t) => t.tag === "proxy-status")).toBeUndefined();
	});

	cleanup();
});

// 防御性：同 tag 告警的「至多一条」目前靠调用纪律维持（任何未来代码直接 add 带
// tag 的常驻 toast 都可能造出第二条），ok 必须按 tag 全部收掉，不能只收 find 到的第一条
test("多条同 tag 告警：ok 按 tag 全部收掉，不残留", async () => {
	render(<App />);
	useToastStore.setState({
		toasts: [
			{ id: "toast-a", message: "代理不可达 A", type: "error", tag: "proxy-status" },
			{ id: "toast-b", message: "代理不可达 B", type: "error", tag: "proxy-status" },
		],
	});

	emitEvent({ type: "proxy:status", state: "ok", upstream: UPSTREAM });
	await waitFor(() => {
		expect(
			useToastStore.getState().toasts.filter((t) => t.tag === "proxy-status"),
		).toHaveLength(0);
	});

	cleanup();
});
