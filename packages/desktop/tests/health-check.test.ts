import { test, expect } from "bun:test";
import { createServer } from "node:net";
import {
  updateHealthState,
  checkPort,
  HEALTH_FAIL_THRESHOLD,
  HEALTH_CHECK_INTERVAL_MS,
  HEALTH_CHECK_TIMEOUT_MS,
} from "../src/util/health-check.cjs";
import { findAvailablePort } from "../src/util/port.cjs";

// health-check：端口探活状态机。
// 连续失败达到阈值才判定「挂了」（规避瞬时抖动）；健康立即重置；stopped 永不触发重启。

interface HealthState { failures: number; failThreshold: number; stopped: boolean; }

function freshState(): HealthState {
  return { failures: 0, failThreshold: HEALTH_FAIL_THRESHOLD, stopped: false };
}

test("updateHealthState: 健康 → 重置失败计数且不重启", () => {
  const s = freshState();
  s.failures = 2;
  expect(updateHealthState(s, true)).toEqual({ shouldRestart: false, failures: 0 });
});

test("updateHealthState: 连续失败未达阈值 → 计数增加但不重启", () => {
  const s = freshState();
  const r = updateHealthState(s, false);
  expect(r.shouldRestart).toBe(false);
  expect(r.failures).toBe(1);
});

test("updateHealthState: 连续失败达到阈值 → 触发重启并重置计数", () => {
  const s = freshState();
  s.failures = HEALTH_FAIL_THRESHOLD - 1;
  const r = updateHealthState(s, false);
  expect(r.shouldRestart).toBe(true);
  expect(r.failures).toBe(0);
});

test("updateHealthState: 已停止 → 永不触发重启（失败计数保留）", () => {
  const s = freshState();
  s.stopped = true;
  s.failures = HEALTH_FAIL_THRESHOLD;
  const r = updateHealthState(s, false);
  expect(r.shouldRestart).toBe(false);
  expect(r.failures).toBe(HEALTH_FAIL_THRESHOLD);
});

test("checkPort: 端口被监听（健康）→ true", async () => {
  const server = createServer();
  // 注：isPortInUse 探测时绑定所有接口（server.listen(port)），
  // Windows 下通配符绑定与特定地址(127.0.0.1)绑定可共存、探测不到，故此处同样绑定所有接口（与 port.cjs.test.ts 惯例一致）。
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  try {
    expect(await checkPort(port)).toBe(true);
  } finally {
    server.close();
  }
});

test("checkPort: 端口未监听（挂了）→ false", async () => {
  const freePort = await findAvailablePort(50000);
  expect(await checkPort(freePort)).toBe(false);
});

test("常量: 探活间隔/失败阈值/单次探测超时锁定精确值", () => {
  expect(HEALTH_CHECK_INTERVAL_MS).toBe(5000);
  expect(HEALTH_FAIL_THRESHOLD).toBe(3);
  expect(HEALTH_CHECK_TIMEOUT_MS).toBe(2000);
});
