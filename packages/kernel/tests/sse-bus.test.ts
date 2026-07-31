import { test, expect } from "bun:test";
import { SseBus } from "../src/sse-bus";

// 回归：流式输出中某帧 payload 含 BigInt（部分 provider 的 token usage）或循环引用
// （工具调用结果）时，原实现 sse-bus.ts:35 的 JSON.stringify 在 try/catch 之外，
// 同步抛 TypeError 沿 onEvent→broadcast 链无兜底冒泡，被 Bun 视为未捕获异常杀死
// kernel 进程（日志 退出 code=null）。broadcast 必须对任何 data 都不抛。
test("broadcast: 普通 data 正常广播", () => {
  const bus = new SseBus();
  const frames: string[] = [];
  bus.add((c) => frames.push(c));
  bus.broadcast("test", { type: "ping", n: 1 });
  expect(frames.length).toBe(1);
  expect(frames[0]).toContain('"type":"ping"');
});

test("broadcast: 含 BigInt 的 data 不抛，转字符串后广播", () => {
  const bus = new SseBus();
  const frames: string[] = [];
  bus.add((c) => frames.push(c));
  // BigInt 在 JSON.stringify 默认会抛 TypeError: Do not know how to serialize a BigInt
  expect(() => bus.broadcast("test", { usage: { tokens: 123n } })).not.toThrow();
  expect(frames.length).toBe(1);
  // BigInt 应被安全 replacer 转成字符串
  expect(frames[0]).toContain('"123"');
});

test("broadcast: 含循环引用的 data 不抛，无法序列化时丢帧不杀进程", () => {
  const bus = new SseBus();
  const frames: string[] = [];
  bus.add((c) => frames.push(c));
  const cyclic: any = { type: "bad" };
  cyclic.self = cyclic; // 循环引用，JSON.stringify 抛 TypeError
  expect(() => bus.broadcast("test", cyclic)).not.toThrow();
  // 无法安全序列化的帧应被丢弃（不广播），但绝不抛异常
  expect(frames.length).toBe(0);
});

test("broadcast: 序列化失败不影响后续正常帧", () => {
  const bus = new SseBus();
  const frames: string[] = [];
  bus.add((c) => frames.push(c));
  const cyclic: any = { type: "bad" };
  cyclic.self = cyclic;
  bus.broadcast("test", cyclic);   // 丢帧
  bus.broadcast("test", { type: "good" }); // 正常
  expect(frames.length).toBe(1);
  expect(frames[0]).toContain('"good"');
});
