// file_changes → 预览自动刷新 接线测试（bun:test）：
// 任务完成上报的修改清单事件到达 session store 时，应把 (sessionId, files) 交给
// browser store 的 maybeRefreshForFileChanges 做命中判定——命中当前会话预览文件即刷新。
// 判定逻辑本身在 browser-refresh.test.ts 已完整覆盖，这里只锁「事件确实接线到判定」。
import { beforeEach, expect, mock, test } from "bun:test";

// 声音/青蛙动画不进单测（避免 Audio 副作用）
mock.module("../../util/sound", () => ({
	playTaskDone: () => {},
	playNeedsAction: () => {},
	previewTaskDone: () => {},
}));
mock.module("../../util/frog", () => ({
	triggerTaskDoneFrog: () => {},
}));

import { useSessionStore } from "../session";
import { useBrowserStore } from "../browser";

beforeEach(() => {
	useBrowserStore.setState({
		open: true,
		path: "/tmp/proj/index.html",
		sessionId: "s1",
		refreshToken: 0,
	});
});

function sdkFileChanges(sessionId: string, files: Array<{ path: string }>) {
	return {
		type: "sdk:event",
		projectId: "p",
		sessionId,
		agentName: "a",
		event: { type: "file_changes", files },
	} as any;
}

test("file_changes 命中当前会话预览文件 → 刷新令牌递增", () => {
	useSessionStore
		.getState()
		.handleSDKEvent(
			"s1",
			sdkFileChanges("s1", [{ path: "/tmp/proj/index.html" }]),
		);
	expect(useBrowserStore.getState().refreshToken).toBe(1);
});

test("file_changes 未命中（改的是非同目录文件）→ 刷新令牌不变", () => {
	useSessionStore
		.getState()
		.handleSDKEvent(
			"s1",
			sdkFileChanges("s1", [{ path: "/tmp/other/other.html" }]),
		);
	expect(useBrowserStore.getState().refreshToken).toBe(0);
});
