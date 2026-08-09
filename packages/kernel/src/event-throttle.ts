/**
 * sdk:event 出口节流器（阶段一·卡顿修复项 1）
 *
 * pi 每 token delta 发一个 message_update（0.84 起仅携带 delta 事件，无 partial 快照），
 * 若原样广播，序列化/传输/渲染总成本随输出长度增长。这里对同一 session 的 message_update
 * 做节流合并：窗口内最多发一帧（首帧立即发，后续合并为窗口末的最新帧），中间帧丢弃。
 * 协议不变、前端无感；非 update 事件到达前先冲刷 pending 帧以保证事件顺序。
 */
import type { SDKEventEnvelope } from "@wa-pi/shared";
import type { SubagentProgressEvent } from "@wa-pi/shared";

export interface SdkEventThrottleOptions {
	/** 节流窗口（毫秒），默认 50 */
	intervalMs?: number;
	/** 以下为可注入依赖，测试用假时钟保证确定性 */
	now?: () => number;
	schedule?: (fn: () => void, ms: number) => unknown;
	cancelSchedule?: (handle: unknown) => void;
}

interface SessionState {
	/** 本 session 最近一次实际发送的时间戳 */
	lastSentAt: number;
	/** 窗口内挂起的最新一帧（等待窗口末发送） */
	pending: SDKEventEnvelope | null;
	/** 窗口末冲刷定时器 */
	timer: unknown;
}

export class SdkEventThrottle {
	private readonly send: (e: SDKEventEnvelope) => void;
	private readonly intervalMs: number;
	private readonly now: () => number;
	private readonly schedule: (fn: () => void, ms: number) => unknown;
	private readonly cancelSchedule: (handle: unknown) => void;
	private readonly sessions = new Map<string, SessionState>();
	private disposed = false;

	constructor(
		send: (e: SDKEventEnvelope) => void,
		opts: SdkEventThrottleOptions = {},
	) {
		this.send = send;
		this.intervalMs = opts.intervalMs ?? 50;
		this.now = opts.now ?? Date.now;
		this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
		this.cancelSchedule =
			opts.cancelSchedule ?? ((h) => clearTimeout(h as any));
	}

	handle(envelope: SDKEventEnvelope): void {
		if (this.disposed) return;
		if (envelope.event.type === "message_update") {
			this.handleUpdate(envelope);
			return;
		}
		// 非 update 事件：先冲刷同 session 的 pending 帧，保持事件顺序，再透传
		this.flush(envelope.sessionId);
		this.send(envelope);
	}

	/** 停止服务时调用：丢弃所有 pending 帧并取消定时器 */
	dispose(): void {
		this.disposed = true;
		for (const [, st] of this.sessions) {
			if (st.timer != null) this.cancelSchedule(st.timer);
		}
		this.sessions.clear();
	}

	private handleUpdate(envelope: SDKEventEnvelope): void {
		const st = this.stateFor(envelope.sessionId);
		const elapsed = this.now() - st.lastSentAt;
		if (st.pending == null && st.timer == null && elapsed >= this.intervalMs) {
			// 窗口外：立即发送
			st.lastSentAt = this.now();
			this.send(envelope);
			return;
		}
		// 窗口内：挂起最新帧（覆盖旧 pending），并确保窗口末有冲刷定时器
		st.pending = envelope;
		if (st.timer == null) {
			const remaining = Math.max(this.intervalMs - elapsed, 0);
			st.timer = this.schedule(() => this.flush(envelope.sessionId), remaining);
		}
	}

	private flush(sessionId: string): void {
		const st = this.sessions.get(sessionId);
		if (!st) return;
		if (st.timer != null) {
			this.cancelSchedule(st.timer);
			st.timer = null;
		}
		if (st.pending != null) {
			const pending = st.pending;
			st.pending = null;
			st.lastSentAt = this.now();
			this.send(pending);
		}
	}

	private stateFor(sessionId: string): SessionState {
		let st = this.sessions.get(sessionId);
		if (!st) {
			st = { lastSentAt: -Infinity, pending: null, timer: null };
			this.sessions.set(sessionId, st);
		}
		return st;
	}
}

export interface SubagentProgressThrottleOptions {
	/** 节流窗口（毫秒），默认 50，与 message_update 一致 */
	intervalMs?: number;
	now?: () => number;
	schedule?: (fn: () => void, ms: number) => unknown;
	cancelSchedule?: (handle: unknown) => void;
}

interface ProgressKeyState {
	lastSentAt: number;
	pending: { sessionId: string; toolCallId: string; event: SubagentProgressEvent } | null;
	timer: unknown;
}

/**
 * subagent:progress 出口节流器（流式卡顿修复 3.2）
 *
 * delegate/fleet 子代理每个 text_delta 广播一帧 SSE，前端卡片每帧重渲染。
 * 与 SdkEventThrottle 同模式的窗口合并（首帧立即 + 窗口末最新帧），但：
 * - 节流键 = sessionId + toolCallId + (taskIndex ?? agent)：fleet 同一 toolCallId 下
 *   多个子代理并行，各自独立节流互不影响；
 * - 终态（status !== "running"）不延迟：先冲刷挂起帧保序，再立即透传。
 */
export class SubagentProgressThrottle {
	private readonly send: (sessionId: string, toolCallId: string, event: SubagentProgressEvent) => void;
	private readonly intervalMs: number;
	private readonly now: () => number;
	private readonly schedule: (fn: () => void, ms: number) => unknown;
	private readonly cancelSchedule: (handle: unknown) => void;
	private readonly states = new Map<string, ProgressKeyState>();
	private disposed = false;

	constructor(
		send: (sessionId: string, toolCallId: string, event: SubagentProgressEvent) => void,
		opts: SubagentProgressThrottleOptions = {},
	) {
		this.send = send;
		this.intervalMs = opts.intervalMs ?? 50;
		this.now = opts.now ?? Date.now;
		this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
		this.cancelSchedule =
			opts.cancelSchedule ?? ((h) => clearTimeout(h as any));
	}

	handle(sessionId: string, toolCallId: string, event: SubagentProgressEvent): void {
		if (this.disposed) return;
		const key = `${sessionId} ${toolCallId} ${event.taskIndex ?? event.agent}`;
		if (event.status !== "running") {
			// 终态：先冲刷挂起帧保序，再立即透传
			this.flush(key);
			this.send(sessionId, toolCallId, event);
			return;
		}
		const st = this.stateFor(key);
		const elapsed = this.now() - st.lastSentAt;
		if (st.pending == null && st.timer == null && elapsed >= this.intervalMs) {
			st.lastSentAt = this.now();
			this.send(sessionId, toolCallId, event);
			return;
		}
		st.pending = { sessionId, toolCallId, event };
		if (st.timer == null) {
			const remaining = Math.max(this.intervalMs - elapsed, 0);
			st.timer = this.schedule(() => this.flush(key), remaining);
		}
	}

	/** 停止服务时调用：丢弃所有挂起帧并取消定时器 */
	dispose(): void {
		this.disposed = true;
		for (const [, st] of this.states) {
			if (st.timer != null) this.cancelSchedule(st.timer);
		}
		this.states.clear();
	}

	private flush(key: string): void {
		const st = this.states.get(key);
		if (!st) return;
		if (st.timer != null) {
			this.cancelSchedule(st.timer);
			st.timer = null;
		}
		if (st.pending != null) {
			const { sessionId, toolCallId, event } = st.pending;
			st.pending = null;
			st.lastSentAt = this.now();
			this.send(sessionId, toolCallId, event);
		}
	}

	private stateFor(key: string): ProgressKeyState {
		let st = this.states.get(key);
		if (!st) {
			st = { lastSentAt: -Infinity, pending: null, timer: null };
			this.states.set(key, st);
		}
		return st;
	}
}
