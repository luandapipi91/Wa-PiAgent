import { test, expect, beforeEach, afterEach } from "bun:test";
import { handleBridgeRequest, registerBridgeSession, unregisterBridgeSession, getBridgeToken } from "../src/bridge-registry";
import { askRegistry } from "../src/ask-registry";
import { runAskTool } from "../src/ask-runner";
import type { AskParams } from "@wa-pi/shared";

const params: AskParams = {
	questions: [
		{
			question: "Q?",
			header: "h",
			options: [
				{ label: "A", description: "x" },
				{ label: "B", description: "y" },
			],
		},
	],
};

beforeEach(() => askRegistry.reset());
afterEach(() => unregisterBridgeSession("s1"));

// 僵尸提问回归：pi 侧 bridge fetch 超时/断连后，kernel 侧 askRegistry 条目必须
// 被清理（以 cancelled 解决），否则前端卡片看似有效、用户回答被静默吞掉。
// 修复手段：ws-server 把 req.signal 透传给 handleBridgeRequest → ctx.handleTool
// → runAskTool → askRegistry.ask 的 signal；客户端断连时条目自动作废。

test("handleBridgeRequest 透传 signal：abort 后 pending ask 以 cancelled 解决（僵尸清理）", async () => {
	registerBridgeSession("s1", {
		cwd: "/tmp",
		handleTool: (tool, toolCallId, p, signal) =>
			runAskTool("s1", toolCallId, p, signal),
	});
	const ctrl = new AbortController();
	const responseP = handleBridgeRequest(
		{
			token: getBridgeToken(),
			sessionId: "s1",
			toolCallId: "tc1",
			tool: "ask_user_question",
			params,
		},
		ctrl.signal,
	);
	// 注册完成后模拟客户端断连
	await new Promise((r) => setTimeout(r, 20));
	expect(askRegistry.pendingToolCallIds("s1")).toEqual(["tc1"]);
	ctrl.abort();
	const res = await responseP;
	expect(res.ok).toBe(true);
	// 条目已清理，不再残留 pending
	expect(askRegistry.pendingToolCallIds("s1")).toEqual([]);
});

// Bun 行为探针：Bun.serve 在客户端断连时是否 abort req.signal。
// 若本测试失败，说明 Bun 不支持该语义，ws-server 透传 req.signal 的修复无效，
// 需要换方案（如 kernel 侧与 bridge 对齐的硬超时）。
test("Bun.serve：客户端 abort fetch → 服务端 req.signal 触发 abort", async () => {
	let serverSawAbort = false;
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			return new Promise<Response>((resolve) => {
				req.signal.addEventListener("abort", () => {
					serverSawAbort = true;
					resolve(Response.json({ ok: true }));
				});
			});
		},
	});
	try {
		const ctrl = new AbortController();
		const clientP = fetch(`http://127.0.0.1:${server.port}/`, {
			signal: ctrl.signal,
		}).catch(() => {});
		await new Promise((r) => setTimeout(r, 100));
		ctrl.abort();
		await clientP;
		await new Promise((r) => setTimeout(r, 300));
		expect(serverSawAbort).toBe(true);
	} finally {
		server.stop(true);
	}
});
