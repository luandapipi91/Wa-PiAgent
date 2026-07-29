/**
 * sdk:event 出口节流器（阶段一·卡顿修复项 1）
 *
 * pi 每 token delta 发一个 message_update（携带完整 partial message），若原样广播，
 * 序列化/传输/渲染总成本随输出长度平方增长。这里对同一 session 的 message_update
 * 做节流合并：窗口内最多发一帧（首帧立即发，后续合并为窗口末的最新帧），中间帧丢弃。
 * 协议不变、前端无感；非 update 事件到达前先冲刷 pending 帧以保证事件顺序。
 */
import type { SDKEventEnvelope } from "@wa-pi/shared";

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

  constructor(send: (e: SDKEventEnvelope) => void, opts: SdkEventThrottleOptions = {}) {
    this.send = send;
    this.intervalMs = opts.intervalMs ?? 50;
    this.now = opts.now ?? Date.now;
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancelSchedule = opts.cancelSchedule ?? ((h) => clearTimeout(h as any));
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
