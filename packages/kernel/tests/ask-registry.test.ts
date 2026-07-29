import { test, expect, beforeEach } from "bun:test";
import { askRegistry } from "../src/ask-registry";
import type { AskParams } from "@wa-pi/shared";

const params: AskParams = { questions: [
  { question: "Q?", header: "h", options: [{ label: "A", description: "x" }, { label: "B", description: "y" }] },
] };
const reply = { replies: [{ questionIndex: 0, selected: ["A"] }] };

beforeEach(() => askRegistry.reset());

test("ask → resolve 返回 answers（cancelled=false）", async () => {
  const ctrl = new AbortController();
  const p = askRegistry.ask("s1", "tc1", params, ctrl.signal);
  askRegistry.resolve("s1", "tc1", reply);
  const r = await p;
  expect(r.cancelled).toBe(false);
  expect(r.answers).toHaveLength(1);
  expect(r.answers![0]).toMatchObject({ kind: "option", answer: "A" });
});

test("ask → cancel 返回 cancelled=true", async () => {
  const ctrl = new AbortController();
  const p = askRegistry.ask("s1", "tc1", params, ctrl.signal);
  askRegistry.cancel("s1", "tc1");
  expect((await p).cancelled).toBe(true);
});

test("abort signal 触发 → cancelled=true", async () => {
  const ctrl = new AbortController();
  const p = askRegistry.ask("s1", "tc1", params, ctrl.signal);
  ctrl.abort();
  expect((await p).cancelled).toBe(true);
});

test("resolve / cancel 对未知或已解决 toolCallId 幂等 no-op", () => {
  // 不应抛错
  askRegistry.resolve("unknown", "tc", reply);
  askRegistry.cancel("unknown", "tc");
  // 已解决再 resolve/cancel 无副作用
  const ctrl = new AbortController();
  const p = askRegistry.ask("s1", "tc1", params, ctrl.signal);
  askRegistry.resolve("s1", "tc1", reply);
  askRegistry.resolve("s1", "tc1", reply);  // 重复
  askRegistry.cancel("s1", "tc1");
  return expect(p).resolves.toMatchObject({ cancelled: false });
});

test("cancelAll 取消该 session 全部 pending（不影响其它 session）", async () => {
  const c1 = new AbortController(), c2 = new AbortController();
  const pA = askRegistry.ask("s1", "a", params, c1.signal);
  const pB = askRegistry.ask("s1", "b", params, c2.signal);
  const pC = askRegistry.ask("s2", "c", params, new AbortController().signal);
  askRegistry.cancelAll("s1");
  expect((await pA).cancelled).toBe(true);
  expect((await pB).cancelled).toBe(true);
  // s2 不受影响，仍可正常 resolve
  askRegistry.resolve("s2", "c", reply);
  expect((await pC).cancelled).toBe(false);
});

test("同 session 并发多个 toolCallId 互不干扰", async () => {
  const a = askRegistry.ask("s1", "a", params, new AbortController().signal);
  const b = askRegistry.ask("s1", "b", params, new AbortController().signal);
  askRegistry.resolve("s1", "b", reply);
  expect((await b).cancelled).toBe(false);
  askRegistry.cancel("s1", "a");
  expect((await a).cancelled).toBe(true);
});

test("预 aborted signal：ask 立即返回 cancelled 且不留残留 entry", async () => {
  const ctrl = new AbortController();
  ctrl.abort();  // 预先 abort
  const p = askRegistry.ask("s1", "tc1", params, ctrl.signal);
  expect((await p).cancelled).toBe(true);
  // 预 aborted 时 entry 应已从 map 移除——同 id 再 resolve 必须是 no-op，
  // 否则说明残留了一个 done:true 的 entry（泄漏）。
  expect(() => askRegistry.resolve("s1", "tc1", reply)).not.toThrow();
  // 再次 ask 同 id 应能正常 resolve（说明前一个 entry 已被清理）
  const p2 = askRegistry.ask("s1", "tc1", params, new AbortController().signal);
  askRegistry.resolve("s1", "tc1", reply);
  expect((await p2).cancelled).toBe(false);
});
