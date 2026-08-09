// streaming 渲染 rAF 合帧器单测（阶段一·卡顿修复项 2）
// message_update 每 token delta 触发一次 zustand set → React 重渲染；
// 合帧器把一帧内的多次更新合并为一次提交（取最新）。
import { test, expect } from "bun:test";
import { StreamingBatcher } from "../src/store/streaming-batcher";

/** 手动推进的假 rAF：队列里的回调只有 advance() 时才执行 */
function fakeRaf() {
  const queue: (() => void)[] = [];
  return {
    schedule: (fn: () => void) => { queue.push(fn); return fn; },
    cancel: (h: any) => { const i = queue.indexOf(h); if (i >= 0) queue.splice(i, 1); },
    advance() { const q = queue.splice(0); for (const fn of q) fn(); },
    get pendingCount() { return queue.length; },
  };
}

test("一帧内多次 update 只提交一次，取最新值", () => {
  const commits: [string, any][] = [];
  const raf = fakeRaf();
  const b = new StreamingBatcher((sid, v) => commits.push([sid, v]), raf.schedule, raf.cancel);
  b.update("s1", { message: "a", agentName: "dev" });
  b.update("s1", { message: "ab", agentName: "dev" });
  b.update("s1", { message: "abc", agentName: "dev" });
  expect(commits).toHaveLength(0); // 帧内不提交
  raf.advance();
  expect(commits).toHaveLength(1);
  expect(commits[0][1].message).toBe("abc");
});

test("不同 session 在同一帧内各自提交一次", () => {
  const commits: [string, any][] = [];
  const raf = fakeRaf();
  const b = new StreamingBatcher((sid, v) => commits.push([sid, v]), raf.schedule, raf.cancel);
  b.update("s1", { message: "a", agentName: "dev" });
  b.update("s2", { message: "x", agentName: "dev" });
  raf.advance();
  expect(commits).toHaveLength(2);
  expect(commits.map(([sid]) => sid).sort()).toEqual(["s1", "s2"]);
});

test("跨帧的 update 各自提交", () => {
  const commits: [string, any][] = [];
  const raf = fakeRaf();
  const b = new StreamingBatcher((sid, v) => commits.push([sid, v]), raf.schedule, raf.cancel);
  b.update("s1", { message: "a", agentName: "dev" });
  raf.advance();
  b.update("s1", { message: "ab", agentName: "dev" });
  raf.advance();
  expect(commits).toHaveLength(2);
});

test("drop 丢弃该 session 挂起帧，后续帧不再提交（防止 message_end 后旧 partial 复活）", () => {
  const commits: [string, any][] = [];
  const raf = fakeRaf();
  const b = new StreamingBatcher((sid, v) => commits.push([sid, v]), raf.schedule, raf.cancel);
  b.update("s1", { message: "a", agentName: "dev" });
  b.update("s2", { message: "x", agentName: "dev" });
  b.drop("s1");
  raf.advance();
  expect(commits).toHaveLength(1);
  expect(commits[0][0]).toBe("s2");
});
