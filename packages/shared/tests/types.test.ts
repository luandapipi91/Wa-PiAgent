import { test, expect } from "bun:test";
import type {
  AgentName, AgentConfig, ProjectEntity, SessionEntity,
  ChatMessage, AskItem, AgentState, AgentStateKey,
} from "../src/types";

test("AgentName 四值", () => {
  const names: AgentName[] = ["product", "pm", "dev", "test"];
  expect(names).toHaveLength(4);
});

test("AgentStateKey 模板字符串", () => {
  const k: AgentStateKey = "p1:dev";
  expect(k).toBe("p1:dev");
});

test("AgentConfig 含 partners", () => {
  const c: AgentConfig = {
    name: "dev", displayName: "研发", avatar: "⚙️",
    avatarColor: "#fab387-#f38ba8", description: "",
    model: "anthropic/claude-sonnet-4", thinking: "high",
    systemPromptMode: "replace", inheritProjectContext: true,
    inheritSkills: false, tools: ["read"], skills: [],
    mcpServers: [], partners: { askTo: ["product"], askFrom: ["product"] },
  };
  expect(c.partners.askTo).toEqual(["product"]);
});

test("AskItem 含 sessionId", () => {
  const a: AskItem = {
    messageId: "m1", sessionId: "s1", from: "product", to: "dev",
    text: "问", startedAt: 0, resolved: false,
  };
  expect(a.sessionId).toBe("s1");
});
