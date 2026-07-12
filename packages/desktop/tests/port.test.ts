import { test, expect } from "bun:test";
import { createServer } from "node:net";
import { isPortInUse } from "../src/util/port";

test("isPortInUse: 空闲端口返回 false", async () => {
  expect(await isPortInUse(59999)).toBe(false);
});

test("isPortInUse: 被监听端口返回 true", async () => {
  const s = createServer();
  await new Promise<void>(r => s.listen(59998, r));
  expect(await isPortInUse(59998)).toBe(true);
  await new Promise<void>(r => s.close(() => r()));
});
