// cache_warm 用量归属回执（锁 pi 1.5.2 × kernel computeSessionUsage 行为）。
//
// 背景（pi 1.5.2 实证）：cacheWarming 默认 idle（settings-defaults.js:60），
// 空闲期续缓存每次成功刷新经 sessionManager.appendUsage("cache_warm", ...) 落一条
// {"type":"usage","kind":"cache_warm","provider","model","usage"} 条目。
// kernel 的 computeSessionUsage（session-history.ts）按「pi 0.86+ usage 条目官方计入
// session totals」的口径把 type==="usage" 条目归主代理——本文件锁住这条归属契约，
// 防止后续升级把 idle 预热的成本错归（漏算成空会话或算进子代理）。
//
// 夹具 jsonl 按 pi 真实条目形态构造（appendUsage 的字段集：type/kind/provider/
// model/usage；assistant 行按 message 条目形态），临时文件 afterEach 统一清理。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeSessionUsage } from "../src/session-history";

// 本文件建的临时目录（用例结束后统一清理，不往系统 tmp 里扔垃圾）
const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

async function writeSessionJsonl(lines: object[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cache-warm-acct-"));
  tempDirs.push(dir);
  const file = join(dir, "session.jsonl");
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

/** pi 1.5.2 appendUsage("cache_warm", ...) 落盘的真实条目形态（id/parentId 略） */
function cacheWarmEntry(usage: Record<string, number>) {
  return {
    type: "usage",
    timestamp: "2026-11-11T00:00:00.000Z",
    kind: "cache_warm",
    provider: "volcengine",
    model: "test-model",
    usage,
  };
}

describe("computeSessionUsage 的 cache_warm 用量归属", () => {
  test("assistant usage + cache_warm usage 并存：main 累加两者，subagent 为 0", async () => {
    const file = await writeSessionJsonl([
      {
        type: "message",
        message: {
          role: "assistant",
          provider: "volcengine",
          model: "test-model",
          usage: { input: 100, output: 50, cacheRead: 200, cacheWrite: 10 },
        },
      },
      cacheWarmEntry({ input: 0, output: 0, cacheRead: 300, cacheWrite: 0 }),
    ]);
    const result = await computeSessionUsage(file);
    // main = 两条 usage 之和（idle 预热的成本计入主代理累计）
    expect(result.main).toEqual({
      input: 100,
      output: 50,
      cacheRead: 500,
      cacheWrite: 10,
      total: 660, // input + output + cacheRead + cacheWrite
    });
    // cache_warm 属主代理预热，不是子代理消耗
    expect(result.subagent).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    });
  });

  test("只有 cache_warm 条目：不判成空会话（不抛 session.noValidLines），main 为其用量", async () => {
    const file = await writeSessionJsonl([
      cacheWarmEntry({ input: 5, output: 0, cacheRead: 400, cacheWrite: 20 }),
    ]);
    // 空闲预热后未发起对话的会话：usage 条目也算有效行，不得抛 session.noValidLines
    const result = await computeSessionUsage(file);
    expect(result.main).toEqual({
      input: 5,
      output: 0,
      cacheRead: 400,
      cacheWrite: 20,
      total: 425,
    });
    expect(result.subagent.total).toBe(0);
  });
});
