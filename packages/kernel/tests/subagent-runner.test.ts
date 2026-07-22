// subagent-runner.test.ts — subagent-runner 单元测试
import { test, expect, mock } from "bun:test";
import {
  buildAgentDefinition,
  type SubagentProgressEvent,
  type HiAgentSpawnConfig,
} from "../src/subagent-runner";

test("buildAgentDefinition 从 HiAgent config 构造 AgentDefinition", () => {
  const def = buildAgentDefinition({
    name: "research",
    description: "调研",
    systemPrompt: "你是一个调研员",
    systemPromptMode: "replace",
    model: "glm-4.6",
    thinking: "medium",
    tools: ["read", "grep"],
    skills: ["brainstorming"],
  });
  expect(def.name).toBe("research");
  expect(def.description).toBe("调研");
  expect(def.prompt).toBe("你是一个调研员");
  expect(def.tools).toEqual(["read", "grep"]);
  expect(def.skills).toEqual(["brainstorming"]);
  expect(def.mode).toBe("subagent");
  expect(def.thinking).toBe("medium");
  expect(def.model).toBe("glm-4.6");
});

test("buildAgentDefinition 内置类型用 SUBAGENT_TYPES 元信息填充缺省值（Explore）", () => {
  const def = buildAgentDefinition({
    name: "Explore",
    description: "",
    systemPrompt: "",
    systemPromptMode: "replace",
    model: null,
    thinking: null,
    tools: [],
    skills: [],
  });
  expect(def.name).toBe("Explore");
  // Explore 是只读探索类型，工具集应为只读
  expect(def.tools).toContain("read");
  expect(def.tools).toContain("grep");
  expect(def.description).toBe("只读代码探索，快速搜索和理解代码库结构。");
});

test("buildAgentDefinition 内置类型用 SUBAGENT_TYPES 元信息填充缺省值（Plan）", () => {
  const def = buildAgentDefinition({
    name: "Plan",
    description: "",
    systemPrompt: "",
    systemPromptMode: "replace",
    model: null,
    thinking: null,
    tools: [],
    skills: [],
  });
  expect(def.name).toBe("Plan");
  expect(def.tools).toContain("read");
  expect(def.tools).toContain("grep");
});

test("buildAgentDefinition general-purpose 不设只读工具（readOnly=false）", () => {
  const def = buildAgentDefinition({
    name: "general-purpose",
    description: "",
    systemPrompt: "",
    systemPromptMode: "replace",
    model: null,
    thinking: null,
    tools: [],
    skills: [],
  });
  expect(def.name).toBe("general-purpose");
  // readOnly 为 false → tools 为 undefined（全量工具）
  expect(def.tools).toBeUndefined();
});

test("buildAgentDefinition config.skills 非空时白名单生效", () => {
  const def = buildAgentDefinition({
    name: "dev",
    description: "",
    systemPrompt: "",
    systemPromptMode: "replace",
    model: null,
    thinking: null,
    tools: [],
    skills: ["pdf", "brainstorming"],
  });
  expect(def.skills).toEqual(["pdf", "brainstorming"]);
});

test("buildAgentDefinition config.skills 为空时不设 skills（继承全部）", () => {
  const def = buildAgentDefinition({
    name: "dev",
    description: "",
    systemPrompt: "",
    systemPromptMode: "replace",
    model: null,
    thinking: null,
    tools: [],
    skills: [],
  });
  expect(def.skills).toBeUndefined();
});

test("buildAgentDefinition config.tools 为空且非内置只读时不设 tools（全量）", () => {
  const def = buildAgentDefinition({
    name: "custom-agent",
    description: "",
    systemPrompt: "",
    systemPromptMode: "replace",
    model: null,
    thinking: null,
    tools: [],
    skills: [],
  });
  expect(def.tools).toBeUndefined();
});

test("mapThinking 映射：disabled → off", () => {
  const def = buildAgentDefinition({
    name: "test",
    description: "",
    systemPrompt: "",
    systemPromptMode: "replace",
    model: null,
    thinking: "disabled",
    tools: [],
    skills: [],
  });
  expect(def.thinking).toBe("off");
});

test("mapThinking 映射：max → xhigh", () => {
  const def = buildAgentDefinition({
    name: "test",
    description: "",
    systemPrompt: "",
    systemPromptMode: "replace",
    model: null,
    thinking: "max",
    tools: [],
    skills: [],
  });
  expect(def.thinking).toBe("xhigh");
});

test("mapThinking 映射：null → medium（默认）", () => {
  const def = buildAgentDefinition({
    name: "test",
    description: "",
    systemPrompt: "",
    systemPromptMode: "replace",
    model: null,
    thinking: null,
    tools: [],
    skills: [],
  });
  expect(def.thinking).toBe("medium");
});

test("buildAgentDefinition systemPromptMode replace → AgentDefinition systemPrompt = 'replace'", () => {
  const def = buildAgentDefinition({
    name: "test",
    description: "",
    systemPrompt: "自定义提示词",
    systemPromptMode: "replace",
    model: null,
    thinking: null,
    tools: [],
    skills: [],
  });
  expect(def.systemPrompt).toBe("replace");
  expect(def.prompt).toBe("自定义提示词");
});
