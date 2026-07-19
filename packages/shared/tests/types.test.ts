import { test, describe, it, expect } from "bun:test";
import type {
  AgentName, AgentConfig, ProjectEntity, SessionEntity,
  AgentState, AgentStateKey,
  AssistantMessageEvent, SDKEvent, SDKEventEnvelope, WSServerEvent,
  PromptEvent, FSListDirRequest, FSReadFileRequest, FSUploadRequest, FSUploadResult,
} from "../src/types";
import type { ProviderModel } from "../src/providers";
import { agentDefOf } from "../src/constants";

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
    triggerKeywords: [],
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

describe("FSListDir types", () => {
  it("accepts optional showHidden flag", () => {
    const req: FSListDirRequest = { type: "fs:listDir", path: "/tmp" };
    const reqHidden: FSListDirRequest = { type: "fs:listDir", path: "/tmp", showHidden: true };
    expect(req.showHidden).toBeUndefined();
    expect(reqHidden.showHidden).toBe(true);
  });
});

describe("FSReadFile types", () => {
  it("has request/result types", () => {
    const req: FSReadFileRequest = { type: "fs:readFile", path: "/tmp/a.txt" };
    expect(req.type).toBe("fs:readFile");
  });
});

describe("FSUpload types", () => {
  it("has request/result types with correlation id", () => {
    const req: FSUploadRequest = { type: "fs:upload", id: "u1", projectId: "p1", name: "a.txt", content: "abc" };
    const res: FSUploadResult = { type: "fs:upload", id: "u1", path: "/project/a.txt" };
    expect(req.id).toBe(res.id);
    expect(res.path).toContain("a.txt");
  });
});

describe("ProviderModel supportsVision", () => {
  it("optional supportsVision field", () => {
    const m: ProviderModel = { id: "gpt-4o", contextWindow: 128000, maxTokens: 4096, supportsVision: true };
    expect(m.supportsVision).toBe(true);
  });
});

test("AgentConfig 支持 triggerKeywords 与 ThinkingLevel", () => {
  const c: import("../src/types").AgentConfig = {
    name: "代码审查", displayName: "代码审查", avatar: "🔍", avatarColor: "#06b6d4-#3b82f6",
    description: "评审改动", model: "m", thinking: "max",
    systemPromptMode: "replace", inheritProjectContext: true, inheritSkills: true,
    tools: [], skills: [], mcpServers: [], partners: { askTo: [], askFrom: [] },
    triggerKeywords: ["review", "评审"],
  };
  expect(c.triggerKeywords).toEqual(["review", "评审"]);
  expect(c.thinking).toBe("max");
});

test("AgentConfig.thinking/model 可为 null（跟随当前/跟随全局）", () => {
  const c: import("../src/types").AgentConfig = {
    name: "dev", displayName: "研发", avatar: "⚙️",
    avatarColor: "#fab387-#f38ba8", description: "",
    model: null, thinking: null,
    systemPromptMode: "replace", inheritProjectContext: true,
    inheritSkills: false, tools: [], skills: [],
    mcpServers: [], partners: { askTo: [], askFrom: [] },
    triggerKeywords: [],
  };
  expect(c.thinking).toBeNull();
  expect(c.model).toBeNull();
});

test("agentDefOf: 内置名返回定义，未知名回退默认", () => {
  expect(agentDefOf("dev").emoji).toBe("⚙️");
  const fb = agentDefOf("不存在的智能体");
  expect(fb.emoji).toBe("🤖");
  expect(fb.gradient).toEqual(["#4b5563", "#6b7280"]);
  expect(fb.label).toBe("不存在的智能体");
});
