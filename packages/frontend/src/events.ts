/**
 * SSE 事件总线客户端（阶段二·去 WS 化）
 *
 * 替代 WebSocket：一条 EventSource 长连接接收所有 kernel→前端推送，
 * 按 event 类型分发给注册监听器。断线自动重连，重连成功后触发快照刷新。
 */
import type { WSServerEvent } from "@wa-pi/shared";

export type ServerEventHandler = (event: WSServerEvent) => void;

type GlobalHandlers = Set<ServerEventHandler>;
type TypedHandlers = Map<string, Set<ServerEventHandler>>;

const SSE_URL = "/api/events";
const MAX_RECONNECT_MS = 30_000;
// 假活看门狗：kernel 每 5s 发心跳帧，任何帧（心跳/业务）都刷新 lastFrameAt。
// 超过 10s（错过 2 拍心跳）无任何帧 → TCP 假活（kernel 崩溃但连接未收到 RST，
// EventSource.onerror 不触发、永不重连的盲区），主动断线走既有重连+快照复位链路。
const HEARTBEAT_TIMEOUT_MS = 10_000;
const WATCHDOG_INTERVAL_MS = 2_000;

let source: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1_000;
let onReconnectCallback: (() => void) | null = null;
let lastFrameAt = Date.now();
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
/** 连接状态：connected | reconnecting | disconnected */
export type ConnectionState = "connected" | "reconnecting";
let connectionListeners: Array<(s: ConnectionState) => void> = [];
let currentState: ConnectionState = "connected";

function setConnectionState(s: ConnectionState): void {
  if (currentState === s) return;
  currentState = s;
  for (const l of connectionListeners) l(s);
}

const globalHandlers: GlobalHandlers = new Set();
const typedHandlers: TypedHandlers = new Map();

function dispatch(event: WSServerEvent): void {
  for (const h of globalHandlers) {
    try { h(event); } catch (e) { console.warn("[events] handler error:", e); }
  }
  const set = typedHandlers.get((event as any).type);
  if (set) {
    for (const h of set) {
      try { h(event); } catch (e) { console.warn("[events] typed handler error:", e); }
    }
  }
}

function connect(): void {
  if (typeof EventSource === "undefined") return;
  if (source?.readyState === EventSource.OPEN || source?.readyState === EventSource.CONNECTING) return;

  startWatchdog();
  source = new EventSource(SSE_URL);

  source.onopen = () => {
    reconnectDelay = 1_000;
    lastFrameAt = Date.now();
    setConnectionState("connected");
  };

  source.onmessage = (ev) => {
    lastFrameAt = Date.now();
    try {
      const data = JSON.parse(ev.data) as WSServerEvent;
      // 心跳帧只证明连接活着，不进业务分发
      if ((data as any)?.type === "heartbeat") return;
      dispatch(data);
    } catch (e) {
      console.warn("[events] parse failed:", e);
    }
  };

  source.onerror = () => {
    source?.close();
    source = null;
    setConnectionState("reconnecting");
    scheduleReconnect();
  };
}

/**
 * 看门狗单次检查（导出供测试注入时钟）。
 * 只对 OPEN 状态的连接判死：CONNECTING 期间 kernel 未就绪属正常，由 onerror 兜底。
 */
export function heartbeatWatchdogTick(now: number = Date.now()): void {
  if (!source || source.readyState !== EventSource.OPEN) return;
  if (now - lastFrameAt <= HEARTBEAT_TIMEOUT_MS) return;
  console.warn("[events] 超过 10s 未收到任何帧（kernel 心跳 5s），判定连接假活，主动断线重连");
  source.close();
  source = null;
  setConnectionState("reconnecting");
  scheduleReconnect();
}

function startWatchdog(): void {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => heartbeatWatchdogTick(), WATCHDOG_INTERVAL_MS);
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
    onReconnectCallback?.();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);
}

/** 建立 SSE 连接（幂等）。 */
export function connectEvents(): void {
  connect();
}

/** 注册全局监听器，返回注销函数。 */
export function onMessage(handler: ServerEventHandler): () => void {
  globalHandlers.add(handler);
  connectEvents();
  return () => globalHandlers.delete(handler);
}

/** 按事件类型注册监听器，返回注销函数。 */
export function onEventType(type: string, handler: ServerEventHandler): () => void {
  let set = typedHandlers.get(type);
  if (!set) {
    set = new Set();
    typedHandlers.set(type, set);
  }
  set.add(handler);
  connectEvents();
  return () => {
    set?.delete(handler);
    if (set?.size === 0) typedHandlers.delete(type);
  };
}

/** 设置重连成功后回调（用于前端刷新快照对齐状态）。 */
export function onReconnect(cb: () => void): () => void {
  onReconnectCallback = cb;
  return () => { if (onReconnectCallback === cb) onReconnectCallback = null; };
}

/** 主动断开并清理（测试用）。 */
export function disconnectEvents(): void {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  source?.close();
  source = null;
  lastFrameAt = Date.now();
  globalHandlers.clear();
  typedHandlers.clear();
  onReconnectCallback = null;
  reconnectDelay = 1_000;
  connectionListeners = [];
  currentState = "connected";
}

/** 测试用：手动注入一条服务端事件，触发所有已注册监听器。 */
export function emitEventForTesting(event: WSServerEvent): void {
  dispatch(event);
}

/** 订阅连接状态变化；返回取消订阅函数。 */
export function onConnectionChange(listener: (s: ConnectionState) => void): () => void {
  connectionListeners.push(listener);
  return () => { connectionListeners = connectionListeners.filter(l => l !== listener); };
}

/** 获取当前连接状态。 */
export function getConnectionState(): ConnectionState {
  return currentState;
}
