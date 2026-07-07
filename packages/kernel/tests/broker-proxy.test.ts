import { test, expect, mock, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore } from "../src/project-store";
import type { AskItem } from "@hiagent/shared";

// ---------------------------------------------------------------------------
// Mock IntercomClient — 必须 self-contained，因为 mock.module 的 factory
// 在 import 解析阶段执行，此时模块顶层变量尚未求值。
// ---------------------------------------------------------------------------

/** 所有通过 mock 构造的 IntercomClient 实例（供测试断言使用） */
const createdClients: any[] = [];

mock.module("pi-intercom/broker/client", () => {
  // 在 factory 内部 require，避免引用外部尚未求值的变量
  const { EventEmitter } = require("node:events") as typeof import("node:events");

  class MockIntercomClient {
    sessionId: string;
    private emitter = new EventEmitter();
    private _connected = false;

    constructor() {
      this.sessionId = "mock-sid-" + Math.random().toString(36).slice(2);
      createdClients.push(this);
    }

    connect = mock().mockImplementation(async () => {
      this._connected = true;
      return undefined;
    });

    disconnect = mock().mockImplementation(async () => {
      this._connected = false;
      return undefined;
    });

    send = mock().mockImplementation(async (_to: string, _msg: any) => {
      return { id: "m-" + Math.random().toString(36).slice(2), delivered: true };
    });

    isConnected(): boolean {
      return this._connected;
    }

    on(event: string, cb: (...args: any[]) => void): void {
      this.emitter.on(event, cb);
    }

    // ---- 测试辅助方法 ----

    /** 模拟 broker 向该 client 推送消息 */
    _emitMessage(from: any, message: any): void {
      this.emitter.emit("message", from, message);
    }
  }

  return { IntercomClient: MockIntercomClient };
});

// 必须在 mock.module 之后 import BrokerProxyManager，
// 否则它内部的 `import { IntercomClient } from "pi-intercom/broker/client"` 会拿到原始模块
import { BrokerProxyManager } from "../src/broker-proxy";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempProjectFile() {
  return join(import.meta.dir, ".tmp-bp-" + Math.random().toString(36).slice(2) + ".json");
}

afterEach(() => {
  createdClients.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("start 创建 relay client 并为所有 project×agent 注册代理", async () => {
  const f = tempProjectFile();
  const ps = new ProjectStore(f);
  const p = await ps.createProject({ name: "P", cwd: "/p" });

  const onAsk = mock();
  const onReply = mock();
  const ensureStarted = mock().mockResolvedValue(undefined);

  const bp = new BrokerProxyManager({
    projectStore: ps,
    agentManager: { ensureStarted } as any,
    onAsk,
    onReply,
  });

  await bp.start();

  // 验证 relay client + 4 个 agent proxy client 被创建
  // ALL_AGENT_NAMES = ["product","pm","dev","test"] → 4 proxy clients + 1 relay = 5
  expect(createdClients.length).toBe(5);

  // 所有 client 都应调用了 connect
  for (const c of createdClients) {
    expect(c.connect).toHaveBeenCalled();
  }

  await bp.dispose();
  rmSync(f, { force: true });
});

test("start 幂等——重复调用不创建额外 client", async () => {
  const f = tempProjectFile();
  const ps = new ProjectStore(f);
  await ps.createProject({ name: "P", cwd: "/p" });

  const bp = new BrokerProxyManager({
    projectStore: ps,
    agentManager: { ensureStarted: mock().mockResolvedValue(undefined) } as any,
    onAsk: mock(),
    onReply: mock(),
  });

  await bp.start();
  const countAfterFirst = createdClients.length;
  await bp.start();
  expect(createdClients.length).toBe(countAfterFirst);

  await bp.dispose();
  rmSync(f, { force: true });
});

test("start 为多个 project 分别注册代理", async () => {
  const f = tempProjectFile();
  const ps = new ProjectStore(f);
  await ps.createProject({ name: "A", cwd: "/a" });
  await ps.createProject({ name: "B", cwd: "/b" });

  const bp = new BrokerProxyManager({
    projectStore: ps,
    agentManager: { ensureStarted: mock().mockResolvedValue(undefined) } as any,
    onAsk: mock(),
    onReply: mock(),
  });

  await bp.start();

  // 2 projects × 4 agents = 8 proxy clients + 1 relay = 9
  expect(createdClients.length).toBe(9);

  await bp.dispose();
  rmSync(f, { force: true });
});

test("registerProxy 注册单个代理并监听消息", async () => {
  const f = tempProjectFile();
  const ps = new ProjectStore(f);
  const p = await ps.createProject({ name: "P", cwd: "/p" });

  // 不调 start()，直接测 registerProxy
  const bp = new BrokerProxyManager({
    projectStore: ps,
    agentManager: { ensureStarted: mock().mockResolvedValue(undefined) } as any,
    onAsk: mock(),
    onReply: mock(),
  });

  await (bp as any).registerProxy(p.id, "dev");

  // 应创建一个 client
  expect(createdClients.length).toBe(1);
  const client = createdClients[0];
  expect(client.connect).toHaveBeenCalled();
  // sessionId 格式为 "{projectId}-{agentName}"
  expect(client.sessionId).toContain("mock-sid-");

  // connect 参数中包含 name = "{projectId}-{agentName}"
  const connectCallArg = client.connect.mock.calls[0]?.[0];
  expect(connectCallArg.name).toBe(`${p.id}-dev`);

  await bp.dispose();
  rmSync(f, { force: true });
});

test("registerProxy 重复注册同一 key 不创建新 client", async () => {
  const f = tempProjectFile();
  const ps = new ProjectStore(f);
  const p = await ps.createProject({ name: "P", cwd: "/p" });

  const bp = new BrokerProxyManager({
    projectStore: ps,
    agentManager: { ensureStarted: mock().mockResolvedValue(undefined) } as any,
    onAsk: mock(),
    onReply: mock(),
  });

  await (bp as any).registerProxy(p.id, "dev");
  const count = createdClients.length;
  await (bp as any).registerProxy(p.id, "dev");
  expect(createdClients.length).toBe(count);

  await bp.dispose();
  rmSync(f, { force: true });
});

test("handleProxyMessage 缓存消息、通知 onAsk、启动 agent", async () => {
  const f = tempProjectFile();
  const ps = new ProjectStore(f);
  const p = await ps.createProject({ name: "P", cwd: "/p" });

  const ensureStarted = mock().mockResolvedValue(undefined);
  const onAsk = mock();
  const onReply = mock();

  const bp = new BrokerProxyManager({
    projectStore: ps,
    agentManager: { ensureStarted } as any,
    onAsk,
    onReply,
  });

  // 构造一个 proxy entry（绕过 start 以避免 relay client 干扰）
  const key = `${p.id}-pm`;
  const entry = {
    client: createdClients[0] ?? null,
    projectId: p.id,
    agentName: "pm" as const,
  };

  const from = { id: "sender-sid-001", name: "sender" };
  const message = {
    id: "msg-1",
    content: { text: "hello from sender" },
    expectsReply: true,
  };

  await (bp as any).handleProxyMessage(key, entry, from, message);

  // 验证 ensureStarted 被调用
  expect(ensureStarted).toHaveBeenCalledWith(p.id, "pm");

  // 验证 onAsk 被调用
  expect(onAsk).toHaveBeenCalled();
  const askArg: AskItem = onAsk.mock.calls[0]?.[0];
  expect(askArg.messageId).toBe("msg-1");
  expect(askArg.text).toBe("hello from sender");
  expect(askArg.to).toBe("pm");

  // 验证消息已缓存到 pending
  const pending = (bp as any).pending;
  expect(pending.has(key)).toBe(true);

  await bp.dispose();
  rmSync(f, { force: true });
});

test("代理收到消息后通过 relay 转发到真实 agent", async () => {
  const f = tempProjectFile();
  const ps = new ProjectStore(f);
  const p = await ps.createProject({ name: "P", cwd: "/p" });

  const ensureStarted = mock().mockResolvedValue(undefined);
  const onAsk = mock();
  const onReply = mock();

  const bp = new BrokerProxyManager({
    projectStore: ps,
    agentManager: { ensureStarted } as any,
    onAsk,
    onReply,
  });

  // 构造一个真实的 mock relay client（不从 createdClients 取，避免 afterEach 清空）
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  const emitter = new EventEmitter();
  const relayClient = {
    sessionId: "relay-sid",
    connect: mock().mockResolvedValue(undefined),
    disconnect: mock().mockResolvedValue(undefined),
    send: mock().mockResolvedValue({ id: "forwarded-1", delivered: true }),
    isConnected: mock().mockReturnValue(true),
    on: (ev: string, cb: (...args: any[]) => void) => emitter.on(ev, cb),
  };
  (bp as any).relayClient = relayClient;
  (bp as any).started = true;

  const key = `${p.id}-dev`;
  const entry = {
    client: relayClient,
    projectId: p.id,
    agentName: "dev" as const,
  };

  const from = { id: "sender-sid", name: "requester" };
  const message = {
    id: "msg-forward",
    content: { text: "forward this please" },
    expectsReply: true,
  };

  // 注入 pending 消息来模拟 flushPending 场景
  const pendingMsg = {
    messageId: message.id,
    fromId: from.id,
    fromName: from.name,
    text: message.content.text,
    expectsReply: true,
  };
  (bp as any).pending.set(key, [pendingMsg]);

  // 调用 flushPending
  await (bp as any).flushPending(key, entry);

  // 验证 relay.send 被调用（用 realName = "{key}-real"）
  expect(relayClient.send).toHaveBeenCalled();
  const sendCall = relayClient.send.mock.calls[0];
  expect(sendCall[0]).toBe(`${key}-real`);
  expect(sendCall[1].text).toBe("forward this please");

  // pending 队列应被清空
  expect((bp as any).pending.has(key)).toBe(false);

  await bp.dispose();
  rmSync(f, { force: true });
});

test("relay 收到回复后转发给原始发送方", async () => {
  const f = tempProjectFile();
  const ps = new ProjectStore(f);
  const p = await ps.createProject({ name: "P", cwd: "/p" });

  const onAsk = mock();
  const onReply = mock();
  const ensureStarted = mock().mockResolvedValue(undefined);

  const bp = new BrokerProxyManager({
    projectStore: ps,
    agentManager: { ensureStarted } as any,
    onAsk,
    onReply,
  });

  // 手动设置 relay client
  const relayClient = createdClients[0] ?? null;
  (bp as any).relayClient = relayClient;
  (bp as any).started = true;

  const key = `${p.id}-pm`;
  // 注入一个 pending 消息（模拟之前已缓存）
  const pendingMsg = {
    messageId: "orig-msg-1",
    fromId: "original-sender-sid",
    fromName: "sender",
    text: "original question",
    expectsReply: true,
  };
  (bp as any).pending.set(key, [pendingMsg]);

  // 模拟 relay 收到真实 agent 的回复
  const replyFrom = { id: "real-agent-sid", name: "pm-real" };
  const replyMessage = {
    content: { text: "answer from agent" },
    replyTo: "orig-msg-1",
  };

  await (bp as any).handleRelayReply(replyFrom, replyMessage);

  // 验证 relay.send 被调用，转发给原始发送方
  if (relayClient) {
    expect(relayClient.send).toHaveBeenCalled();
    const sendCall = relayClient.send.mock.calls.find(
      (c: any[]) => c[0] === "original-sender-sid"
    );
    expect(sendCall).toBeDefined();
    expect(sendCall[1].text).toBe("answer from agent");
    expect(sendCall[1].replyTo).toBe("orig-msg-1");
  }

  // pending 队列中该消息应被移除
  const remaining = (bp as any).pending.get(key);
  expect(remaining?.length ?? 0).toBe(0);

  await bp.dispose();
  rmSync(f, { force: true });
});

test("relay 收到不匹配的回复时不转发且保留 pending", async () => {
  const f = tempProjectFile();
  const ps = new ProjectStore(f);
  const p = await ps.createProject({ name: "P", cwd: "/p" });

  const bp = new BrokerProxyManager({
    projectStore: ps,
    agentManager: { ensureStarted: mock().mockResolvedValue(undefined) } as any,
    onAsk: mock(),
    onReply: mock(),
  });

  (bp as any).relayClient = createdClients[0] ?? null;
  (bp as any).started = true;

  const key = `${p.id}-dev`;
  const pendingMsg = {
    messageId: "msg-a",
    fromId: "sender-a",
    fromName: "A",
    text: "q",
  };
  (bp as any).pending.set(key, [pendingMsg]);

  // 回复的 replyTo 不匹配任何 pending 消息
  const replyMessage = {
    content: { text: "orphan reply" },
    replyTo: "non-existent-msg",
  };

  await (bp as any).handleRelayReply({ id: "x" }, replyMessage);

  // pending 应保持不变
  const remaining = (bp as any).pending.get(key);
  expect(remaining).toHaveLength(1);
  expect(remaining[0].messageId).toBe("msg-a");

  await bp.dispose();
  rmSync(f, { force: true });
});

test("dispose 断开所有 client 并清理状态", async () => {
  const f = tempProjectFile();
  const ps = new ProjectStore(f);
  await ps.createProject({ name: "P", cwd: "/p" });

  const bp = new BrokerProxyManager({
    projectStore: ps,
    agentManager: { ensureStarted: mock().mockResolvedValue(undefined) } as any,
    onAsk: mock(),
    onReply: mock(),
  });

  await bp.start();
  const clientCount = createdClients.length;
  expect(clientCount).toBeGreaterThan(0);

  await bp.dispose();

  // 所有 client 的 disconnect 都应被调用
  for (const c of createdClients) {
    expect(c.disconnect).toHaveBeenCalled();
  }

  // started 标志应重置
  expect((bp as any).started).toBe(false);
  // proxies map 应清空
  expect((bp as any).proxies.size).toBe(0);
  // pending map 应清空
  expect((bp as any).pending.size).toBe(0);
  // relay 应置空
  expect((bp as any).relayClient).toBeNull();

  rmSync(f, { force: true });
});

test("onAgentOffline 在 agent 断连时重新注册代理", async () => {
  const f = tempProjectFile();
  const ps = new ProjectStore(f);
  const p = await ps.createProject({ name: "P", cwd: "/p" });

  const bp = new BrokerProxyManager({
    projectStore: ps,
    agentManager: { ensureStarted: mock().mockResolvedValue(undefined) } as any,
    onAsk: mock(),
    onReply: mock(),
  });

  // 手动注册一个代理
  await (bp as any).registerProxy(p.id, "dev");
  const firstClient = createdClients[createdClients.length - 1];
  expect(firstClient.connect).toHaveBeenCalled();

  // 模拟 agent 断连 — 把 client 标记为未连接
  firstClient._connected = false;

  const clientCountBefore = createdClients.length;
  await bp.onAgentOffline(p.id, "dev");
  const clientCountAfter = createdClients.length;

  // 应该创建了新的 client
  expect(clientCountAfter).toBeGreaterThan(clientCountBefore);

  // 旧 client 的 disconnect 应被调用
  expect(firstClient.disconnect).toHaveBeenCalled();

  // 新 client 的 connect 应被调用
  const newClient = createdClients[createdClients.length - 1];
  expect(newClient.connect).toHaveBeenCalled();

  await bp.dispose();
  rmSync(f, { force: true });
});

test("onAgentOffline 在 agent 仍在线时不重新注册", async () => {
  const f = tempProjectFile();
  const ps = new ProjectStore(f);
  const p = await ps.createProject({ name: "P", cwd: "/p" });

  const bp = new BrokerProxyManager({
    projectStore: ps,
    agentManager: { ensureStarted: mock().mockResolvedValue(undefined) } as any,
    onAsk: mock(),
    onReply: mock(),
  });

  await (bp as any).registerProxy(p.id, "dev");
  const countBefore = createdClients.length;

  // agent 在线，不应重新注册
  await bp.onAgentOffline(p.id, "dev");
  expect(createdClients.length).toBe(countBefore);

  await bp.dispose();
  rmSync(f, { force: true });
});

test("registerProjectProxies 为所有 agent 名称注册代理", async () => {
  const f = tempProjectFile();
  const ps = new ProjectStore(f);
  const p = await ps.createProject({ name: "P", cwd: "/p" });

  const bp = new BrokerProxyManager({
    projectStore: ps,
    agentManager: { ensureStarted: mock().mockResolvedValue(undefined) } as any,
    onAsk: mock(),
    onReply: mock(),
  });

  const countBefore = createdClients.length;
  await bp.registerProjectProxies(p.id);
  // ALL_AGENT_NAMES = ["product","pm","dev","test"] → 4 个新 client
  expect(createdClients.length).toBe(countBefore + 4);

  await bp.dispose();
  rmSync(f, { force: true });
});
