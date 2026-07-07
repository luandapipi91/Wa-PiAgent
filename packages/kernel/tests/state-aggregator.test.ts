import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { StateAggregator } from "../src/state-aggregator";
import { AgentManager } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import type { WSServerEvent } from "@hiagent/shared";

function setup() {
  const sf = join(import.meta.dir, ".tmp-sa-" + Math.random().toString(36).slice(2) + ".json");
  const ps = new ProjectStore(sf);
  const events: WSServerEvent[] = [];
  const am = new AgentManager({ projectStore: ps, onEvent: () => {}, spawnFn: (() => ({})) as any });
  const sa = new StateAggregator({ agentManager: am, onServerEvent: e => events.push(e) });
  return { sf, ps, events, am, sa, cleanup: () => { rmSync(sf, { force: true }); } };
}

test("routePiEvent message → agent:message 透传 SessionMessage", () => {
  const { sa, events, cleanup } = setup();
  const sessionMsg = {
    message: { role: "assistant" as const, content: [{ type: "text" as const, text: "回复" }], model: "m", stopReason: "stop", timestamp: 0 },
    agentName: "dev" as const,
    sessionId: "s1",
  };
  sa.routePiEvent("p1:dev", {
    kind: "message",
    message: sessionMsg,
  });
  const ev = events.find(e => e.type === "agent:message") as Extract<WSServerEvent, { type: "agent:message" }>;
  expect(ev).toBeDefined();
  // 透传富消息：content[0].text === "回复"
  expect((ev.message.message as any).content[0].text).toBe("回复");
  // sessionId 取自 SessionMessage.sessionId
  expect(ev.sessionId).toBe("s1");
  // agentName 取自 AgentStateKey
  expect(ev.agentName).toBe("dev");
  cleanup();
});

test("routePiEvent message 无 sessionId 时回退空串", () => {
  const { sa, events, cleanup } = setup();
  sa.routePiEvent("p1:dev", {
    kind: "message",
    message: {
      message: { role: "assistant" as const, content: [{ type: "text" as const, text: "x" }], model: "m", stopReason: "stop", timestamp: 0 },
      agentName: "dev",
    },
  });
  const ev = events.find(e => e.type === "agent:message") as Extract<WSServerEvent, { type: "agent:message" }>;
  expect(ev.sessionId).toBe("");
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
