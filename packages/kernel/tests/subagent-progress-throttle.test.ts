// subagent:progress 出口节流器单测（流式卡顿修复 3.2）。
// 与 SdkEventThrottle 同模式：窗口内最多一帧（首帧立即 + 窗口末最新帧），
// 节流键含 taskIndex（fleet 并行互不影响），终态立即透传且先冲刷挂起帧保序。
import { test, expect } from "bun:test";
import { SubagentProgressThrottle } from "../src/event-throttle";
import type { SubagentProgressEvent } from "@wa-pi/shared";

function fakeClock(start = 10_000) {
  let now = start;
  const timers: Array<{ id: number; at: number; fn: () => void }> = [];
  let nextId = 1;
  return {
    now: () => now,
    schedule: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ id, at: now + ms, fn });
      return id;
    },
    cancel: (h: unknown) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
    advance(ms: number) {
      now += ms;
      // 逐条执行到期定时器（执行中可能新注册，循环直到无到期）
      for (;;) {
        const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at);
        if (due.length === 0) break;
        for (const t of due) {
          timers.splice(timers.indexOf(t), 1);
          t.fn();
        }
      }
    },
  };
}

function ev(output: string, over?: Partial<SubagentProgressEvent>): SubagentProgressEvent {
  return { agent: "Explore", status: "running", output, tools: [], elapsedMs: 0, ...over };
}

test("窗口内 running 帧合并：首帧立即发，后续只发窗口末最新帧", () => {
  const sent: SubagentProgressEvent[] = [];
  const clock = fakeClock();
  const th = new SubagentProgressThrottle((_s, _t, e) => sent.push(e), { ...clock });
  th.handle("s1", "tc1", ev("a")); // 窗口外：立即
  th.handle("s1", "tc1", ev("ab")); // 窗口内：挂起
  th.handle("s1", "tc1", ev("abc")); // 覆盖挂起
  expect(sent.map((e) => e.output)).toEqual(["a"]);
  clock.advance(50);
  expect(sent.map((e) => e.output)).toEqual(["a", "abc"]);
});

test("fleet 并行：同 toolCallId 不同 taskIndex 各自独立节流", () => {
  const sent: Array<[string, SubagentProgressEvent]> = [];
  const clock = fakeClock();
  const th = new SubagentProgressThrottle((s, t, e) => sent.push([`${s}/${t}`, e]), { ...clock });
  th.handle("s1", "tc1", ev("a0", { taskIndex: 0 }));
  th.handle("s1", "tc1", ev("b0", { taskIndex: 1 }));
  // 两个键各自首帧立即发
  expect(sent.map(([, e]) => e.output)).toEqual(["a0", "b0"]);
  th.handle("s1", "tc1", ev("a1", { taskIndex: 0 }));
  th.handle("s1", "tc1", ev("b1", { taskIndex: 1 }));
  clock.advance(50);
  expect(sent.map(([, e]) => e.output)).toEqual(["a0", "b0", "a1", "b1"]);
});

test("终态立即透传：先冲刷挂起帧保序，再发终态", () => {
  const sent: SubagentProgressEvent[] = [];
  const clock = fakeClock();
  const th = new SubagentProgressThrottle((_s, _t, e) => sent.push(e), { ...clock });
  th.handle("s1", "tc1", ev("a"));
  th.handle("s1", "tc1", ev("ab")); // 挂起
  th.handle("s1", "tc1", ev("ab", { status: "done" }));
  expect(sent.map((e) => `${e.output}:${e.status}`)).toEqual(["a:running", "ab:running", "ab:done"]);
});

test("窗口外（间隔 >= 50ms）立即发", () => {
  const sent: SubagentProgressEvent[] = [];
  const clock = fakeClock();
  const th = new SubagentProgressThrottle((_s, _t, e) => sent.push(e), { ...clock });
  th.handle("s1", "tc1", ev("a"));
  clock.advance(60);
  th.handle("s1", "tc1", ev("ab"));
  expect(sent).toHaveLength(2);
});
