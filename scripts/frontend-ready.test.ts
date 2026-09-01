// frontend-ready 单元测试:mock fetchImpl,不依赖真实端口/网络
import { describe, test, expect } from "bun:test";
import { isFrontendReady, waitFrontendReady } from "./frontend-ready";

/** 由简化 impl 构造类型干净的 fetch mock */
const makeFetch = (impl: (url: string) => Promise<Response>): typeof fetch =>
  ((input: RequestInfo | URL) => impl(String(input))) as typeof fetch;

const okFetch = makeFetch(async () => new Response("ok"));
const failFetch = makeFetch(async () => {
  throw new Error("ECONNREFUSED");
});

describe("isFrontendReady", () => {
  test("HTTP 有响应 → 就绪", async () => {
    expect(await isFrontendReady(5180, okFetch)).toBe(true);
  });

  test("连接拒绝 → 未就绪", async () => {
    expect(await isFrontendReady(5180, failFetch)).toBe(false);
  });

  test("探测 URL 指向 localhost 目标端口", async () => {
    let seen = "";
    await isFrontendReady(
      5180,
      makeFetch(async (url) => {
        seen = url;
        return new Response("ok");
      }),
    );
    expect(seen).toBe("http://localhost:5180/");
  });
});

describe("waitFrontendReady", () => {
  test("前几次失败后成功 → 返回 true,不等满超时", async () => {
    let calls = 0;
    const flaky = makeFetch(async () => {
      if (++calls < 3) throw new Error("not yet");
      return new Response("ok");
    });
    const t0 = Date.now();
    const ok = await waitFrontendReady(5180, {
      timeoutMs: 5000,
      intervalMs: 10,
      fetchImpl: flaky,
    });
    expect(ok).toBe(true);
    expect(calls).toBe(3);
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  test("一直失败 → 超时返回 false,onPoll 有回调", async () => {
    let polls = 0;
    const ok = await waitFrontendReady(5180, {
      timeoutMs: 120,
      intervalMs: 30,
      fetchImpl: failFetch,
      onPoll: () => polls++,
    });
    expect(ok).toBe(false);
    expect(polls).toBeGreaterThan(0);
  });

  test("onPoll 入参为已耗时毫秒", async () => {
    const seen: number[] = [];
    await waitFrontendReady(5180, {
      timeoutMs: 100,
      intervalMs: 25,
      fetchImpl: failFetch,
      onPoll: (ms) => seen.push(ms),
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBeLessThan(200);
  });
});
