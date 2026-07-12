import { test, expect } from "bun:test";
import { createServer } from "node:net";
import { waitForPort } from "../src/util/port.cjs";

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
