// delegate 关系网调起工具单测：
// - makeDelegateTool：allowlist 校验（越权不 spawn）+ spawn 结果透传
// - buildDelegatePrompt：关系网提示词段纯函数
// - waitSubagentResult：getRecord 轮询终态映射（completed/error/中止/超时 abort）
// - spawnViaSubagentsService：生产 spawn 闭包（动态 import + try/catch + 轮询）
import { test, expect, mock, afterEach } from "bun:test";
import {
  makeDelegateTool,
  makeFleetTool,
  buildDelegatePrompt,
  waitSubagentResult,
  spawnViaSubagentsService,
} from "../src/delegate-tool";
import { publishSubagentsService, unpublishSubagentsService } from "@gotgenes/pi-subagents";

const askTo = [
  { name: "代码审查", description: "评审改动", triggerKeywords: ["review", "评审"] },
  { name: "质量验收", description: "测试与验收", triggerKeywords: [] },
];

// fake SubagentRecord 工厂（只保留轮询关心的字段）
function rec(status: string, extra: Record<string, unknown> = {}) {
  return { id: "a1", type: "t", description: "", status, toolUses: 0, startedAt: 0, compactionCount: 0, ...extra };
}

// 每个用例后摘除发布到 globalThis 的 fake service，避免跨用例/跨文件泄漏
afterEach(() => {
  unpublishSubagentsService();
});

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

test("waitSubagentResult: completed → 取 result，isError=false", async () => {
  const svc = { getRecord: () => rec("completed", { result: "done" }), abort: mock(() => true) };
  const r = await waitSubagentResult(svc, "a1", { intervalMs: 0 });
  expect(r).toEqual({ text: "done", isError: false });
  expect(svc.abort).not.toHaveBeenCalled();
});

test("waitSubagentResult: completed 无 result → 兜底文本", async () => {
  const svc = { getRecord: () => rec("completed"), abort: mock(() => true) };
  const r = await waitSubagentResult(svc, "a1", { intervalMs: 0 });
  expect(r).toEqual({ text: "（子智能体无输出）", isError: false });
});

test("waitSubagentResult: error → record.error，isError=true", async () => {
  const svc = { getRecord: () => rec("error", { error: "boom" }), abort: mock(() => true) };
  const r = await waitSubagentResult(svc, "a1", { intervalMs: 0 });
  expect(r).toEqual({ text: "boom", isError: true });
});

test("waitSubagentResult: error 无 error 字段 → 兜底文本", async () => {
  const svc = { getRecord: () => rec("error"), abort: mock(() => true) };
  const r = await waitSubagentResult(svc, "a1", { intervalMs: 0 });
  expect(r).toEqual({ text: "子智能体执行失败", isError: true });
});

test("waitSubagentResult: aborted/stopped/steered → 子智能体被中止", async () => {
  for (const status of ["aborted", "stopped", "steered"]) {
    const svc = { getRecord: () => rec(status), abort: mock(() => true) };
    const r = await waitSubagentResult(svc, "a1", { intervalMs: 0 });
    expect(r).toEqual({ text: "子智能体被中止", isError: true });
  }
});

test("waitSubagentResult: 轮询直到终态（running running completed）", async () => {
  const seq = [rec("running"), rec("running"), rec("completed", { result: "ok" })];
  let i = 0;
  const svc = { getRecord: () => seq[Math.min(i++, seq.length - 1)], abort: mock(() => true) };
  const r = await waitSubagentResult(svc, "a1", { intervalMs: 0, hardDeadlineMs: 5000 });
  expect(r).toEqual({ text: "ok", isError: false });
  expect(i).toBe(3);
});

test("waitSubagentResult: 绝对上限到点 → 先 abort 再返回超时文本", async () => {
  const abort = mock(() => true);
  const svc = { getRecord: () => rec("running"), abort };
  const r = await waitSubagentResult(svc, "a1", { intervalMs: 0, hardDeadlineMs: 0 });
  expect(abort).toHaveBeenCalledWith("a1");
  expect(r.isError).toBe(true);
  expect(r.text).toContain("执行超时");
});

test("waitSubagentResult: running 状态动态续期（activeTimeoutMs 内有 running 不超时）", async () => {
  // 前 3 次 running（每次续期），第 4 次 completed
  const seq = [rec("running"), rec("running"), rec("running"), rec("completed", { result: "ok" })];
  let i = 0;
  const svc = { getRecord: () => seq[Math.min(i++, seq.length - 1)], abort: mock(() => true) };
  // activeTimeoutMs=10ms（每次 running 续期），hardDeadlineMs=5000ms（绝对上限足够长）
  const r = await waitSubagentResult(svc, "a1", { intervalMs: 0, activeTimeoutMs: 10, hardDeadlineMs: 5000 });
  expect(r).toEqual({ text: "ok", isError: false });
  expect(svc.abort).not.toHaveBeenCalled();
});

test("waitSubagentResult: 持续 running 超过 hardDeadlineMs → abort", async () => {
  const svc = { getRecord: () => rec("running"), abort: mock(() => true) };
  const r = await waitSubagentResult(svc, "a1", { intervalMs: 0, activeTimeoutMs: 10, hardDeadlineMs: 20 });
  expect(svc.abort).toHaveBeenCalledWith("a1");
  expect(r.isError).toBe(true);
});

test("spawnViaSubagentsService: 服务未就绪 → 错误文本，不 throw", async () => {
  // 测试进程默认无人 publish，getSubagentsService() 为 undefined
  const r = await spawnViaSubagentsService("代码审查", "task");
  expect(r).toEqual({ text: "子智能体服务未就绪", isError: true });
});

test("spawnViaSubagentsService: spawn 抛异常 → 错误文本，不 throw", async () => {
  publishSubagentsService({
    spawn: () => { throw new Error("No active session"); },
    getRecord: () => undefined,
    abort: () => false,
  } as any);
  const r = await spawnViaSubagentsService("代码审查", "task");
  expect(r.isError).toBe(true);
  expect(r.text).toContain("No active session");
});

test("spawnViaSubagentsService: spawn 成功 → 轮询到终态返回结果", async () => {
  publishSubagentsService({
    spawn: () => "agent-42",
    getRecord: (id: string) => (id === "agent-42" ? rec("completed", { result: "评审通过" }) : undefined),
    abort: () => true,
  } as any);
  const r = await spawnViaSubagentsService("代码审查", "review diff");
  expect(r).toEqual({ text: "评审通过", isError: false });
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
  // 部分失败时整体标记 isError=true（提示主智能体关注）
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
