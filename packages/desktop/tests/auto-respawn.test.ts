import { test, expect } from "bun:test";
import { shouldRespawn, MAX_RESPAWN, RESPAWN_DELAY_MS } from "../src/util/auto-respawn.cjs";

// auto-respawn：kernel sidecar 崩溃（被信号杀 code=null）后自动重启的决策逻辑。
// 历史 bug：kernel 崩溃后 kernel-sidecar.cjs 只 log 不重启，前端永远卡"连接已断开"。

// RespawnState 形状（cjs 无 TS 类型，本地定义）
interface RespawnState { stopped: boolean; attempts: number; }

function freshState(): RespawnState {
  return { stopped: false, attempts: 0 };
}

test("shouldRespawn: code=null 且未主动停止 → 应重启", () => {
  expect(shouldRespawn(null, freshState())).toBe(true);
});

test("shouldRespawn: code=0（正常退出）→ 不重启", () => {
  expect(shouldRespawn(0, freshState())).toBe(false);
});

test("shouldRespawn: 已主动 stop() → 不重启（即使命令崩溃）", () => {
  const s = freshState();
  s.stopped = true;
  expect(shouldRespawn(null, s)).toBe(false);
});

test("shouldRespawn: 达到 MAX_RESPAWN 上限 → 不再重启", () => {
  const s = freshState();
  s.attempts = MAX_RESPAWN;
  expect(shouldRespawn(null, s)).toBe(false);
});

test("shouldRespawn: 重启次数未达上限 → 继续重启", () => {
  const s = freshState();
  s.attempts = MAX_RESPAWN - 1;
  expect(shouldRespawn(null, s)).toBe(true);
});

test("常量: MAX_RESPAWN 为正整数，退避延迟为正数", () => {
  expect(MAX_RESPAWN).toBeGreaterThan(0);
  expect(RESPAWN_DELAY_MS).toBeGreaterThan(0);
});
