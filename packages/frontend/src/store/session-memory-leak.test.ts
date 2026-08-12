import { test, expect, beforeEach } from "bun:test";

const { useSessionStore } = await import("./session");

// 所有 per-session Record 字段——removeSession 须从每个中删除指定 sid
const PER_SESSION_KEYS = [
	"messagesBySession",
	"streamingBySession",
	"statusBySession",
	"thinkingSinceBySession",
	"unreadBySession",
	"optimisticEchoBySession",
	"historyLoadingBySession",
	"pendingPromptAtBySession",
	"promptErrorBySession",
	"queueBySession",
	"tokenTotals",
	"lastUsageBySession",
	"contextUsageBySession",
	"netStatusBySession",
	"retryBySession",
	"extStatusBySession",
	"extWidgetBySession",
	"extTitleBySession",
	"editorTextInjection",
] as const;

beforeEach(() => {
	useSessionStore.getState().clear();
});

test("removeSession 从所有 per-session Record 中清除指定会话，保留其他会话", () => {
	const store = useSessionStore.getState();
	const sid = "evict-me";
	const other = "keep-me";

	// 向所有 per-session Record 填充两个会话的标记数据
	for (const key of PER_SESSION_KEYS) {
		useSessionStore.setState({
			[key]: {
				[sid]: "MARKER",
				[other]: "MARKER",
			},
		});
	}

	store.removeSession(sid);

	const state = useSessionStore.getState() as Record<string, any>;
	for (const key of PER_SESSION_KEYS) {
		expect(state[key][sid], `${key}[${sid}] 应被清除`).toBeUndefined();
		expect(state[key][other], `${key}[${other}] 应保留`).toBeDefined();
	}
});

test("removeSession 清理属于该会话的子代理进度数据", () => {
	const store = useSessionStore.getState();
	const sid = "session-with-subagent";
	const tcId = "toolcall-1";
	const otherTcId = "toolcall-2";
	const otherSid = "other-session";

	useSessionStore.setState({
		progressSessionByToolCall: {
			[tcId]: sid,
			[otherTcId]: otherSid,
		},
		progressByToolCall: {
			[tcId]: { "agent-1": {} } as any,
			[otherTcId]: { "agent-2": {} } as any,
		},
	});

	store.removeSession(sid);

	const state = useSessionStore.getState();
	expect(state.progressByToolCall[tcId]).toBeUndefined();
	expect(state.progressSessionByToolCall[tcId]).toBeUndefined();
	// 其他会话的进度不受影响
	expect(state.progressByToolCall[otherTcId]).toBeDefined();
	expect(state.progressSessionByToolCall[otherTcId]).toBe(otherSid);
});

test("clear() 清空所有 per-session 数据（含 tokenTotals/queue/progress 等历史遗漏字段）", () => {
	// 填充所有 per-session 字段 + 子代理进度
	for (const key of PER_SESSION_KEYS) {
		useSessionStore.setState({
			[key]: { s1: "MARKER" },
		});
	}
	useSessionStore.setState({
		progressByToolCall: { tc1: {} as any },
		progressSessionByToolCall: { tc1: "s1" },
	});

	useSessionStore.getState().clear();

	const state = useSessionStore.getState() as Record<string, any>;
	for (const key of PER_SESSION_KEYS) {
		expect(Object.keys(state[key]).length, `${key} 应为空`).toBe(0);
	}
	expect(Object.keys(state.progressByToolCall).length).toBe(0);
	expect(Object.keys(state.progressSessionByToolCall).length).toBe(0);
});
