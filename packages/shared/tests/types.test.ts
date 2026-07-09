import { test, describe, it, expect } from "bun:test";
import type {
  AgentName, AgentConfig, ProjectEntity, SessionEntity,
  AgentState, AgentStateKey,
  AssistantMessageEvent, SDKEvent, SDKEventEnvelope, WSServerEvent,
  PromptEvent, FSReadFileRequest,
} from "../src/types";
import type { ProviderModel } from "../src/providers";

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

test("SessionEntity 含 piSessionFile 字段", () => {
  const s: SessionEntity = {
    id: "s1", projectId: "p1", primaryAgent: "dev",
    title: "t", createdAt: 0, lastActivity: 0,
    piSessionFile: "~/.hiagent/sessions/s1.jsonl",
  };
  expect(s.piSessionFile).toContain("s1.jsonl");
});

test("SDKEventEnvelope 包裹 SDKEvent", () => {
  const ev: SDKEvent = { type: "agent_start" };
  const env: SDKEventEnvelope = {
    type: "sdk:event",
    projectId: "p1", sessionId: "s1", agentName: "dev",
    event: ev,
  };
  const server: WSServerEvent = env;
  expect(server.type).toBe("sdk:event");
});

test("AssistantMessageEvent done 变体可赋值", () => {
  const e: AssistantMessageEvent = {
    type: "done", reason: "stop",
    message: {
      role: "assistant", content: [], model: "m",
      stopReason: "stop", timestamp: 0,
    },
  };
  expect(e.type).toBe("done");
});

describe("PromptEvent attachments", () => {
  it("accepts model, thinking and attachments", () => {
    const e: PromptEvent = {
      type: "agent:prompt",
      projectId: "p1",
      sessionId: "s1",
      agentName: "dev",
      text: "hello",
      model: "deepseek-chat",
      thinking: "high",
      attachments: [{ kind: "file", name: "readme.md", path: "/tmp/readme.md", size: 123 }],
    };
    expect(e.model).toBe("deepseek-chat");
    expect(e.thinking).toBe("high");
    expect(e.attachments).toHaveLength(1);
  });
});

describe("FSReadFile types", () => {
  it("has request/result types", () => {
    const req: FSReadFileRequest = { type: "fs:readFile", path: "/tmp/a.txt" };
    expect(req.type).toBe("fs:readFile");
  });
});

describe("ProviderModel supportsVision", () => {
  it("optional supportsVision field", () => {
    const m: ProviderModel = { id: "gpt-4o", contextWindow: 128000, maxTokens: 4096, supportsVision: true };
    expect(m.supportsVision).toBe(true);
  });
});
