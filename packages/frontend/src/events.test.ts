// SSE 假活看门狗测试：kernel 崩溃但 TCP 未断（EventSource.onerror 不触发）时，
// 前端靠「10s 无任何帧」主动判死并重连，避免连接假活导致状态永久卡死。
import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  connectEvents,
  disconnectEvents,
  heartbeatWatchdogTick,
  getConnectionState,
  onMessage,
} from "./events";

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 0;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  // 测试驱动：模拟连接建立 / 收到一帧
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

const realES = (globalThis as any).EventSource;
let es: FakeEventSource;

beforeEach(() => {
  FakeEventSource.instances = [];
  (globalThis as any).EventSource = FakeEventSource;
  connectEvents();
  es = FakeEventSource.instances[0];
});

afterEach(() => {
  disconnectEvents();
  (globalThis as any).EventSource = realES;
});

test("OPEN 后超过 10s 无任何帧 → 判假活：close + 进入重连", () => {
  es.open();
  const t = Date.now();
  heartbeatWatchdogTick(t + 9_000); // 阈值内：不动
  expect(es.closed).toBe(false);
  expect(getConnectionState()).toBe("connected");
  heartbeatWatchdogTick(t + 10_001); // 超阈值：判死
  expect(es.closed).toBe(true);
  expect(getConnectionState()).toBe("reconnecting");
});

test("心跳帧刷新存活时间：10s 内有心跳则不断连", () => {
  es.open();
  const t = Date.now();
  es.emit({ type: "heartbeat", ts: t }); // 收到心跳（lastFrameAt = 真实 now ≈ t）
  heartbeatWatchdogTick(t + 9_000);
  expect(es.closed).toBe(false);
  expect(getConnectionState()).toBe("connected");
});

test("心跳帧不分发给业务监听器，业务帧正常分发", () => {
  const received: string[] = [];
  onMessage((e) => received.push((e as any).type));
  es.open();
  es.emit({ type: "heartbeat", ts: 1 });
  es.emit({ type: "agent_end", sessionId: "s-1" });
  expect(received).toEqual(["agent_end"]);
});

test("CONNECTING 期间不误判（kernel 未就绪由 onerror 兜底）", () => {
  heartbeatWatchdogTick(Date.now() + 60_000); // 未 open，远超阈值
  expect(es.closed).toBe(false);
});
