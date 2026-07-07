import { test, expect } from "bun:test";
import { killPort, findPidOnPort } from "../port";

test("findPidOnPort 在无占用端口返回 null", async () => {
  const pid = await findPidOnPort(19999);  // 极可能空闲的高端口
  expect(pid).toBeNull();
});

test("killPort 对无占用端口不抛错", async () => {
  await expect(killPort(19998)).resolves.toBeUndefined();
});
