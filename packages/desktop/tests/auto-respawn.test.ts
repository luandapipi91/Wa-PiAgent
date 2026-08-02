import { test, expect } from "bun:test";
import { shouldRespawn, RESPAWN_DELAY_MS } from "../src/util/auto-respawn.cjs";

// auto-respawn：kernel sidecar 崩溃（被信号杀 code=null）后自动重启的决策逻辑。
// 策略：无限重启 + 固定间隔。attempts 仅用于日志，不再拦截。

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

test("shouldRespawn: 无限重启——attempts 任意大仍重启", () => {
  const s = freshState();
  s.attempts = 999;
  expect(shouldRespawn(null, s)).toBe(true);
});

test("shouldRespawn: code=1（Windows 强杀实测）→ 应重启", () => {
  expect(shouldRespawn(1, freshState())).toBe(true);
});

test("shouldRespawn: code>0（异常退出）→ 应重启", () => {
  expect(shouldRespawn(5, freshState())).toBe(true);
});

test("常量: RESPAWN_DELAY_MS 锁定精确值（固定间隔 2s）", () => {
  expect(RESPAWN_DELAY_MS).toBe(2000);
});
