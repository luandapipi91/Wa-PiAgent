/**
 * sdk:event 出口节流器（阶段一·卡顿修复项 1）
 *
 * 历史：pi 每 token delta 发一个 message_update，若原样广播，序列化/传输/渲染总成本
 * 随输出长度增长，曾对同一 session 的 message_update 做窗口合并（首帧立即、窗口末发最新帧）。
 *
 * 现状：0.84 起 RPC 序列化剥离 partial 快照，message_update 只携带 delta 增量
 * （无累积快照，见 shared/types.ts AssistantMessageEvent 注释）。节流丢帧 = 永久丢字：
 * 前端按到达顺序把 delta 累积到 content block，中间帧一旦丢弃，流式预览就跳字/乱序
 * （只有 message_end 权威消息定稿后才正确）。因此本类不再对 sdk:event 做任何合并/丢弃，
 * 原样透传保证每个 delta 帧到达前端；渲染合帧已由前端 streaming-batcher（rAF）承担。
 */
import type { SDKEventEnvelope } from "@wa-pi/shared";
import type { SubagentProgressEvent } from "@wa-pi/shared";

export interface SdkEventThrottleOptions {
	/** 节流窗口（毫秒），默认 50（已弃用：message_update 为 delta 增量不可丢帧） */
	intervalMs?: number;
	/** 以下为可注入依赖（已弃用：本类不再节流，仅保留签名兼容） */
	now?: () => number;
	schedule?: (fn: () => void, ms: number) => unknown;
	cancelSchedule?: (handle: unknown) => void;
}

export class SdkEventThrottle {
	private readonly send: (e: SDKEventEnvelope) => void;
	private disposed = false;

	constructor(
		send: (e: SDKEventEnvelope) => void,
		_opts: SdkEventThrottleOptions = {},
	) {
		this.send = send;
	}

	/**
	 * 原样透传（不节流）：0.84 delta 协议下 message_update 丢帧 = 永久丢字，
	 * 前端 streaming-batcher 已承担渲染合帧，kernel 侧无需再合并。
	 */
	handle(envelope: SDKEventEnvelope): void {
		if (this.disposed) return;
		this.send(envelope);
	}

	/** 停止服务时调用：此后不再透传 */
	dispose(): void {
		this.disposed = true;
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
	pending: {
		sessionId: string;
		toolCallId: string;
		event: SubagentProgressEvent;
	} | null;
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
	private readonly send: (
		sessionId: string,
		toolCallId: string,
		event: SubagentProgressEvent,
	) => void;
	private readonly intervalMs: number;
	private readonly now: () => number;
	private readonly schedule: (fn: () => void, ms: number) => unknown;
	private readonly cancelSchedule: (handle: unknown) => void;
	private readonly states = new Map<string, ProgressKeyState>();
	private disposed = false;

	constructor(
		send: (
			sessionId: string,
			toolCallId: string,
			event: SubagentProgressEvent,
		) => void,
		opts: SubagentProgressThrottleOptions = {},
	) {
		this.send = send;
		this.intervalMs = opts.intervalMs ?? 50;
		this.now = opts.now ?? Date.now;
		this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
		this.cancelSchedule =
			opts.cancelSchedule ?? ((h) => clearTimeout(h as any));
	}

	handle(
		sessionId: string,
		toolCallId: string,
		event: SubagentProgressEvent,
	): void {
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
