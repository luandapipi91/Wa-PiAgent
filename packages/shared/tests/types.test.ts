import { test, expect } from "bun:test";
import type { AgentConfig, WSEvent, RPCEvent } from "../src/types";

test("AgentConfig 类型可构造", () => {
  const c: AgentConfig = {
    name: "dev", displayName: "研发", avatar: "⚙️",
    description: "后端", model: "deepseek/deepseek-v4-flash", thinking: "high",
    tools: ["read"], skills: [],
    partners: { askTo: ["product"], askFrom: ["product"] },
  };
  expect(c.name).toBe("dev");
});

test("WSEvent 联合类型可区分", () => {
  const e: WSEvent = { type: "agent:state", agentName: "dev", state: { status: "thinking" } };
  expect(e.type).toBe("agent:state");
});
