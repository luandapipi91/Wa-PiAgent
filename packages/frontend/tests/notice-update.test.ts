// 场景②：启动自动检测更新 + 自然日去重的「新版本」系统通知
import { afterEach, beforeEach, expect, mock, test } from "bun:test";

// send 调用记录：每个用例断言 payload 形状与文案
const sendCalls: Record<string, unknown>[] = [];
// initUpdateNotice 挂的订阅统一登记，afterEach 逐个退订，避免用例间残留
const cleanups: (() => void)[] = [];
// 原型方法原件：afterEach 恢复，避免固定日期泄漏到其他测试文件
const realDateProto = {
	getFullYear: Date.prototype.getFullYear,
	getMonth: Date.prototype.getMonth,
	getDate: Date.prototype.getDate,
};

// notice.ts 顶层 import projects store → api-client，mock 掉避免真实请求
mock.module("../src/api-client", () => ({
	api: {
		get: () => Promise.resolve({ messages: [] }),
		post: () => Promise.resolve({}),
		put: () => Promise.resolve({}),
		del: () => Promise.resolve({}),
	},
}));

import i18n from "../src/i18n";
import { initUpdateNotice, shouldSendUpdateNotice } from "../src/store/notice";
import { useUpdaterStore } from "../src/store/updater";
import { useUiPrefsStore } from "../src/store/ui-prefs";

beforeEach(async () => {
	sendCalls.length = 0;
	// 固定 localDateString 依赖的三个 getter：日期断言不依赖真实时钟（跨午夜不 flaky）；
	// 此环境的 bun:test mock 无 spyOn/setSystemTime，手动替换 + afterEach 恢复
	Date.prototype.getFullYear = () => 2026;
	Date.prototype.getMonth = () => 0; // 0 = 一月
	Date.prototype.getDate = () => 15;
	// 桌面版桥 mock：send 透传记录 payload
	(window as any).waPiNotice = {
		send: (payload: Record<string, unknown>) => {
			sendCalls.push(payload);
			return Promise.resolve({ sent: true });
		},
		onAction: () => () => {},
	};
	useUpdaterStore.setState({ status: "idle", latestVersion: null });
	useUiPrefsStore.setState({ lastUpdateNoticeDate: undefined });
	await i18n.changeLanguage("zh");
});

afterEach(() => {
	while (cleanups.length) cleanups.pop()!();
	Date.prototype.getFullYear = realDateProto.getFullYear;
	Date.prototype.getMonth = realDateProto.getMonth;
	Date.prototype.getDate = realDateProto.getDate;
});

// ---- shouldSendUpdateNotice 纯函数（日期由传参控制，不依赖真实时钟）----

test("lastDate 为空 → true", () => {
	expect(shouldSendUpdateNotice("2026-01-15", undefined)).toBe(true);
});

test("lastDate === today → false", () => {
	expect(shouldSendUpdateNotice("2026-01-15", "2026-01-15")).toBe(false);
});

test("lastDate === 昨天 → true", () => {
	expect(shouldSendUpdateNotice("2026-01-15", "2026-01-14")).toBe(true);
});

// ---- initUpdateNotice（mock waPiNotice + 直接 setState updaterStore 触发订阅）----

test("status=available 且今天未发 → waPiNotice.send 被调，标题含 latestVersion 版本号，action={type:'update'}，不设 backgroundOnly", () => {
	cleanups.push(initUpdateNotice());
	useUpdaterStore.setState({ status: "available", latestVersion: "1.2.3" });
	expect(sendCalls).toHaveLength(1);
	expect(sendCalls[0].title).toContain("1.2.3");
	expect(sendCalls[0].body).toBe("点击查看新版本更新内容");
	expect(sendCalls[0].action).toEqual({ type: "update" });
	expect(sendCalls[0].backgroundOnly).toBeUndefined();
	// 默认 themeMode=system → 卡片浅色（dark 映射由 notice-task-done.test.ts 的 noticeTheme 用例覆盖）
	expect(sendCalls[0].theme).toBe("light");
});

test("available 但 lastUpdateNoticeDate===今天 → 不调", () => {
	useUiPrefsStore.setState({ lastUpdateNoticeDate: "2026-01-15" });
	cleanups.push(initUpdateNotice());
	useUpdaterStore.setState({ status: "available", latestVersion: "1.2.3" });
	expect(sendCalls).toHaveLength(0);
});

test("status=error / up-to-date / checking → 不调", () => {
	cleanups.push(initUpdateNotice());
	for (const status of ["error", "up-to-date", "checking"] as const) {
		useUpdaterStore.setState({ status, latestVersion: "1.2.3" });
	}
	expect(sendCalls).toHaveLength(0);
});

test("发送成功后 ui-prefs.lastUpdateNoticeDate 被记为今天（YYYY-MM-DD）", () => {
	cleanups.push(initUpdateNotice());
	useUpdaterStore.setState({ status: "available", latestVersion: "1.2.3" });
	expect(useUiPrefsStore.getState().lastUpdateNoticeDate).toBe("2026-01-15");
});

test("桥缺失 → initUpdateNotice no-op", () => {
	delete (window as any).waPiNotice;
	const cleanup = initUpdateNotice();
	// 连检测也不启动、订阅也不挂：available 事件不触发 send，清理函数可安全调用
	useUpdaterStore.setState({ status: "available", latestVersion: "1.2.3" });
	expect(sendCalls).toHaveLength(0);
	expect(() => cleanup()).not.toThrow();
});
