/**
 * 对话控制域路由测试（阶段二·去 WS 化）
 *
 * 覆盖：abort / answer / cancel-ask / steer 简化版引导与立即执行。
 * 这七个 case 均为 fire-and-forget（handle() 不 reply）→ 200 {ok:true}。
 * answer/cancel-ask 经 askRegistry 验证真实行为；steer 失败时 case 内部捕获
 * 并 broadcast {type:"error"}（走 SSE 总线，HTTP 仍 200）。
 */
import { test, expect, beforeEach } from "bun:test";
import { askRegistry } from "../src/ask-registry";
import { withServer, openSse, readSseFrame, stubAgentManager } from "./helpers/http-api-kit";

beforeEach(() => askRegistry.reset());

/** 本域 stub：补齐 chat 域 case 用到的 agentManager 方法 */
function chatStub(overrides: Record<string, any> = {}) {
  return {
    ...stubAgentManager,
    isSessionStreaming: () => false,
    steerMessage: async () => {},
    abort: async () => {},
    clearFollowUpList: () => {},
    ...overrides,
  };
}

function post(base: string, path: string, body?: any) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

const ASK_PARAMS = {
  questions: [
    { question: "选哪个？", header: "选择", options: [{ label: "A", description: "甲" }, { label: "B", description: "乙" }] },
  ],
};

test("POST abort → 200 {ok:true}，agentManager.abort 收到 sessionId", async () => {
  let aborted = "";
  const am = chatStub({ abort: async (sessionId: string) => { aborted = sessionId; } });
  await withServer(am, async (base) => {
    const res = await post(base, "/api/agents/p1/s1/abort", { agentName: "dev" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(aborted).toBe("s1");
  });
});

test("POST answer → 200 {ok:true}，askRegistry 以 cancelled:false 解决并翻译 reply", async () => {
  await withServer(chatStub(), async (base) => {
    const outcome = askRegistry.ask("s1", "tc-1", ASK_PARAMS, new AbortController().signal);
    const res = await post(base, "/api/sessions/s1/answer", {
      toolCallId: "tc-1",
      reply: { replies: [{ questionIndex: 0, selected: ["A"] }] },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const o = await outcome;
    expect(o.cancelled).toBe(false);
    expect(o.answers?.[0].kind).toBe("option");
    expect(o.answers?.[0].answer).toBe("A");
  });
});

test("POST answer：未知 toolCallId 幂等 no-op → 200 {ok:true}", async () => {
  await withServer(chatStub(), async (base) => {
    const res = await post(base, "/api/sessions/s1/answer", {
      toolCallId: "不存在", reply: { replies: [] },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

test("POST cancel-ask → 200 {ok:true}，askRegistry 以 cancelled:true 解决", async () => {
  await withServer(chatStub(), async (base) => {
    const outcome = askRegistry.ask("s1", "tc-2", ASK_PARAMS, new AbortController().signal);
    const res = await post(base, "/api/sessions/s1/cancel-ask", { toolCallId: "tc-2" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await outcome).cancelled).toBe(true);
  });
});

test("POST steer → 200 {ok:true}，steerMessage 收到 sessionId/text", async () => {
  let got: any[] = [];
  const am = chatStub({ steerMessage: async (...args: any[]) => { got = args; } });
  await withServer(am, async (base) => {
    const res = await post(base, "/api/sessions/s1/steer", { text: "引导消息" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(got).toEqual(["s1", "引导消息"]);
  });
});

test("POST steer：steerMessage 抛错 → HTTP 200，错误帧走 SSE 总线", async () => {
  const am = chatStub({ steerMessage: async () => { throw new Error("引导炸了"); } });
  await withServer(am, async (base) => {
    const reader = await openSse(base);
    const res = await post(base, "/api/sessions/s1/steer", { text: "x" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const frame = await readSseFrame(reader);
    expect(frame.data.type).toBe("error");
    expect(frame.data.message).toContain("引导炸了");
    await reader.cancel();
  });
});

test("POST steer/immediate → 200 {ok:true}，abort + steerMessage 都被调用", async () => {
  const calls: string[] = [];
  const am = chatStub({
    abort: async () => { calls.push("abort"); },
    steerMessage: async () => { calls.push("steerMessage"); },
  });
  await withServer(am, async (base) => {
    const res = await post(base, "/api/sessions/s1/steer/immediate", { text: "立刻" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toEqual(["abort", "steerMessage"]);
  });
});

test("POST steer/immediate：abort 抛错 → HTTP 200，错误帧走 SSE 总线", async () => {
  const am = chatStub({ abort: async () => { throw new Error("abort炸了"); } });
  await withServer(am, async (base) => {
    const reader = await openSse(base);
    const res = await post(base, "/api/sessions/s1/steer/immediate", { text: "x" });
    expect(res.status).toBe(200);
    const frame = await readSseFrame(reader);
    expect(frame.data.type).toBe("error");
    expect(frame.data.message).toContain("立即执行失败");
    await reader.cancel();
  });
});

test("POST clear-queue → 200 {ok:true}，clearFollowUpList 收到 sessionId", async () => {
  let cleared = "";
  const am = chatStub({ clearFollowUpList: (sessionId: string) => { cleared = sessionId; } });
  await withServer(am, async (base) => {
    const res = await post(base, "/api/sessions/s1/clear-queue");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(cleared).toBe("s1");
  });
});
