// 启动更新检查契约（2026-11-28 修订）：主进程装配 updater 时即并行发起检查，updater:get-info
// 带回最近事件；渲染端挂载时直接应用（有新版本 → 卡片随主窗口出现，不再多等一次网络往返），
// 渲染端不再自己发起启动检查（失败重试由主进程负责：退避重试 + 显窗时补查）。
import { afterEach, beforeEach, expect, mock, test } from "bun:test";

// notice.ts 顶层 import projects store → api-client，mock 掉避免真实请求
mock.module("../src/api-client", () => ({
	api: {
		get: () => Promise.resolve({ messages: [] }),
		post: () => Promise.resolve({}),
		put: () => Promise.resolve({}),
		del: () => Promise.resolve({}),
	},
}));

import { initUpdater, useUpdaterStore } from "../src/store/updater";
import { initUpdateNotice } from "../src/store/notice";
import { useUiPrefsStore } from "../src/store/ui-prefs";

const sendCalls: Record<string, unknown>[] = [];
const cleanups: (() => void)[] = [];
let checkCalls = 0;

/** 桌面桥 mock：getInfo 带回主进程启动检查的最近事件；check 计数 */
function mockBridges(lastEvent: Record<string, unknown> | null | undefined) {
	checkCalls = 0;
	(window as any).waPiUpdater = {
		getInfo: async () => ({ appVersion: "0.10.16", isDesktop: true, lastEvent }),
		check: async () => {
			checkCalls++;
			return { ok: true };
		},
		download: async () => ({ ok: true }),
		quitAndInstall: async () => ({ ok: true }),
		onEvent: () => () => {},
	};
	(window as any).waPiNotice = {
		send: (payload: Record<string, unknown>) => {
			sendCalls.push(payload);
			return Promise.resolve({ sent: true });
		},
		onAction: () => () => {},
	};
}
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
	sendCalls.length = 0;
	useUpdaterStore.setState({
		status: "idle",
		latestVersion: null,
		releaseNotes: null,
		error: null,
		isDesktop: false,
		appVersion: "",
	});
	useUiPrefsStore.setState({ lastUpdateNoticeDate: undefined });
});

afterEach(() => {
	while (cleanups.length) cleanups.pop()!();
	delete (window as any).waPiUpdater;
	delete (window as any).waPiNotice;
});

// ---- initUpdater：应用主进程启动检查的最近事件 ----

test("get-info 带回 available → store 直接进入 available（版本/说明同步），不发起检查", async () => {
	mockBridges({ phase: "available", version: "0.10.17", releaseNotes: "修复" });
	initUpdater();
	await flush();
	const s = useUpdaterStore.getState();
	expect(s.status).toBe("available");
	expect(s.latestVersion).toBe("0.10.17");
	expect(s.releaseNotes).toBe("修复");
	expect(s.isDesktop).toBe(true);
	expect(s.appVersion).toBe("0.10.16");
	expect(checkCalls).toBe(0);
});

test("get-info 带回 checking → status=checking，不发起检查（等事件流）", async () => {
	mockBridges({ phase: "checking" });
	initUpdater();
	await flush();
	expect(useUpdaterStore.getState().status).toBe("checking");
	expect(checkCalls).toBe(0);
});

test("get-info 带回 up-to-date（自动检查）→ 静默 idle", async () => {
	useUpdaterStore.setState({ status: "checking" });
	mockBridges({ phase: "up-to-date" });
	initUpdater();
	await flush();
	expect(useUpdaterStore.getState().status).toBe("idle");
	expect(checkCalls).toBe(0);
});

test("get-info 带回 error → status=error 并保留错误信息，渲染端不自己补查（主进程负责重试）", async () => {
	mockBridges({ phase: "error", message: "net::ERR_PROXY_CONNECTION_FAILED" });
	initUpdater();
	await flush();
	const s = useUpdaterStore.getState();
	expect(s.status).toBe("error");
	expect(s.error).toBe("net::ERR_PROXY_CONNECTION_FAILED");
	expect(checkCalls).toBe(0);
});

test("get-info 无 lastEvent（dev / 浏览器）→ 状态不变、不发起检查", async () => {
	mockBridges(undefined);
	initUpdater();
	await flush();
	expect(useUpdaterStore.getState().status).toBe("idle");
	expect(checkCalls).toBe(0);
});

// ---- 启动链路：主进程已有结果 → 卡片随主窗口出现，全程不发起检查 ----

test("启动链路：get-info available + initUpdateNotice → 卡片 send 一次（标题含版本、action=update），未发起检查", async () => {
	mockBridges({ phase: "available", version: "0.10.17", releaseNotes: "n" });
	initUpdater();
	cleanups.push(initUpdateNotice());
	await flush();
	expect(sendCalls).toHaveLength(1);
	expect(String(sendCalls[0].title)).toContain("0.10.17");
	expect(sendCalls[0].action).toEqual({ type: "update" });
	expect(checkCalls).toBe(0);
});

test("initUpdateNotice 不再自己发起启动检查", async () => {
	mockBridges(undefined);
	cleanups.push(initUpdateNotice());
	await flush();
	expect(checkCalls).toBe(0);
});
