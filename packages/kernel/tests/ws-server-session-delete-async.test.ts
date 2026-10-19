// session:delete 立即响应：进程清理（disposeSession 内含最多 5s 的温和停止兜底）放后台，
// 软删/广播/HTTP 响应不被无响应 pi 进程拖住（删除会话固定卡 5 秒的回归锁定）。
import { test, expect } from "bun:test";
import { WSServer } from "../src/ws-server";

function makeServer(opts: {
	dispose: { started: boolean; release: () => void };
	deleted: { v: boolean };
	broadcasts: any[];
}) {
	const server = new WSServer({
		projectStore: {
			loadActive: async () => ({ projects: [], sessions: [] }),
			deleteSession: async () => {
				opts.deleted.v = true;
			},
		},
		agentManager: {
			disposeSession: async () => {
				opts.dispose.started = true;
				// 模拟无响应 pi 进程：挂起直到测试释放（对应 5s abort 兜底窗口）
				await new Promise<void>((r) => {
					opts.dispose.release = r;
				});
			},
		},
	} as any);
	(server as any).broadcast = (e: any) => opts.broadcasts.push(e);
	return server;
}

test("session:delete：disposeSession 未完成时删除处理已返回（进程清理不阻塞）", async () => {
	const dispose = { started: false, release: () => {} };
	const deleted = { v: false };
	const broadcasts: any[] = [];
	const server = makeServer({ dispose, deleted, broadcasts });

	let apiDone = false;
	const api = server
		.callApi({ type: "session:delete", sessionId: "s1" } as any)
		.then(() => {
			apiDone = true;
		});

	// 给后台清理与删除主流程若干拍微/宏任务：此时 disposeSession 仍应挂起
	await new Promise((r) => setTimeout(r, 20));

	// 清理语义不丢：后台确实启动了 disposeSession
	expect(dispose.started).toBe(true);
	// ★ 核心：删除处理不等待进程清理（旧实现 await disposeSession → 此处卡死）
	expect(apiDone).toBe(true);
	// 软删与列表广播均已完成
	expect(deleted.v).toBe(true);
	expect(broadcasts).toContainEqual({
		type: "projects:list",
		projects: [],
		sessions: [],
	});

	// 释放后台清理，确认整链无悬挂
	dispose.release();
	await api;
});
