import { test, expect } from "bun:test";
import { PiRpcClient } from "../src/pi-rpc-client";
import type { AgentConfig } from "hiagent-shared";

const CFG: AgentConfig = {
  name: "test", displayName: "Test", avatar: "🧪", description: "",
  model: "deepseek/deepseek-v4-flash", thinking: "off",
  tools: [], skills: [], partners: { askTo: [], askFrom: [] },
};

test("PiRpcClient 启动 + get_state 返回 sessionName", async () => {
  const client = new PiRpcClient(CFG, "/tmp");
  const events: any[] = [];
  client.on("event", e => events.push(e));
  await client.start();
  const state = await client.getState();
  client.stop();
  expect(state.success).toBe(true);
  expect(state.data.sessionName).toBe("test");
  expect(events.some(e => e.type === "response" && e.command === "get_state")).toBe(true);
});
