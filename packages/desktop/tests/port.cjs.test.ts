import { test, expect } from "bun:test";
import { createServer } from "node:net";
import { waitForPort, findAvailablePort } from "../src/util/port.cjs";

test("waitForPort: 端口起来后 resolve true", async () => {
  const s = createServer();
  await new Promise<void>((r) => s.listen(59997, r));
  const ok = await waitForPort(59997, 2000);
  expect(ok).toBe(true);
  await new Promise<void>((r) => s.close(() => r()));
});

test("waitForPort: 超时 resolve false", async () => {
  const ok = await waitForPort(59996, 500); // 没人监听
  expect(ok).toBe(false);
});

test("findAvailablePort: 起始端口空闲时返回该端口", async () => {
  const port = await findAvailablePort(59995);
  expect(port).toBe(59995);
});

test("findAvailablePort: 起始端口被占用时返回下一个可用端口", async () => {
  const s = createServer();
  await new Promise<void>((r) => s.listen(59993, r));
  try {
    const port = await findAvailablePort(59993, 5);
    expect(port).toBeGreaterThan(59993);
  } finally {
    await new Promise<void>((r) => s.close(() => r()));
  }
});
