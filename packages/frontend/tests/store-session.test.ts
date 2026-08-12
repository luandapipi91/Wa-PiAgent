// Task 8: store/session.ts — sdk:event 处理与流式两态管理的单测
// 说明：项目测试栈为 bun:test（非 vitest），按项目既有规范编写。
import { test, expect, beforeEach, mock } from "bun:test";
import { useSessionStore } from "../src/store/session";
import { useProjectsStore } from "../src/store/projects";
import { useExtDialogStore } from "../src/store/ext-dialog";
import type { SDKEventEnvelope } from "@wa-pi/shared";

// message_update 已接 rAF 合帧（batcher）：断言前需等帧末提交
const flushFrames = () =>
  new Promise<void>((resolve) => {
    const raf: (fn: () => void) => void =
      globalThis.requestAnimationFrame ?? ((fn) => setTimeout(fn, 16) as any);
    raf(() => raf(() => resolve()));
  });

// refreshTokenTotals 会调用 api.get 拉取会话历史 + 会话统计；mock 掉 api-client，
// 返回可注入的 messages / stats，断言聚焦于「压缩回合结束触发刷新」逻辑。
const mockMessages: { messages: any[] } = { messages: [] };
let mockStats: { stats: any } | null = null;
let getCalls = 0;

mock.module("../src/api-client", () => ({
	api: {
		get: (url: string) => {
			getCalls++;
			if (url.includes("/stats")) return Promise.resolve(mockStats);
			return Promise.resolve(mockMessages);
		},
		post: () => Promise.resolve({}),
		put: () => Promise.resolve({}),
		del: () => Promise.resolve({}),
	},
}));

beforeEach(() => {
	// 每个 case 前重置状态，避免相互污染
	mockStats = null;
	useSessionStore.setState({
		messagesBySession: {},
		streamingBySession: {},
		statusBySession: {},
		thinkingSinceBySession: {},
		retryBySession: {},
		optimisticEchoBySession: {},
		historyLoadingBySession: {},
		tokenTotals: {},
		lastUsageBySession: {},
		contextUsageBySession: {},
		editorTextInjection: {},
	});
	useExtDialogStore.setState({ queue: [] });
});

// 构造 sdk:event 信封的便捷工厂
function envelope(
	event: SDKEventEnvelope["event"],
	sessionId = "s1",
): SDKEventEnvelope {
	return {
		type: "sdk:event",
		projectId: "p1",
		sessionId,
		agentName: "dev",
		event,
	};
}

// ── 历史加载标记：SessionView 发请求置 true、收响应置 false ──

test("setHistoryLoading：按会话隔离地切换加载标志", () => {
	useSessionStore.getState().setHistoryLoading("s1", true);
	useSessionStore.getState().setHistoryLoading("s2", true);
	expect(useSessionStore.getState().historyLoadingBySession["s1"]).toBe(true);
	expect(useSessionStore.getState().historyLoadingBySession["s2"]).toBe(true);
	// 仅清 s1，不影响 s2
	useSessionStore.getState().setHistoryLoading("s1", false);
	expect(useSessionStore.getState().historyLoadingBySession["s1"]).toBe(false);
	expect(useSessionStore.getState().historyLoadingBySession["s2"]).toBe(true);
});

// ── 未读标记：非当前会话收到回复完成（agent_end）标记 new，进入会话清掉 ──

test("agent_end：非当前会话标记未读；当前会话不标记", () => {
	useProjectsStore.setState({ currentSessionId: "s-cur" });
	// 非当前会话 s1 完成 → 未读
	useSessionStore
		.getState()
		.handleSDKEvent(
			"s1",
			envelope({ type: "agent_end", messages: [], willRetry: false }),
		);
	expect(useSessionStore.getState().unreadBySession["s1"]).toBe(true);
	// 当前会话 s-cur 完成 → 不标记
	useSessionStore
		.getState()
		.handleSDKEvent(
			"s-cur",
			envelope({ type: "agent_end", messages: [], willRetry: false }),
		);
	expect(useSessionStore.getState().unreadBySession["s-cur"]).toBeFalsy();
});

test("markUnread / markRead 维护 unreadBySession", () => {
	useSessionStore.getState().markUnread("s1");
	expect(useSessionStore.getState().unreadBySession["s1"]).toBe(true);
	useSessionStore.getState().markRead("s1");
	expect(useSessionStore.getState().unreadBySession["s1"]).toBeFalsy();
});

test("message_start(user) 添加用户消息到 messages", () => {
	const env = envelope({
		type: "message_start",
		message: { role: "user", content: "你好", timestamp: 1 },
	});
	useSessionStore.getState().handleSDKEvent("s1", env);
	expect(useSessionStore.getState().messagesBySession["s1"]).toHaveLength(1);
	expect(useSessionStore.getState().messagesBySession["s1"][0].message).toEqual(
		{
			role: "user",
			content: "你好",
			timestamp: 1,
		},
	);
});

test("message_start(assistant) 设置 streamingMessage", () => {
	const env = envelope({
		type: "message_start",
		message: {
			role: "assistant",
			content: [],
			model: "m",
			stopReason: "stop",
			timestamp: 2,
		},
	});
	useSessionStore.getState().handleSDKEvent("s1", env);
	expect(useSessionStore.getState().streamingBySession["s1"]).toBeTruthy();
});

test("message_end 把 streamingMessage 移到 messages 并清空 streaming", () => {
	// 先模拟 message_start(assistant) 设好 streaming
	useSessionStore.setState({
		streamingBySession: {
			s1: {
				message: {
					role: "assistant",
					content: [],
					model: "m",
					stopReason: "stop",
					timestamp: 2,
				},
				agentName: "dev",
			},
		},
	});
	const env = envelope({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "回复" }],
			model: "m",
			stopReason: "stop",
			timestamp: 2,
		},
	});
	useSessionStore.getState().handleSDKEvent("s1", env);
	expect(useSessionStore.getState().streamingBySession["s1"]).toBeNull();
	expect(useSessionStore.getState().messagesBySession["s1"]).toHaveLength(1);
});

test("message_end(user) 不重复添加——user 消息在 message_start 时已加入", () => {
	// 先模拟 message_start(user) 已加入 messages
	useSessionStore.setState({
		messagesBySession: {
			s1: [
				{
					message: { role: "user", content: "你好", timestamp: 1 },
					agentName: "dev",
				},
			],
		},
	});
	// message_end(user) 不应再添加
	const env = envelope({
		type: "message_end",
		message: { role: "user", content: "你好", timestamp: 1 },
	});
	useSessionStore.getState().handleSDKEvent("s1", env);
	expect(useSessionStore.getState().messagesBySession["s1"]).toHaveLength(1);
});

test("message_end(toolResult) 追加工具结果消息到 messages，供渲染层关联 toolCall", () => {
	useSessionStore.setState({
		messagesBySession: {
			s1: [
				{
					agentName: "dev",
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "tc1",
								name: "web_search",
								arguments: { query: "auth" },
							},
						],
						model: "m",
						stopReason: "tool_use",
						timestamp: 1,
					},
				},
			],
		},
	});
	const env = envelope({
		type: "message_end",
		message: {
			role: "toolResult",
			toolCallId: "tc1",
			toolName: "web_search",
			content: [{ type: "text", text: "找到 3 条结果" }],
			isError: false,
			timestamp: 2,
		},
	});
	useSessionStore.getState().handleSDKEvent("s1", env);
	const msgs = useSessionStore.getState().messagesBySession["s1"];
	expect(msgs).toHaveLength(2);
	expect((msgs[1].message as any).role).toBe("toolResult");
	expect((msgs[1].message as any).toolCallId).toBe("tc1");
	expect(msgs[1].agentName as any).toBe("dev");
});

test("agent_start 设置 status=thinking", () => {
	const env = envelope({ type: "agent_start" });
	useSessionStore.getState().handleSDKEvent("s1", env);
	expect(useSessionStore.getState().statusBySession["s1"]).toBe("thinking");
});

test("agent_end 设置 status=idle", () => {
	useSessionStore.setState({ statusBySession: { s1: "thinking" } });
	const env = envelope({ type: "agent_end", messages: [], willRetry: false });
	useSessionStore.getState().handleSDKEvent("s1", env);
	expect(useSessionStore.getState().statusBySession["s1"]).toBe("idle");
});

// ── pi 自动重试：agent_end{willRetry:true} 只是单次尝试失败的中间态，
//    重试期间（auto_retry_start → 退避 → 新尝试）必须保持 thinking 不中断 ──

test("agent_end{willRetry:true}：保持 thinking 与 thinkingSince，不结算不标未读", () => {
	useProjectsStore.setState({ currentSessionId: "s-other" }); // 非当前会话也不应标未读
	useSessionStore.setState({
		statusBySession: { s1: "thinking" },
		thinkingSinceBySession: { s1: 123 },
		unreadBySession: {},
	});
	useSessionStore
		.getState()
		.handleSDKEvent(
			"s1",
			envelope({ type: "agent_end", messages: [], willRetry: true }),
		);
	const s = useSessionStore.getState();
	expect(s.statusBySession["s1"]).toBe("thinking");
	expect(s.thinkingSinceBySession["s1"]).toBe(123);
	expect(s.unreadBySession["s1"]).toBeFalsy();
});

test("auto_retry_start：记录重试进度 + 防御性保持 thinking（已有 thinkingSince 不覆盖）", () => {
	useSessionStore.setState({
		statusBySession: { s1: "idle" },
		thinkingSinceBySession: { s1: 456 },
	});
	useSessionStore.getState().handleSDKEvent(
		"s1",
		envelope({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 1000,
			errorMessage: "Connection error.",
		}),
	);
	const s = useSessionStore.getState();
	expect(s.statusBySession["s1"]).toBe("thinking");
	expect(s.thinkingSinceBySession["s1"]).toBe(456);
	expect(s.retryBySession["s1"]).toEqual({ attempt: 1, maxAttempts: 3 });
});

test("auto_retry_end{success:false}：清重试进度并复位 idle（退避期 abort 后不再有 agent_end）", () => {
	useSessionStore.setState({
		statusBySession: { s1: "thinking" },
		thinkingSinceBySession: { s1: 789 },
		retryBySession: { s1: { attempt: 3, maxAttempts: 3 } },
	});
	useSessionStore.getState().handleSDKEvent(
		"s1",
		envelope({
			type: "auto_retry_end",
			success: false,
			attempt: 3,
			finalError: "Retry cancelled",
		}),
	);
	const s = useSessionStore.getState();
	expect(s.statusBySession["s1"]).toBe("idle");
	expect(s.thinkingSinceBySession["s1"]).toBeNull();
	expect(s.retryBySession["s1"]).toBeUndefined();
});

test("auto_retry_end{success:true}：清重试进度但不动思考态（本轮继续，终态由 agent_end 复位）", () => {
	useSessionStore.setState({
		statusBySession: { s1: "thinking" },
		thinkingSinceBySession: { s1: 111 },
		retryBySession: { s1: { attempt: 1, maxAttempts: 3 } },
	});
	useSessionStore
		.getState()
		.handleSDKEvent(
			"s1",
			envelope({ type: "auto_retry_end", success: true, attempt: 1 }),
		);
	const s = useSessionStore.getState();
	expect(s.statusBySession["s1"]).toBe("thinking");
	expect(s.thinkingSinceBySession["s1"]).toBe(111);
	expect(s.retryBySession["s1"]).toBeUndefined();
});

test("重试全流程：agent_end{willRetry:true} → auto_retry_start → agent_end{willRetry:false} 才回 idle", () => {
	// 模拟 transient 错误后的完整重试序列：思考态贯穿退避期，直到真正终态
	useSessionStore.setState({
		statusBySession: { s1: "thinking" },
		thinkingSinceBySession: { s1: 222 },
	});
	useSessionStore
		.getState()
		.handleSDKEvent(
			"s1",
			envelope({ type: "agent_end", messages: [], willRetry: true }),
		);
	expect(useSessionStore.getState().statusBySession["s1"]).toBe("thinking");
	useSessionStore.getState().handleSDKEvent(
		"s1",
		envelope({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 1000,
			errorMessage: "Connection error.",
		}),
	);
	expect(useSessionStore.getState().statusBySession["s1"]).toBe("thinking");
	expect(useSessionStore.getState().retryBySession["s1"]).toEqual({
		attempt: 1,
		maxAttempts: 3,
	});
	useSessionStore
		.getState()
		.handleSDKEvent(
			"s1",
			envelope({ type: "agent_end", messages: [], willRetry: false }),
		);
	const s = useSessionStore.getState();
	expect(s.statusBySession["s1"]).toBe("idle");
	expect(s.thinkingSinceBySession["s1"]).toBeNull();
	// 终态 agent_end 防御性清重试进度（无 auto_retry_end 的异常时序也不卡黄条）
	expect(s.retryBySession["s1"]).toBeUndefined();
});

// ── agent_settled：会话级运行完全终结，思考态兜底复位 ──

test("agent_settled：thinking 时兜底复位 idle（agent_end 缺失的异常路径）", () => {
	useSessionStore.setState({
		statusBySession: { s1: "thinking" },
		thinkingSinceBySession: { s1: 333 },
	});
	useSessionStore
		.getState()
		.handleSDKEvent("s1", envelope({ type: "agent_settled" }));
	const s = useSessionStore.getState();
	expect(s.statusBySession["s1"]).toBe("idle");
	expect(s.thinkingSinceBySession["s1"]).toBeNull();
});

test("agent_settled：已空闲则不产生状态变更（避免无效渲染）", () => {
	useSessionStore.setState({
		statusBySession: { s1: "idle" },
		streamingBySession: { s1: null },
	});
	const before = useSessionStore.getState();
	useSessionStore
		.getState()
		.handleSDKEvent("s1", envelope({ type: "agent_settled" }));
	const after = useSessionStore.getState();
	expect(after.statusBySession).toBe(before.statusBySession);
	expect(after.streamingBySession).toBe(before.streamingBySession);
});

// ── turn_start / turn_end：显式忽略（消息流已由 message_* 驱动）──

test("turn_start / turn_end：不改变消息与状态（显式忽略）", () => {
	useSessionStore.setState({
		statusBySession: { s1: "thinking" },
		thinkingSinceBySession: { s1: 444 },
	});
	useSessionStore
		.getState()
		.handleSDKEvent("s1", envelope({ type: "turn_start" }));
	useSessionStore.getState().handleSDKEvent(
		"s1",
		envelope({
			type: "turn_end",
			message: { role: "assistant", content: [] } as any,
			toolResults: [],
		}),
	);
	const s = useSessionStore.getState();
	expect(s.statusBySession["s1"]).toBe("thinking");
	expect(s.thinkingSinceBySession["s1"]).toBe(444);
	expect(s.messagesBySession["s1"]).toBeUndefined();
});

// ── summarization_retry_*：压缩/分支摘要重试，复用重试状态条 ──

test("summarization_retry_scheduled：记录重试进度（驱动黄色状态条）", () => {
	useSessionStore.getState().handleSDKEvent(
		"s1",
		envelope({
			type: "summarization_retry_scheduled",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 2000,
			errorMessage: "terminated",
		}),
	);
	expect(useSessionStore.getState().retryBySession["s1"]).toEqual({
		attempt: 1,
		maxAttempts: 3,
	});
});

test("summarization_retry_attempt_start：不动重试状态（保持到 finished）", () => {
	useSessionStore.setState({
		retryBySession: { s1: { attempt: 1, maxAttempts: 3 } },
	});
	useSessionStore.getState().handleSDKEvent(
		"s1",
		envelope({
			type: "summarization_retry_attempt_start",
			source: "compaction",
			reason: "threshold",
		}),
	);
	expect(useSessionStore.getState().retryBySession["s1"]).toEqual({
		attempt: 1,
		maxAttempts: 3,
	});
});

test("summarization_retry_finished：清除重试进度；无重试时不产生状态变更", () => {
	useSessionStore.setState({
		retryBySession: { s1: { attempt: 2, maxAttempts: 3 } },
	});
	useSessionStore
		.getState()
		.handleSDKEvent("s1", envelope({ type: "summarization_retry_finished" }));
	expect(useSessionStore.getState().retryBySession["s1"]).toBeUndefined();

	// 已无重试状态：不再 set（避免无效渲染）
	const before = useSessionStore.getState();
	useSessionStore
		.getState()
		.handleSDKEvent("s1", envelope({ type: "summarization_retry_finished" }));
	expect(useSessionStore.getState().retryBySession).toBe(before.retryBySession);
});

// ── extension_error / setStatus / setWidget / setTitle ──

test("extension_error：写入诊断列表 + error toast", async () => {
	const { useDiagnosticsStore } = await import("../src/store/diagnostics");
	const { useToastStore } = await import("../src/store/toast");
	useDiagnosticsStore.setState({ entries: [] });
	useToastStore.setState({ toasts: [] });
	useSessionStore.getState().handleSDKEvent(
		"s1",
		envelope({
			type: "extension_error",
			extensionPath: "/Users/x/.wa-pi/extensions/pi-lens.ts",
			event: "tool_call",
			error: "ENOENT: no such file",
		}),
	);
	const entries = useDiagnosticsStore.getState().entries;
	expect(entries).toHaveLength(1);
	expect(entries[0].extension).toBe("pi-lens"); // basename 去扩展名
	expect(entries[0].event).toBe("tool_call");
	const toasts = useToastStore.getState().toasts;
	expect(toasts).toHaveLength(1);
	expect(toasts[0].type).toBe("error");
	expect(toasts[0].message).toContain("pi-lens");
	expect(toasts[0].message).toContain("ENOENT");
});

test("extension_status：按 key 维护状态条目，空文案清除", () => {
	useSessionStore.getState().handleSDKEvent(
		"s1",
		envelope({
			type: "extension_status",
			statusKey: "pi-lens",
			statusText: "分析中 (3/5)",
		}),
	);
	expect(useSessionStore.getState().extStatusBySession["s1"]).toEqual({
		"pi-lens": "分析中 (3/5)",
	});
	// 空 statusText = 清除该 key
	useSessionStore
		.getState()
		.handleSDKEvent(
			"s1",
			envelope({ type: "extension_status", statusKey: "pi-lens" }),
		);
	expect(useSessionStore.getState().extStatusBySession["s1"]).toEqual({});
});

test("extension_widget：按 key 维护文本块（默认 aboveEditor），空 lines 清除", () => {
	useSessionStore.getState().handleSDKEvent(
		"s1",
		envelope({
			type: "extension_widget",
			widgetKey: "pi-goal",
			widgetLines: ["── 目标 ──", "进度 4/6"],
		}),
	);
	expect(useSessionStore.getState().extWidgetBySession["s1"]).toEqual({
		"pi-goal": {
			lines: ["── 目标 ──", "进度 4/6"],
			placement: "aboveEditor",
		},
	});
	useSessionStore
		.getState()
		.handleSDKEvent(
			"s1",
			envelope({ type: "extension_widget", widgetKey: "pi-goal" }),
		);
	expect(useSessionStore.getState().extWidgetBySession["s1"]).toEqual({});
});

test("extension_title：记录会话级标题", () => {
	useSessionStore
		.getState()
		.handleSDKEvent(
			"s1",
			envelope({ type: "extension_title", title: "pi-lens 分析中" }),
		);
	expect(useSessionStore.getState().extTitleBySession["s1"]).toBe(
		"pi-lens 分析中",
	);
});

test("agent_end 清掉 optimisticSend 的 pending 占位（扩展命令无 agent turn 场景）", () => {
	// 模拟发送 /mcp-auth 这类扩展命令：乐观占位后没有任何 agent 事件，
	// kernel 合成的 agent_end 必须把 thinking + loading 气泡一起复位
	useSessionStore.getState().optimisticSend("s1", "/mcp-auth", "dev");
	expect(useSessionStore.getState().statusBySession["s1"]).toBe("thinking");
	expect(
		(useSessionStore.getState().streamingBySession["s1"]?.message as any)
			?.stopReason,
	).toBe("pending");

	useSessionStore
		.getState()
		.handleSDKEvent(
			"s1",
			envelope({ type: "agent_end", messages: [], willRetry: false }),
		);

	const s = useSessionStore.getState();
	expect(s.statusBySession["s1"]).toBe("idle");
	expect(s.streamingBySession["s1"]).toBeNull();
	expect(s.thinkingSinceBySession["s1"]).toBeNull();
	expect(s.optimisticEchoBySession["s1"]).toBe(false);
});

test("agent_end 不清除真实 partial（非 pending 的 streaming 保留）", () => {
	useSessionStore.setState({
		statusBySession: { s1: "thinking" },
		streamingBySession: {
			s1: {
				message: {
					role: "assistant",
					content: [{ type: "text", text: "半截回复" }],
					timestamp: 1,
				} as any,
				agentName: "dev",
			},
		},
	});
	useSessionStore
		.getState()
		.handleSDKEvent(
			"s1",
			envelope({ type: "agent_end", messages: [], willRetry: false }),
		);
	expect(useSessionStore.getState().streamingBySession["s1"]).not.toBeNull();
});

test("message_update 累积 text_delta（0.84：无 partial 快照，delta 追加到 content[contentIndex]）", async () => {
	// 先设初始 streaming（message_start 骨架，content 空数组）
	useSessionStore.setState({
		streamingBySession: {
			s1: {
				message: {
					role: "assistant",
					content: [],
					model: "m",
					stopReason: "stop",
					timestamp: 2,
				},
				agentName: "dev",
			},
		},
	});
	// 0.84 RPC 事件：只有 assistantMessageEvent.delta，无 partial/message 累积字段
	const env = envelope({
		type: "message_update",
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 0,
			delta: "部分",
		},
	});
	useSessionStore.getState().handleSDKEvent("s1", env);
	await flushFrames();
	const streaming = useSessionStore.getState().streamingBySession["s1"];
	expect(streaming).toBeTruthy();
	// delta 累积到 content[0] 的 text block
	expect((streaming!.message as any).content[0].text).toBe("部分");
});

test("message_update 多次 text_delta：文本按序累积（0.84 delta 增量）", async () => {
	const mk = (delta: string) =>
		envelope({
			type: "message_update",
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta,
			},
		});
	// 已有骨架：content[0] 是空 text block（message_start 骨架）
	useSessionStore.setState({
		streamingBySession: {
			s1: {
				message: {
					role: "assistant",
					content: [{ type: "text", text: "" }],
					model: "m",
					stopReason: "stop",
					timestamp: 2,
				},
				agentName: "dev",
			},
		},
	});
	useSessionStore.getState().handleSDKEvent("s1", mk("部"));
	useSessionStore.getState().handleSDKEvent("s1", mk("分"));
	useSessionStore.getState().handleSDKEvent("s1", mk("内"));
	await flushFrames();
	const streaming = useSessionStore.getState().streamingBySession["s1"];
	expect((streaming!.message as any).content[0].text).toBe("部分内");
});

test("message_end 丢弃挂起的 streaming 帧：旧 delta 不在定稿后复活", async () => {
	const updateEnv = envelope({
		type: "message_update",
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 0,
			delta: "部分",
		},
	});
	const endEnv = envelope({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "完整回复" }],
			model: "m",
			stopReason: "stop",
			timestamp: 2,
		},
	});
	// 先建 streaming 骨架，再 update + end
	useSessionStore.setState({
		streamingBySession: {
			s1: {
				message: {
					role: "assistant",
					content: [{ type: "text", text: "" }],
					model: "m",
					stopReason: "stop",
					timestamp: 2,
				},
				agentName: "dev",
			},
		},
	});
	useSessionStore.getState().handleSDKEvent("s1", updateEnv); // 累积 "部分"
	useSessionStore.getState().handleSDKEvent("s1", endEnv); // 定稿 + drop 挂起帧
	await new Promise((r) => requestAnimationFrame(r));
	// streaming 保持 null（不被旧 delta 复活），定稿消息已落库
	expect(useSessionStore.getState().streamingBySession["s1"]).toBeNull();
	const msgs = useSessionStore.getState().messagesBySession["s1"];
	expect((msgs[msgs.length - 1].message as any).content[0].text).toBe(
		"完整回复",
	);
});

test("handleSDKEvent 不影响其他 session 的状态", () => {
	// s2 已有消息，s1 处理事件不应波及 s2
	useSessionStore.setState({
		messagesBySession: {
			s2: [
				{
					agentName: "dev",
					message: { role: "user", content: "hi", timestamp: 1 },
				},
			],
		},
	});
	const env = envelope({ type: "agent_start" });
	useSessionStore.getState().handleSDKEvent("s1", env);
	expect(useSessionStore.getState().messagesBySession["s2"]).toHaveLength(1);
	expect(useSessionStore.getState().statusBySession["s1"]).toBe("thinking");
});

test("message_end 失败且 content 为空 → 不新增 assistant 行、仅清空 streaming", () => {
	// 先模拟 streaming 占位 + 一条 user 消息
	useSessionStore.setState({
		streamingBySession: {
			s1: {
				message: {
					role: "assistant",
					content: [],
					model: "m",
					stopReason: "stop",
					timestamp: 2,
				},
				agentName: "dev",
			},
		},
		messagesBySession: {
			s1: [
				{
					agentName: "dev",
					message: { role: "user", content: "hi", timestamp: 1 },
				},
			],
		},
	});
	const env = envelope({
		type: "message_end",
		message: {
			role: "assistant",
			content: [],
			model: "m",
			stopReason: "error",
			timestamp: 2,
		},
	});
	useSessionStore.getState().handleSDKEvent("s1", env);
	// streaming 清空
	expect(useSessionStore.getState().streamingBySession["s1"]).toBeNull();
	// 不新增 assistant 行（仍只有 1 条 user 消息）—— 避免渲染裸头像行
	expect(useSessionStore.getState().messagesBySession["s1"]).toHaveLength(1);
});

test("message_end 失败但有部分内容 → 照常合并（保留部分回复，红色渲染）", () => {
	useSessionStore.setState({
		streamingBySession: {
			s1: {
				message: {
					role: "assistant",
					content: [],
					model: "m",
					stopReason: "stop",
					timestamp: 2,
				},
				agentName: "dev",
			},
		},
		messagesBySession: {
			s1: [
				{
					agentName: "dev",
					message: { role: "user", content: "hi", timestamp: 1 },
				},
			],
		},
	});
	const env = envelope({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "部分回复" }],
			model: "m",
			stopReason: "error",
			timestamp: 2,
		},
	});
	useSessionStore.getState().handleSDKEvent("s1", env);
	expect(useSessionStore.getState().streamingBySession["s1"]).toBeNull();
	// 合并出一条 assistant 行（共 2 条）
	expect(useSessionStore.getState().messagesBySession["s1"]).toHaveLength(2);
});

test("truncate(sessionId, fromIndex) 保留 [0, fromIndex)，丢弃其后所有行（重发原地重试用）", () => {
	useSessionStore.setState({
		messagesBySession: {
			s1: [
				{
					agentName: undefined,
					message: { role: "user", content: "失败的那条", timestamp: 1 },
				},
				{
					agentName: "dev",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "⚠️ 失败" }],
						model: "system",
						stopReason: "error",
						timestamp: 2,
					},
				},
			],
		},
	});
	useSessionStore.getState().truncate("s1", 0); // 从失败用户行(index 0)起裁
	expect(useSessionStore.getState().messagesBySession["s1"]).toHaveLength(0);
});

test("truncate 仅裁掉指定索引及之后，保留前序消息", () => {
	useSessionStore.setState({
		messagesBySession: {
			s1: [
				{
					agentName: undefined,
					message: { role: "user", content: "早", timestamp: 1 },
				},
				{
					agentName: "dev",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "好" }],
						model: "m",
						stopReason: "stop",
						timestamp: 2,
					},
				},
				{
					agentName: undefined,
					message: { role: "user", content: "失败的那条", timestamp: 3 },
				},
				{
					agentName: "dev",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "⚠️" }],
						model: "system",
						stopReason: "error",
						timestamp: 4,
					},
				},
			],
		},
	});
	useSessionStore.getState().truncate("s1", 2); // 裁掉 index 2（失败用户行）及之后
	const msgs = useSessionStore.getState().messagesBySession["s1"];
	expect(msgs).toHaveLength(2);
	expect((msgs[1].message as any).content[0].text).toBe("好");
});

// ── 乐观发送（optimistic UI）──

test("optimisticSend 立即追加用户消息 + 占位 assistant streaming + status=thinking", () => {
	useSessionStore.getState().optimisticSend("s1", "你好", "dev");
	const s = useSessionStore.getState();
	expect(s.messagesBySession["s1"]).toHaveLength(1);
	expect((s.messagesBySession["s1"][0].message as any).role).toBe("user");
	expect((s.messagesBySession["s1"][0].message as any).content).toBe("你好");
	// 占位流式 assistant（让 MessageList 渲染 loading 气泡）
	expect(s.streamingBySession["s1"]).toBeTruthy();
	expect((s.streamingBySession["s1"]!.message as any).role).toBe("assistant");
	// 顶部 spinner 立即可见
	expect(s.statusBySession["s1"]).toBe("thinking");
	// 标记：等待 SDK message_start(user) 回声替换占位
	expect(s.optimisticEchoBySession["s1"]).toBe(true);
});

test("optimisticSend /compact 不插入用户消息（kernel 转 compact RPC，无 user 回声）", () => {
	useSessionStore
		.getState()
		.optimisticSend("s1", "/compact 只保留关键决策", "dev");
	const s = useSessionStore.getState();
	// 聊天列表不出现 /compact 用户消息
	expect(s.messagesBySession["s1"] ?? []).toHaveLength(0);
	// 思考态与占位 streaming 照常设置（压缩进行中由 compaction_start 状态消息呈现）
	expect(s.statusBySession["s1"]).toBe("thinking");
	expect(s.streamingBySession["s1"]).toBeTruthy();
});

test("message_start(user) 回声 → 替换乐观占位（不重复行），用 SDK 权威 timestamp，清标记", () => {
	useSessionStore.getState().optimisticSend("s1", "你好", "dev");
	const env = envelope({
		type: "message_start",
		message: { role: "user", content: "你好", timestamp: 999 },
	});
	useSessionStore.getState().handleSDKEvent("s1", env);
	const s = useSessionStore.getState();
	expect(s.messagesBySession["s1"]).toHaveLength(1); // 不重复
	expect((s.messagesBySession["s1"][0].message as any).timestamp).toBe(999); // SDK 权威 ts
	expect(s.optimisticEchoBySession["s1"]).toBe(false);
});

test("message_start(user) 无乐观占位 → 照常追加（不误替换历史用户消息）", () => {
	// 先有一条 assistant 历史，再收到 user message_start（非乐观路径）
	useSessionStore.setState({
		messagesBySession: {
			s1: [
				{
					agentName: "dev",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "历史" }],
						model: "m",
						stopReason: "stop",
						timestamp: 1,
					},
				},
			],
		},
	});
	const env = envelope({
		type: "message_start",
		message: { role: "user", content: "新问题", timestamp: 2 },
	});
	useSessionStore.getState().handleSDKEvent("s1", env);
	const msgs = useSessionStore.getState().messagesBySession["s1"];
	expect(msgs).toHaveLength(2); // 追加，不替换
	expect((msgs[1].message as any).content).toBe("新问题");
});

// ── 用户消息重复 bug 复现：去重依赖「flag 仍在 + 列表末尾是 user」，两种时序都会击穿 ──

test("复现：兜底 agent_end 先于 SDK 回声到达（清标记）→ 回声应替换占位而非追加重复行", () => {
	useSessionStore.getState().optimisticSend("s1", "你好", "dev");
	// kernel 50ms 兜底（扩展命令场景设计）在正常 prompt 事件延迟 >50ms 时合成 agent_end，
	// agent_end 处理器会清 optimisticEcho 标记
	useSessionStore
		.getState()
		.handleSDKEvent(
			"s1",
			envelope({ type: "agent_end", messages: [], willRetry: false }),
		);
	// 随后 SDK 权威 user 回声才到达：仍应替换乐观占位
	useSessionStore.getState().handleSDKEvent(
		"s1",
		envelope({
			type: "message_start",
			message: { role: "user", content: "你好", timestamp: 999 },
		}),
	);
	const s = useSessionStore.getState();
	const userMsgs = s.messagesBySession["s1"].filter(
		(m) => (m.message as any).role === "user",
	);
	expect(userMsgs).toHaveLength(1); // 不重复
	expect((userMsgs[0].message as any).timestamp).toBe(999); // 已替换为 SDK 权威版本
});

test("复现：乐观占位与 SDK 回声之间插入 extension_notify → 回声应替换占位而非追加重复行", () => {
	useSessionStore.getState().optimisticSend("s1", "你好", "dev");
	// 冷启动窗口内扩展 ctx.ui.notify 插入一条 custom 消息（列表末尾不再是 user）
	useSessionStore
		.getState()
		.handleSDKEvent(
			"s1",
			envelope({ type: "extension_notify", message: "扩展已加载" } as any),
		);
	useSessionStore.getState().handleSDKEvent(
		"s1",
		envelope({
			type: "message_start",
			message: { role: "user", content: "你好", timestamp: 999 },
		}),
	);
	const s = useSessionStore.getState();
	const userMsgs = s.messagesBySession["s1"].filter(
		(m) => (m.message as any).role === "user",
	);
	expect(userMsgs).toHaveLength(1); // 用户消息不重复
	expect((userMsgs[0].message as any).timestamp).toBe(999);
	// notify 消息保留在用户消息之后（原位替换，不动其他消息）
	expect(s.messagesBySession["s1"]).toHaveLength(2);
	expect((s.messagesBySession["s1"][1].message as any).type).toBe("custom");
});

test("复现：POST 超时 failTurn 清标记后 SDK 回声到达 → 应替换占位而非追加重复行", () => {
	useSessionStore.getState().optimisticSend("s1", "你好", "dev");
	// api-client 30s 超时 → Composer catch → failTurn（清标记，乐观消息保留）
	useSessionStore.getState().failTurn("s1");
	// kernel 侧实际继续执行成功，SDK 回声随后到达
	useSessionStore.getState().handleSDKEvent(
		"s1",
		envelope({
			type: "message_start",
			message: { role: "user", content: "你好", timestamp: 999 },
		}),
	);
	const s = useSessionStore.getState();
	const userMsgs = s.messagesBySession["s1"].filter(
		(m) => (m.message as any).role === "user",
	);
	expect(userMsgs).toHaveLength(1); // 不重复
	expect((userMsgs[0].message as any).timestamp).toBe(999);
});

// ── setActiveStatus 状态对齐（历史加载 / SSE 重连）──

test("setActiveStatus(isActive=false)：本地 thinking 残留时复位 idle + 清 streaming 占位 + 清重试条", () => {
	// 模拟 SSE 断线窗口漏掉终态事件（agent_end/auto_retry_end）后的残留：
	// kernel 已 idle，但本地还停在思考中、loading 气泡还在转、重试黄条还在
	useSessionStore.setState({
		statusBySession: { s1: "thinking" },
		thinkingSinceBySession: { s1: 123 },
		streamingBySession: {
			s1: {
				message: {
					role: "assistant",
					content: [],
					model: "pending",
					stopReason: "pending",
					timestamp: 123,
				} as any,
				agentName: "dev",
			},
		},
		retryBySession: { s1: { attempt: 1, maxAttempts: 3 } },
	});
	useSessionStore.getState().setActiveStatus("s1", false);
	const s = useSessionStore.getState();
	expect(s.statusBySession["s1"]).toBe("idle");
	expect(s.thinkingSinceBySession["s1"]).toBeNull();
	expect(s.streamingBySession["s1"]).toBeNull();
	expect(s.retryBySession["s1"]).toBeUndefined();
});

test("setActiveStatus(isActive=false)：本地本就 idle 时不产生状态变更（不新增 idle 键）", () => {
	useSessionStore.getState().setActiveStatus("s1", false);
	expect(useSessionStore.getState().statusBySession["s1"]).toBeUndefined();
});

test("setActiveStatus(isActive=undefined)：响应缺省不可信，不干预本地 thinking", () => {
	useSessionStore.setState({ statusBySession: { s1: "thinking" } });
	useSessionStore.getState().setActiveStatus("s1", undefined);
	expect(useSessionStore.getState().statusBySession["s1"]).toBe("thinking");
});

// ── failTurn：回合启动失败复位（agent 从未启动、不会有 agent_end）──

test("failTurn 复位 optimisticSend 造成的 thinking 卡死：status→idle、清 streaming 占位与计时", () => {
	useSessionStore.getState().optimisticSend("s1", "你好", "dev");
	expect(useSessionStore.getState().statusBySession["s1"]).toBe("thinking");

	useSessionStore.getState().failTurn("s1");
	const s = useSessionStore.getState();
	expect(s.statusBySession["s1"]).toBe("idle");
	expect(s.streamingBySession["s1"]).toBeNull();
	expect(s.thinkingSinceBySession["s1"]).toBeNull();
	expect(s.optimisticEchoBySession["s1"]).toBe(false);
	// 已定稿消息不受影响（用户消息保留）
	expect(s.messagesBySession["s1"]).toHaveLength(1);
});

test("failTurn 只影响目标会话，不串扰其它会话的 thinking 状态", () => {
	useSessionStore.getState().optimisticSend("s1", "你好", "dev");
	useSessionStore.getState().optimisticSend("s2", "在吗", "dev");

	useSessionStore.getState().failTurn("s1");
	const s = useSessionStore.getState();
	expect(s.statusBySession["s1"]).toBe("idle");
	expect(s.statusBySession["s2"]).toBe("thinking");
});

test("refreshSessionStats 用官方 stats 覆盖累计与上下文占用", async () => {
	mockStats = {
		stats: {
			tokens: {
				input: 50000,
				output: 8000,
				cacheRead: 200000,
				cacheWrite: 500,
				total: 258500,
				main: {
					input: 49700,
					output: 7870,
					cacheRead: 199000,
					cacheWrite: 500,
					total: 257070,
				},
				subagent: {
					input: 300,
					output: 130,
					cacheRead: 1000,
					cacheWrite: 0,
					total: 1430,
				},
			},
			contextUsage: { used: 64000, total: 128000, ratio: 0.5 },
		},
	};
	await useSessionStore.getState().refreshSessionStats("s1");
	const s = useSessionStore.getState();
	// 累计 = stats.tokens 全量（含压缩前历史 + 缓存）
	expect(s.tokenTotals["s1"]).toEqual({
		input: 50000,
		output: 8000,
		cacheRead: 200000,
		cacheWrite: 500,
		total: 258500,
		main: 257070,
		subagent: 1430,
	});
	// 当前上下文占用 = stats.contextUsage
	expect(s.contextUsageBySession["s1"]).toEqual({
		used: 64000,
		total: 128000,
		ratio: 0.5,
	});

	// 独立会话互不干扰
	expect(s.tokenTotals["s2"]).toBeUndefined();
	expect(s.contextUsageBySession["s2"]).toBeUndefined();
});

test("message_end(assistant 带 usage) 触发官方 stats 刷新，不做本地累加", async () => {
	mockStats = {
		stats: {
			tokens: {
				input: 1000,
				output: 500,
				cacheRead: 5000,
				cacheWrite: 0,
				total: 6500,
			},
			contextUsage: { used: 6000, total: 128000, ratio: 0.047 },
		},
	};
	useSessionStore.getState().handleSDKEvent(
		"s1",
		envelope({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "回复" }],
				model: "m",
				stopReason: "stop",
				timestamp: 1,
				usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
			},
		} as any),
	);
	// 宏任务级等待 refreshSessionStats 的异步链完成
	await new Promise((r) => setTimeout(r, 0));
	const s = useSessionStore.getState();
	// 累计直接取官方 stats（1000/5000），而非本地把本轮 100 加到旧值上
	expect(s.tokenTotals["s1"]?.input).toBe(1000);
	expect(s.tokenTotals["s1"]?.cacheRead).toBe(5000);
	expect(s.contextUsageBySession["s1"]?.used).toBe(6000);
	// lastUsage 仍是本轮真实 usage（「本轮」胶囊）
	expect(s.lastUsageBySession["s1"]).toEqual({
		input: 100,
		output: 50,
		cacheRead: 0,
		cacheWrite: 0,
	} as any);
});

test("seedTokenTotal 无 stats 时不写累计（本地消息扫描已移除），仅写 lastUsage", () => {
	const messages: any[] = [
		{ message: { role: "user" } },
		{
			message: {
				role: "assistant",
				usage: { input: 100, output: 50, cacheRead: 4000, cacheWrite: 0 },
			},
		},
		{
			message: {
				role: "assistant",
				usage: { input: 200, output: 30, cacheRead: 5000, cacheWrite: 100 },
			},
		},
	];
	useSessionStore.getState().seedTokenTotal("s2", messages);
	const s = useSessionStore.getState();
	// 不再遍历可见消息累加：无 stats 即无累计
	expect(s.tokenTotals["s2"]).toBeUndefined();
	// lastUsage 仍取最后一条真实 usage（供「本轮」胶囊）
	expect(s.lastUsageBySession["s2"]).toEqual({
		input: 200,
		output: 30,
		cacheRead: 5000,
		cacheWrite: 100,
	} as any);
});

test("seedTokenTotal 优先使用 stats 全量累计（含压缩前历史与缓存）", () => {
	const messages: any[] = [
		// 可见消息只有最近一轮（压缩后），usage 很小
		{
			message: {
				role: "assistant",
				usage: { input: 300, output: 100, cacheRead: 1000, cacheWrite: 0 },
			},
		},
	];
	// stats 来自 pi get_session_stats：全会话累计（含压缩前历史 + 缓存）
	const stats = {
		tokens: {
			input: 50000,
			output: 8000,
			cacheRead: 200000,
			cacheWrite: 500,
			total: 258500,
		},
	};
	useSessionStore.getState().seedTokenTotal("s5", messages, stats as any);
	const s = useSessionStore.getState();
	expect(s.tokenTotals["s5"]).toEqual({
		input: 50000,
		output: 8000,
		cacheRead: 200000,
		cacheWrite: 500,
		total: 258500,
	});
	// lastUsage 仍取可见消息中最后一条真实 usage（供「本轮」胶囊）
	expect(s.lastUsageBySession["s5"]).toEqual({
		input: 300,
		output: 100,
		cacheRead: 1000,
		cacheWrite: 0,
	} as any);
});

test("seedTokenTotal 无 usage 时不写入", () => {
	useSessionStore
		.getState()
		.seedTokenTotal("s3", [{ message: { role: "user" } }] as any[]);
	expect(useSessionStore.getState().tokenTotals["s3"]).toBeUndefined();
	expect(useSessionStore.getState().lastUsageBySession["s3"]).toBeUndefined();
});

test("seedTokenTotal 同时写入 lastUsageBySession", () => {
	const messages: any[] = [
		{ message: { role: "assistant", usage: { input: 100, output: 50 } } },
		{ message: { role: "assistant", usage: { input: 200, output: 30 } } },
	];
	const stats = {
		tokens: { input: 300, output: 80, cacheRead: 0, cacheWrite: 0, total: 380 },
	};
	useSessionStore.getState().seedTokenTotal("s4", messages, stats as any);
	const s = useSessionStore.getState();
	expect(s.tokenTotals["s4"]).toEqual({
		input: 300,
		output: 80,
		cacheRead: 0,
		cacheWrite: 0,
		total: 380,
	});
	// lastUsage 应是最后一条带 usage 的消息
	expect(s.lastUsageBySession["s4"]).toEqual({ input: 200, output: 30 } as any);
});

// ── isActive 状态同步：后端返回 isActive → 前端 setActiveStatus ──

test("setActiveStatus true → 设置 statusBySession 为 thinking 且使用传入的 thinkingSince", () => {
	useSessionStore.getState().setActiveStatus("s1", true, 1720000000000);
	const s = useSessionStore.getState();
	expect(s.statusBySession["s1"]).toBe("thinking");
	expect(s.thinkingSinceBySession["s1"]).toBe(1720000000000);
});

test("setActiveStatus true 无 thinkingSince → 回退为当前时间", () => {
	const before = Date.now();
	useSessionStore.getState().setActiveStatus("s2", true);
	const s = useSessionStore.getState();
	expect(s.thinkingSinceBySession["s2"]).toBeGreaterThanOrEqual(before);
});

test("setActiveStatus false → 不改变 statusBySession", () => {
	useSessionStore.getState().setActiveStatus("s2", false);
	expect(useSessionStore.getState().statusBySession["s2"]).toBeUndefined();
});

// ── 历史恢复：stopReason 不再影响状态（由 isActive 决定）──

test("setMessages 不再根据 stopReason 自动设置状态", () => {
	// 空 stopReason → 旧逻辑会置 thinking，新逻辑不干预
	const incomplete: any[] = [
		{
			agentName: "dev",
			message: { role: "user", content: "hi", timestamp: 1 },
		},
		{
			agentName: "dev",
			message: {
				role: "assistant",
				content: [{ type: "text" as const, text: "..." }],
				model: "m",
				stopReason: "",
				timestamp: 2,
			},
		},
	];
	useSessionStore.getState().setMessages("s3", incomplete);
	// 不自动设为 thinking，需由调用方根据 isActive 调用 setActiveStatus
	expect(useSessionStore.getState().statusBySession["s3"]).toBeUndefined();
});

// ── Provider 连接状态（net:status）──
// transient 网络错误（Connection error/timeout）不进对话流，改设 degraded 驱动状态条。
// 正常回复（message_end stopReason:stop）到达时清除 degraded。

test("setNetStatus / clearNetStatus：按会话隔离地设置 degraded 标记", () => {
	useSessionStore.getState().setNetStatus("s1", "degraded");
	useSessionStore.getState().setNetStatus("s2", "degraded");
	expect(useSessionStore.getState().netStatusBySession["s1"]).toBe("degraded");
	expect(useSessionStore.getState().netStatusBySession["s2"]).toBe("degraded");
	// 仅清 s1
	useSessionStore.getState().clearNetStatus("s1");
	expect(useSessionStore.getState().netStatusBySession["s1"]).toBeUndefined();
	expect(useSessionStore.getState().netStatusBySession["s2"]).toBe("degraded");
});

test("setNetStatus(null) 等价于 clearNetStatus", () => {
	useSessionStore.getState().setNetStatus("s1", "degraded");
	useSessionStore.getState().setNetStatus("s1", null);
	expect(useSessionStore.getState().netStatusBySession["s1"]).toBeUndefined();
});

test("正常 message_end(stop) 清除该会话的 degraded 标记（网络已恢复）", () => {
	// 先设置 degraded + streaming 占位
	useSessionStore.setState({
		netStatusBySession: { s1: "degraded" },
		streamingBySession: {
			s1: {
				message: {
					role: "assistant",
					content: [],
					model: "m",
					stopReason: "stop",
					timestamp: 2,
				},
				agentName: "dev",
			},
		},
	});
	const env = envelope({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "回复" }],
			model: "m",
			stopReason: "stop",
			timestamp: 2,
		},
	});
	useSessionStore.getState().handleSDKEvent("s1", env);
	// 正常回复 → degraded 已清除
	expect(useSessionStore.getState().netStatusBySession["s1"]).toBeUndefined();
});

test("agent_start 立即清除 degraded 标记（流式开始即证明网络已恢复，不等 message_end）", () => {
	useSessionStore.setState({
		netStatusBySession: { s1: "degraded" },
	});
	useSessionStore
		.getState()
		.handleSDKEvent("s1", envelope({ type: "agent_start" }));
	// agent turn 开始 → 网络已通 → degraded 立即清除
	expect(useSessionStore.getState().netStatusBySession["s1"]).toBeUndefined();
});

test("agent_start 只清除该会话 degraded，不影响其他会话", () => {
	useSessionStore.setState({
		netStatusBySession: { s1: "degraded", s2: "degraded" },
	});
	useSessionStore
		.getState()
		.handleSDKEvent("s1", envelope({ type: "agent_start" }));
	expect(useSessionStore.getState().netStatusBySession["s1"]).toBeUndefined();
	expect(useSessionStore.getState().netStatusBySession["s2"]).toBe("degraded");
});

test("error message_end 不清除 degraded（fatal 错误仍属异常态）", () => {
	useSessionStore.setState({
		netStatusBySession: { s1: "degraded" },
		streamingBySession: {
			s1: {
				message: {
					role: "assistant",
					content: [],
					model: "m",
					stopReason: "error",
					timestamp: 2,
				},
				agentName: "dev",
			},
		},
	});
	// 带 text 内容的 error message_end（fatal，如鉴权失败）会进 messages
	const env = envelope({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "401 Unauthorized" }],
			model: "m",
			stopReason: "error",
			timestamp: 2,
		},
	});
	useSessionStore.getState().handleSDKEvent("s1", env);
	// error → degraded 保留（仍处异常态，需用户处理）
	expect(useSessionStore.getState().netStatusBySession["s1"]).toBe("degraded");
});

test("agent_end 携带 elapsedMs 时写回最后一条 assistant 消息 turnElapsedMs", () => {
	useSessionStore.getState().setMessages("s1", [
		{
			message: {
				role: "user",
				content: [{ type: "text", text: "问题" }],
				timestamp: 1,
			},
			agentName: "dev",
		},
		{
			message: {
				role: "assistant",
				content: [{ type: "text", text: "回答" }],
				timestamp: 2,
				stopReason: "end_turn",
				model: "m",
			},
			agentName: "dev",
		},
	]);
	useSessionStore.getState().handleSDKEvent(
		"s1",
		envelope({
			type: "agent_end",
			messages: [],
			willRetry: false,
			elapsedMs: 4000,
		}),
	);
	const msgs = useSessionStore.getState().messagesBySession["s1"];
	const lastAsst = [...msgs]
		.reverse()
		.find((m) => (m.message as any).role === "assistant");
	expect((lastAsst?.message as any).turnElapsedMs).toBe(4000);
});

test("agent_end 无 elapsedMs 时不写回", () => {
	useSessionStore.getState().setMessages("s1", [
		{
			message: {
				role: "user",
				content: [{ type: "text", text: "问题" }],
				timestamp: 1,
			},
			agentName: "dev",
		},
		{
			message: {
				role: "assistant",
				content: [{ type: "text", text: "回答" }],
				timestamp: 2,
				stopReason: "end_turn",
				model: "m",
			},
			agentName: "dev",
		},
	]);
	useSessionStore.getState().handleSDKEvent(
		"s1",
		envelope({
			type: "agent_end",
			messages: [],
			willRetry: false,
		}),
	);
	const msgs = useSessionStore.getState().messagesBySession["s1"];
	const lastAsst = [...msgs]
		.reverse()
		.find((m) => (m.message as any).role === "assistant");
	expect((lastAsst?.message as any).turnElapsedMs).toBeUndefined();
});

test("setMessages 合并连续 assistant 时保留 turnElapsedMs", () => {
	useSessionStore.getState().setMessages("s1", [
		{
			message: {
				role: "user",
				content: [{ type: "text", text: "问题" }],
				timestamp: 1,
			},
			agentName: "dev",
		},
		{
			message: {
				role: "assistant",
				content: [{ type: "text", text: "思考" }],
				timestamp: 2,
				stopReason: "end_turn",
				model: "m",
			},
			agentName: "dev",
		},
		{
			message: {
				role: "assistant",
				content: [{ type: "text", text: "回答" }],
				timestamp: 3,
				stopReason: "end_turn",
				turnElapsedMs: 4000,
				model: "m",
			},
			agentName: "dev",
		},
	]);
	const asst = useSessionStore
		.getState()
		.messagesBySession["s1"].filter(
			(m) => (m.message as any).role === "assistant",
		);
	expect(asst).toHaveLength(1);
	expect((asst[0].message as any).turnElapsedMs).toBe(4000);
});

// ── compaction_start / compaction_end：压缩状态消息 + 权威 token 刷新 ──

test("compaction_start 插入「正在压缩上下文」状态消息；compaction_end 替换为结果并刷新 token", async () => {
	getCalls = 0;
	useSessionStore.setState({
		messagesBySession: {},
		tokenTotals: {
			s1: {
				input: 1000,
				output: 500,
				cacheRead: 0,
				cacheWrite: 0,
				total: 1500,
			},
		},
	});
	mockStats = {
		stats: {
			tokens: {
				input: 1000,
				output: 500,
				cacheRead: 5000,
				cacheWrite: 0,
				total: 6500,
			},
		},
	};
	// 服务端历史（压缩成功后 jsonl 含 compaction 节点 → 返回 compactionSummary 消息）
	mockMessages.messages = [
		{
			message: {
				role: "compactionSummary",
				summary: "摘要",
				tokensBefore: 1000,
				timestamp: 1,
			},
			agentName: undefined,
		},
		{
			message: {
				role: "assistant",
				content: "（压缩后摘要）",
				timestamp: 2,
				usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
			},
			agentName: "dev",
		},
	];

	// 压缩开始：插入状态消息
	useSessionStore
		.getState()
		.handleSDKEvent(
			"s1",
			envelope({ type: "compaction_start", reason: "manual" }),
		);
	const during = useSessionStore.getState().messagesBySession["s1"];
	const statusMsg = during.find(
		(m) => (m.message as any).customType === "compaction_status",
	);
	expect(statusMsg).toBeDefined();
	expect((statusMsg!.message as any).content).toBe("正在压缩上下文…");
	expect(getCalls).toBe(0); // 压缩中不刷新

	// 压缩结束：替换状态消息为结果，并刷新 token 累计
	useSessionStore.getState().handleSDKEvent(
		"s1",
		envelope({
			type: "compaction_end",
			reason: "manual",
			result: {
				summary: "摘要",
				firstKeptEntryId: "abc",
				tokensBefore: 1000,
				estimatedTokensAfter: 300,
			},
			aborted: false,
			willRetry: false,
		}),
	);
	// live 瞬间：状态消息替换为统一文案（与历史 compactionSummary 渲染一致）
	const liveMsg = useSessionStore
		.getState()
		.messagesBySession["s1"].find(
			(m) => (m.message as any).customType === "compaction_status",
		);
	expect((liveMsg!.message as any).content).toBe(
		"已压缩早期上下文 · 压缩前 1K token",
	);
	await new Promise((r) => setTimeout(r, 0));
	const after = useSessionStore.getState().messagesBySession["s1"];
	// 成功的本地状态消息被去重（服务端 compactionSummary 承担同一文案的展示）；
	// 进行中/取消/失败才保留本地
	const localSuccess = after.filter(
		(m) => (m.message as any).customType === "compaction_status",
	);
	expect(localSuccess).toHaveLength(0);
	// 服务端压缩节点消息存在（渲染文案与 live 一致：—— 已压缩早期上下文 · 压缩前 1K token ——）
	const summaryMsg = after.find(
		(m) => (m.message as any).role === "compactionSummary",
	);
	expect(summaryMsg).toBeDefined();
	// compaction_end 是权威信号：触发 refreshTokenTotals（不依赖 agent_end 文本检测）
	expect(getCalls).toBe(2);
	expect(useSessionStore.getState().tokenTotals["s1"]?.input).toBe(1000);
	expect(useSessionStore.getState().tokenTotals["s1"]?.cacheRead).toBe(5000);
	expect(useSessionStore.getState().lastUsageBySession["s1"]?.input).toBe(100);
});

test("compaction_end：aborted / errorMessage 不显示 token 结果，分别显示取消/失败文案", async () => {
	getCalls = 0;
	useSessionStore.setState({ messagesBySession: {}, tokenTotals: {} });
	mockMessages.messages = [];

	// 取消：result 为 null、aborted true
	useSessionStore.getState().handleSDKEvent(
		"s1",
		envelope({
			type: "compaction_end",
			reason: "manual",
			result: null,
			aborted: true,
			willRetry: false,
		}),
	);
	const cancelled = useSessionStore.getState().messagesBySession["s1"];
	const cancelledMsg = cancelled.find(
		(m) => (m.message as any).customType === "compaction_status",
	);
	expect((cancelledMsg!.message as any).content).toBe("压缩已取消");

	// 失败：errorMessage 存在
	useSessionStore.getState().handleSDKEvent(
		"s1",
		envelope({
			type: "compaction_end",
			reason: "manual",
			result: null,
			aborted: false,
			willRetry: false,
			errorMessage: "Nothing to compact (session too small)",
		}),
	);
	const failed = useSessionStore.getState().messagesBySession["s1"];
	const failedMsg = failed.find(
		(m) => (m.message as any).customType === "compaction_status",
	);
	expect((failedMsg!.message as any).content).toBe(
		"压缩失败：Nothing to compact (session too small)",
	);
});

test("compaction_end 自动压缩（reason=threshold）同样触发 token 刷新（不依赖 /compact 文本）", async () => {
	getCalls = 0;
	useSessionStore.setState({
		messagesBySession: {},
		tokenTotals: {
			s1: {
				input: 5000,
				output: 2000,
				cacheRead: 0,
				cacheWrite: 0,
				total: 7000,
			},
		},
	});
	mockStats = {
		stats: {
			tokens: {
				input: 5000,
				output: 2000,
				cacheRead: 20000,
				cacheWrite: 0,
				total: 27000,
			},
		},
	};
	mockMessages.messages = [
		{
			message: {
				role: "assistant",
				content: "（自动压缩摘要）",
				timestamp: 2,
				usage: { input: 800, output: 300, cacheRead: 0, cacheWrite: 0 },
			},
			agentName: "dev",
		},
	];

	// 无 compaction_start 直接到 compaction_end（自动压缩开始事件可能已错过）也能刷新
	useSessionStore.getState().handleSDKEvent(
		"s1",
		envelope({
			type: "compaction_end",
			reason: "threshold",
			result: {
				summary: "摘要",
				firstKeptEntryId: "abc",
				tokensBefore: 5000,
				estimatedTokensAfter: 1100,
			},
			aborted: false,
			willRetry: false,
		}),
	);
	await new Promise((r) => setTimeout(r, 0));

	expect(getCalls).toBe(2);
	expect(useSessionStore.getState().tokenTotals["s1"]?.input).toBe(5000);
	expect(useSessionStore.getState().tokenTotals["s1"]?.cacheRead).toBe(20000);
	expect(useSessionStore.getState().tokenTotals["s1"]?.total).toBe(27000);
});

// ── extension_dialog / extension_editor_text：pi 扩展 dialog 子协议事件分发 ──

test("extension_dialog：入队 useExtDialogStore，字段透传（ExtensionDialog 弹窗消费）", () => {
	useSessionStore.getState().handleSDKEvent(
		"s1",
		envelope({
			type: "extension_dialog",
			requestId: "req-1",
			method: "select",
			title: "选择方案",
			message: "请选一个",
			options: ["A", "B"],
			placeholder: "输入…",
			prefill: "预填",
		}),
	);
	const queue = useExtDialogStore.getState().queue;
	expect(queue).toHaveLength(1);
	expect(queue[0]).toEqual({
		requestId: "req-1",
		sessionId: "s1",
		method: "select",
		title: "选择方案",
		message: "请选一个",
		options: ["A", "B"],
		placeholder: "输入…",
		prefill: "预填",
	});
});

test("extension_editor_text：写入 editorTextInjection[sessionId]（Composer 消费替换输入框）", () => {
	useSessionStore
		.getState()
		.handleSDKEvent(
			"s1",
			envelope({ type: "extension_editor_text", text: "注入的文本" }),
		);
	const injection = useSessionStore.getState().editorTextInjection["s1"];
	expect(injection?.text).toBe("注入的文本");
	expect(typeof injection?.ts).toBe("number");
	// 不影响其他会话
	expect(useSessionStore.getState().editorTextInjection["s2"]).toBeUndefined();
});

test("extension_editor_text：text 非字符串时忽略（防御异常载荷）", () => {
	useSessionStore.getState().handleSDKEvent(
		"s1",
		envelope({
			type: "extension_editor_text",
			text: 123 as any,
		}),
	);
	expect(useSessionStore.getState().editorTextInjection["s1"]).toBeUndefined();
});

// ── echoUser：kernel session:echo_user 回声的幂等入口（修复 notify 穿插致 user 重复）──
// 旧实现 echo_user 只查 optimisticEcho 标志，但标志会被 message_start/agent_end/failTurn
// 提前清除；一旦 echo_user 在清除后到达（notify 穿插延长冷启动窗口、事件密集致时序非确定），
// 就会再次 optimisticSend 追加第二条 user。echoUser 在标志之外再加「同内容 user 已存在」查重。

test("echoUser：标志为 true 时跳过（正常时序，Composer 已乐观置入）", () => {
	useSessionStore.getState().optimisticSend("s1", "你好", "dev");
	useSessionStore.getState().echoUser("s1", "你好", "dev");
	const userMsgs = useSessionStore
		.getState()
		.messagesBySession["s1"].filter((m) => (m.message as any).role === "user");
	expect(userMsgs).toHaveLength(1);
});

test("echoUser：标志被 message_start 清除后到达，已存在同内容 user → 不重复追加", () => {
	useSessionStore.getState().optimisticSend("s1", "你好", "dev");
	// message_start(user) 先到：替换占位 + 清标志
	useSessionStore.getState().handleSDKEvent(
		"s1",
		envelope({
			type: "message_start",
			message: { role: "user", content: "你好", timestamp: 999 },
		}),
	);
	expect(useSessionStore.getState().optimisticEchoBySession["s1"]).toBe(false);
	// echo_user 后到：标志已 false，但同内容 user 已存在 → 不追加
	useSessionStore.getState().echoUser("s1", "你好", "dev");
	const userMsgs = useSessionStore
		.getState()
		.messagesBySession["s1"].filter((m) => (m.message as any).role === "user");
	expect(userMsgs).toHaveLength(1);
});

test("echoUser：notify 穿插在占位与 message_start 之间，echo 后到 → user 不重复", () => {
	useSessionStore.getState().optimisticSend("s1", "你好", "dev");
	// 冷启动窗口内插件 notify 插入 custom 消息
	useSessionStore
		.getState()
		.handleSDKEvent(
			"s1",
			envelope({ type: "extension_notify", message: "扩展已加载" } as any),
		);
	// message_start(user) 替换占位 + 清标志
	useSessionStore.getState().handleSDKEvent(
		"s1",
		envelope({
			type: "message_start",
			message: { role: "user", content: "你好", timestamp: 999 },
		}),
	);
	// echo_user 后到（notify 致时序错位）
	useSessionStore.getState().echoUser("s1", "你好", "dev");
	const userMsgs = useSessionStore
		.getState()
		.messagesBySession["s1"].filter((m) => (m.message as any).role === "user");
	expect(userMsgs).toHaveLength(1);
});

test("echoUser：标志被 agent_end 兜底清除后到达，已存在同内容 user → 不重复", () => {
	useSessionStore.getState().optimisticSend("s1", "你好", "dev");
	useSessionStore
		.getState()
		.handleSDKEvent(
			"s1",
			envelope({ type: "agent_end", messages: [], willRetry: false }),
		);
	useSessionStore.getState().echoUser("s1", "你好", "dev");
	const userMsgs = useSessionStore
		.getState()
		.messagesBySession["s1"].filter((m) => (m.message as any).role === "user");
	expect(userMsgs).toHaveLength(1);
});

test("echoUser：标志被 failTurn 清除后到达，已存在同内容 user → 不重复", () => {
	useSessionStore.getState().optimisticSend("s1", "你好", "dev");
	useSessionStore.getState().failTurn("s1");
	useSessionStore.getState().echoUser("s1", "你好", "dev");
	const userMsgs = useSessionStore
		.getState()
		.messagesBySession["s1"].filter((m) => (m.message as any).role === "user");
	expect(userMsgs).toHaveLength(1);
});

test("echoUser：无任何已有 user 消息时正常追加（NewSessionPane 等未乐观置入的场景）", () => {
	// 既无标志也无 user 消息：echo_user 是唯一来源，应正常追加
	useSessionStore.getState().echoUser("s1", "首次消息", "dev");
	const userMsgs = useSessionStore
		.getState()
		.messagesBySession["s1"].filter((m) => (m.message as any).role === "user");
	expect(userMsgs).toHaveLength(1);
	expect((userMsgs[0].message as any).content).toBe("首次消息");
});
