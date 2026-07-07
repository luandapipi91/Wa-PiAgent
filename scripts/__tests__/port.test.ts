import { test, expect } from "bun:test";
import { killPort, findPidOnPort, isPortInUse } from "../port";
import { createServer } from "node:net";

test("findPidOnPort 在无占用端口返回 null", async () => {
  const pid = await findPidOnPort(19999);  // 极可能空闲的高端口
  expect(pid).toBeNull();
});

test("killPort 对无占用端口不抛错", async () => {
  await expect(killPort(19998)).resolves.toBeUndefined();
});

test("isPortInUse 正确检测占用与空闲", async () => {
  // 起一个占 19997 的监听
  const server = createServer();
  await new Promise<void>((r) => server.listen(19997, () => r()));
  expect(await isPortInUse(19997)).toBe(true);   // 被占
  expect(await isPortInUse(19996)).toBe(false);  // 空闲
  await new Promise<void>((r) => server.close(() => r()));
  expect(await isPortInUse(19997)).toBe(false);  // 关闭后空闲
});

test("findPidOnPort 能拿到占用进程的 PID", async () => {
  const server = createServer();
  await new Promise<void>((r) => server.listen(19995, () => r()));
  const pid = await findPidOnPort(19995);
  expect(pid).not.toBeNull();   // 占用时能解析出 PID
  expect(typeof pid).toBe("number");
  await new Promise<void>((r) => server.close(() => r()));
});
