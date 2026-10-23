// startup-heal 单元测试：attemptSelfHeal 全程依赖注入（fake isPortInUse / fake killPortOccupants /
// fake sweepRegistry），绝不真杀进程、绝不真探端口、绝不真等（waitMs 传 0）。
// 覆盖：第 1 轮即释放 / 第 2 轮释放 / 轮尽仍占（默认 3 轮）/ 从未被占 四条路径，
// 并断言清理次数与轮次严格对应、每轮结果均记 log。
import { test, expect } from "bun:test";
import { attemptSelfHeal } from "../src/util/startup-heal.cjs";

/**
 * 构造测试夹具：occupancy 依次作为每次 isPortInUse 的返回值（越界取最后一个，便于"恒占/恒空"）。
 * 统计 killPortOccupants / sweepRegistry 调用次数，收集 log 消息。
 */
function makeHealHarness(occupancy: boolean[]) {
  const state = { kills: 0, sweeps: 0, logs: [] as string[] };
  let call = 0;
  const isPortInUse = (async () => {
    const v = occupancy[Math.min(call, occupancy.length - 1)];
    call++;
    return v;
  }) as any;
  const killPortOccupants = (async () => {
    state.kills++;
  }) as any;
  const sweepRegistry = () => {
    state.sweeps++;
  };
  return {
    deps: {
      isPortInUse,
      killPortOccupants,
      sweepRegistry,
      waitMs: 0,
      log: (m: string) => state.logs.push(m),
    } as any,
    get kills() {
      return state.kills;
    },
    get sweeps() {
      return state.sweeps;
    },
    get logs() {
      return state.logs;
    },
  };
}

test("第 1 轮即释放：healed:true 且只清 1 次", async () => {
  // round1：查端口(占) → 清理 → 等 → 复查(释放)
  const h = makeHealHarness([true, false]);
  const r = await attemptSelfHeal(h.deps);
  expect(r).toEqual({ healed: true });
  expect(h.kills).toBe(1);
  expect(h.sweeps).toBe(1);
  expect(h.logs.length).toBeGreaterThan(0); // 每轮结果记 log
});

test("第 2 轮释放：healed:true 且清 2 次", async () => {
  // round1：查(占) → 清 → 等 → 复查(仍占)；round2：查(占) → 清 → 等 → 复查(释放)
  const h = makeHealHarness([true, true, true, false]);
  const r = await attemptSelfHeal(h.deps);
  expect(r).toEqual({ healed: true });
  expect(h.kills).toBe(2);
  expect(h.sweeps).toBe(2);
});

test("轮尽仍占（默认 3 轮）：healed:false 且清 3 次", async () => {
  // 不传 rounds，验证默认 3 轮；round1-3 每轮 查(占)→清→等→复查(仍占)
  const h = makeHealHarness([true, true, true, true, true, true]);
  const r = await attemptSelfHeal(h.deps);
  expect(r).toEqual({ healed: false });
  expect(h.kills).toBe(3);
  expect(h.sweeps).toBe(3);
  expect(h.logs.length).toBeGreaterThanOrEqual(3); // 每轮至少记 1 条
});

test("端口从未被占：不调用清理直接 healed:true", async () => {
  const h = makeHealHarness([false]);
  const r = await attemptSelfHeal(h.deps);
  expect(r).toEqual({ healed: true });
  expect(h.kills).toBe(0);
  expect(h.sweeps).toBe(0);
  expect(h.logs.length).toBeGreaterThan(0); // 结果同样记 log
});
