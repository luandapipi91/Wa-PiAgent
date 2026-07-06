import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { StateAggregator } from "../src/state-aggregator";
import { SessionStore } from "../src/session-store";
import { AgentManager } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import type { WSServerEvent } from "@hiagent/shared";

function setup() {
  const sf = join(import.meta.dir, ".tmp-sa-" + Math.random().toString(36).slice(2) + ".json");
  const sd = join(import.meta.dir, ".tmp-sa-sess-" + Math.random().toString(36).slice(2));
  const ps = new ProjectStore(sf);
  const ss = new SessionStore(sd);
  const events: WSServerEvent[] = [];
  const am = new AgentManager({ projectStore: ps, onEvent: () => {}, spawnFn: (() => ({})) as any });
  const sa = new StateAggregator({ sessionStore: ss, agentManager: am, onServerEvent: e => events.push(e) });
  return { sf, sd, ps, ss, events, am, sa, cleanup: () => { rmSync(sf, { force: true }); rmSync(sd, { recursive: true, force: true }); } };
}

test("routePiEvent message → agent:message + 持久化", async () => {
  const { sa, ss, events, cleanup } = setup();
  sa.routePiEvent("p1:dev", {
    kind: "message",
    message: { id: "m1", sessionId: "s1", role: "assistant", text: "回复", timestamp: 0 },
  });
  // 等异步持久化
  await new Promise(r => setTimeout(r, 50));
  expect(events.find(e => e.type === "agent:message")).toBeDefined();
  const msgs = await ss.loadMessages("s1");
  expect(msgs).toHaveLength(1);
  cleanup();
});

test("routePiEvent state → agent:state", () => {
  const { sa, events, cleanup } = setup();
  sa.routePiEvent("p1:dev", {
    kind: "state",
    state: { name: "dev", status: "thinking" },
  });
  expect(events.find(e => e.type === "agent:state")).toBeDefined();
  cleanup();
});

test("routeAsk → intercom:ask + 持久化", async () => {
  const { sa, ss, events, cleanup } = setup();
  sa.routeAsk({
    messageId: "a1", sessionId: "s1", from: "product", to: "dev",
    text: "问", startedAt: 0, resolved: false,
  });
  await new Promise(r => setTimeout(r, 50));
  expect(events.find(e => e.type === "intercom:ask")).toBeDefined();
  const asks = await ss.loadAsks("s1");
  expect(asks).toHaveLength(1);
  cleanup();
});

test("routeReply → intercom:reply + resolve 持久化", async () => {
  const { sa, ss, events, cleanup } = setup();
  sa.routeAsk({ messageId: "a1", sessionId: "s1", from: "product", to: "dev", text: "问", startedAt: 0, resolved: false });
  await new Promise(r => setTimeout(r, 50));
  sa.routeReply("a1", "s1");
  await new Promise(r => setTimeout(r, 50));
  expect(events.find(e => e.type === "intercom:reply")).toBeDefined();
  const asks = await ss.loadAsks("s1");
  expect(asks[0].resolved).toBe(true);
  cleanup();
});
