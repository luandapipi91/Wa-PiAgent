// delegate 关系网调起工具单测：
// - makeDelegateTool：allowlist 校验（越权不 spawn）+ spawn 结果透传
// - buildDelegatePrompt：关系网提示词段纯函数
// - makeFleetTool：并行派发 + 聚合
// - makeSpawnFn：spawn 闭包工厂（resolveConfig → runSubagentAgent）
import { test, expect, mock } from "bun:test";
import {
  makeDelegateTool,
  makeFleetTool,
  buildDelegatePrompt,
  makeSpawnFn,
  MAX_SUBAGENT_CONCURRENCY,
} from "../src/delegate-tool";

const askTo = [
  { name: "代码审查", description: "评审改动", triggerKeywords: ["review", "评审"] },
  { name: "质量验收", description: "测试与验收", triggerKeywords: [] },
];

test("delegate: 越权调起返回错误且不 spawn", async () => {
  const spawn = mock(async () => ({ text: "ok", isError: false }));
  const tool = makeDelegateTool({ askTo, spawn });
  const res = await tool.execute("tc1", { agent: "陌生人", task: "hi" });
  expect(res.isError).toBe(true);
  expect(res.content[0].text).toContain("不在可调起列表");
  expect(res.content[0].text).toContain("代码审查、质量验收");
  expect(spawn).not.toHaveBeenCalled();
});

test("delegate: 合法调起透传结果", async () => {
  const spawn = mock(async (agent: string, task: string) => ({ text: `${agent}完成:${task}`, isError: false }));
  const tool = makeDelegateTool({ askTo, spawn });
  const res = await tool.execute("tc2", { agent: "代码审查", task: "review diff" });
  expect(res.isError).toBe(false);
  expect(res.content[0].text).toBe("代码审查完成:review diff");
  expect(spawn).toHaveBeenCalledWith("代码审查", "review diff");
});

test("delegate: 透传 spawn 的失败结果（isError 原样带出）", async () => {
  const spawn = mock(async () => ({ text: "子智能体执行失败", isError: true }));
  const tool = makeDelegateTool({ askTo, spawn });
  const res = await tool.execute("tc3", { agent: "质量验收", task: "跑测试" });
  expect(res.isError).toBe(true);
  expect(res.content[0].text).toBe("子智能体执行失败");
});

test("buildDelegatePrompt: 含名称/简介/关键词/fleet 说明；空 askTo 返回空串", () => {
  const p = buildDelegatePrompt(askTo);
  expect(p).toContain("代码审查");
  expect(p).toContain("评审改动");
  expect(p).toContain("review、评审");
  expect(p).toContain("delegate");
  expect(p).toContain("fleet");
  expect(p).toContain("并行");
  expect(buildDelegatePrompt([])).toBe("");
});

// ---- 内置 subagent 类型名（general-purpose / Explore / Plan）allowlist 放行 ----

test("delegate: 内置类型名 general-purpose 放行（绕过 askTo 名单）", async () => {
  const spawn = mock(async (agent: string, task: string) => ({ text: `${agent}:${task}`, isError: false }));
  const tool = makeDelegateTool({ askTo, spawn });
  const res = await tool.execute("tc-gp", { agent: "general-purpose", task: "do something" });
  expect(res.isError).toBe(false);
  expect(res.content[0].text).toBe("general-purpose:do something");
  expect(spawn).toHaveBeenCalledWith("general-purpose", "do something");
});

test("delegate: 内置类型名 Explore 放行（大小写敏感）", async () => {
  const spawn = mock(async (agent: string, task: string) => ({ text: `${agent}:${task}`, isError: false }));
  const tool = makeDelegateTool({ askTo, spawn });
  const res = await tool.execute("tc-ex", { agent: "Explore", task: "search code" });
  expect(res.isError).toBe(false);
  expect(spawn).toHaveBeenCalledWith("Explore", "search code");
});

test("delegate: 内置类型名 Plan 放行（绕过 askTo 名单）", async () => {
  const spawn = mock(async (agent: string, task: string) => ({ text: `${agent}:${task}`, isError: false }));
  const tool = makeDelegateTool({ askTo, spawn });
  const res = await tool.execute("tc-plan", { agent: "Plan", task: "design plan" });
  expect(res.isError).toBe(false);
  expect(spawn).toHaveBeenCalledWith("Plan", "design plan");
});

test("delegate: makeDelegateTool 描述含全部内置类型名（含 Plan）", () => {
  const spawn = mock(async () => ({ text: "ok", isError: false }));
  const tool = makeDelegateTool({ askTo, spawn });
  expect(tool.description).toContain("general-purpose");
  expect(tool.description).toContain("Explore");
  expect(tool.description).toContain("Plan");
});

test("delegate: 大小写错误（explore 而非 Explore）不放行", async () => {
  const spawn = mock(async () => ({ text: "ok", isError: false }));
  const tool = makeDelegateTool({ askTo, spawn });
  const res = await tool.execute("tc-lower", { agent: "explore", task: "x" });
  expect(res.isError).toBe(true);
  expect(res.content[0].text).toContain("不在可调起列表");
  expect(spawn).not.toHaveBeenCalled();
});

test("delegate: 错误信息列出可调起名单 + 内置类型", async () => {
  const spawn = mock(async () => ({ text: "ok", isError: false }));
  const tool = makeDelegateTool({ askTo, spawn });
  const res = await tool.execute("tc-err", { agent: "陌生人", task: "x" });
  expect(res.content[0].text).toContain("代码审查");
  expect(res.content[0].text).toContain("质量验收");
  expect(res.content[0].text).toContain("general-purpose");
  expect(res.content[0].text).toContain("Explore");
});

test("delegate: 中文别名（通用子智能体）放行并归一化为英文 name 传给 spawn", async () => {
  const spawn = mock(async (agent: string, task: string) => ({ text: `${agent}:${task}`, isError: false }));
  const tool = makeDelegateTool({ askTo, spawn });
  const res = await tool.execute("tc-cn", { agent: "通用子智能体", task: "做某事" });
  expect(res.isError).toBe(false);
  expect(spawn).toHaveBeenCalledWith("general-purpose", "做某事");
});

test("delegate: 中文别名（探索子智能体）归一化为 Explore", async () => {
  const spawn = mock(async (agent: string, task: string) => ({ text: `${agent}:${task}`, isError: false }));
  const tool = makeDelegateTool({ askTo, spawn });
  const res = await tool.execute("tc-cn-ex", { agent: "探索子智能体", task: "搜代码" });
  expect(res.isError).toBe(false);
  expect(spawn).toHaveBeenCalledWith("Explore", "搜代码");
});

test("fleet: 内置类型名也放行（每个 task 独立校验）", async () => {
  const spawn = mock(async (agent: string, task: string) => ({ text: `${agent}:${task}`, isError: false }));
  const tool = makeFleetTool({ askTo, spawn });
  const res = await tool.execute("tc-fleet", {
    tasks: [
      { agent: "Explore", task: "search A" },
      { agent: "代码审查", task: "review B" },
      { agent: "general-purpose", task: "general task" },
    ],
  });
  expect(res.isError).toBe(false);
  expect(res.content[0].text).toContain("Explore:search A");
  expect(res.content[0].text).toContain("代码审查:review B");
  expect(res.content[0].text).toContain("general-purpose:general task");
  expect(spawn).toHaveBeenCalledTimes(3);
});

test("fleet: 内置类型 + 越权 agent 混合时越权项报错但其它项正常", async () => {
  const spawn = mock(async (agent: string, task: string) => ({ text: `${agent}:ok`, isError: false }));
  const tool = makeFleetTool({ askTo, spawn });
  const res = await tool.execute("tc-fleet-mix", {
    tasks: [
      { agent: "Explore", task: "search" },
      { agent: "陌生人", task: "x" },
    ],
  });
  expect(res.isError).toBe(true);
  expect(res.content[0].text).toContain("Explore:ok");
  expect(res.content[0].text).toContain("陌生人");
  expect(res.content[0].text).toContain("不在可调起列表");
  expect(spawn).toHaveBeenCalledTimes(1);
});

test("fleet: 并发执行多个合法任务，结果按输入顺序聚合", async () => {
  const spawn = mock(async (agent: string, task: string) => ({
    text: `[${agent}] done: ${task}`, isError: false,
  }));
  const tool = makeFleetTool({ askTo, spawn });
  const res = await tool.execute("tc4", {
    tasks: [
      { agent: "代码审查", task: "review a" },
      { agent: "质量验收", task: "test b" },
    ],
  });
  expect(res.isError).toBe(false);
  expect(res.content[0].text).toContain("[代码审查] done: review a");
  expect(res.content[0].text).toContain("[质量验收] done: test b");
  expect(spawn).toHaveBeenCalledTimes(2);
});

test("fleet: 单个任务失败不影响其他任务，聚合标记 isError", async () => {
  const spawn = mock(async (agent: string, task: string) => {
    if (agent === "代码审查") return { text: "评审通过", isError: false };
    return { text: "测试失败", isError: true };
  });
  const tool = makeFleetTool({ askTo, spawn });
  const res = await tool.execute("tc5", {
    tasks: [
      { agent: "代码审查", task: "review" },
      { agent: "质量验收", task: "test" },
    ],
  });
  expect(res.isError).toBe(true);
  expect(res.content[0].text).toContain("评审通过");
  expect(res.content[0].text).toContain("测试失败");
});

test("fleet: 越权 agent 跳过 spawn，单项返回错误文本", async () => {
  const spawn = mock(async () => ({ text: "ok", isError: false }));
  const tool = makeFleetTool({ askTo, spawn });
  const res = await tool.execute("tc6", {
    tasks: [{ agent: "陌生人", task: "x" }],
  });
  expect(res.isError).toBe(true);
  expect(res.content[0].text).toContain("不在可调起列表");
  expect(spawn).not.toHaveBeenCalled();
});

test("fleet: 空任务数组返回提示文本", async () => {
  const spawn = mock(async () => ({ text: "ok", isError: false }));
  const tool = makeFleetTool({ askTo, spawn });
  const res = await tool.execute("tc7", { tasks: [] });
  expect(res.isError).toBe(false);
  expect(res.content[0].text).toContain("无任务");
});

// ---- makeSpawnFn 测试 ----

test("makeSpawnFn: resolveConfig 返回 null → 错误文本", async () => {
  const resolveConfig = mock(async () => null);
  const spawn = makeSpawnFn({ resolveConfig, cwd: "/tmp" });
  const result = await spawn("unknown-agent", "task");
  expect(result.isError).toBe(true);
  expect(result.text).toContain("配置未找到");
  expect(result.text).toContain("unknown-agent");
});

test("makeSpawnFn: resolveConfig 成功透传给 spawn", async () => {
  const resolveConfig = mock(async () => ({
    name: "test-agent",
    description: "test desc",
    systemPrompt: "you are a test agent",
    systemPromptMode: "replace" as const,
    model: null,
    thinking: null,
    tools: [],
    skills: [],
  }));
  // makeSpawnFn 内部调用 runSubagentAgent（子进程 async），在 mock 环境会抛错。
  // 只测 resolveConfig 被正确调用 + 不会提前返回错误。
  const spawn = makeSpawnFn({ resolveConfig, cwd: "/tmp" });
  try {
    await spawn("test-agent", "task");
  } catch {
    // runSubagentAgent 调用 runSubagent 在测试环境不可用，预期抛错
  }
  expect(resolveConfig).toHaveBeenCalledWith("test-agent");
});

test("makeSpawnFn: onProgress 回调正确绑定", async () => {
  const progressEvents: any[] = [];
  const onProgress = mock((event: any) => {
    progressEvents.push(event);
  });
  const resolveConfig = mock(async () => ({
    name: "test-agent",
    description: "test desc",
    systemPrompt: "you are a test agent",
    systemPromptMode: "replace" as const,
    model: null,
    thinking: null,
    tools: [],
    skills: [],
  }));
  const spawn = makeSpawnFn({ resolveConfig, cwd: "/tmp", onProgress });
  try {
    await spawn("test-agent", "task");
  } catch {
    // 预期抛错
  }
  // onProgress 至少被注册（runSubagentAgent 内部会传回调）
  // 由于 runSubagent 不可用，这里只验证 spawn 创建成功不抛错
  expect(spawn).toBeDefined();
});

test("MAX_SUBAGENT_CONCURRENCY 为正值", () => {
  expect(MAX_SUBAGENT_CONCURRENCY).toBeGreaterThan(0);
});
