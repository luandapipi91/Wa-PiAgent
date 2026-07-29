import { test, expect, mock } from "bun:test";
import { createServer } from "node:net";
import { waitForPort, findAvailablePort, killPortOccupants } from "../src/util/port.cjs";

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

test("killPortOccupants: mac/linux 用 lsof 取 PID 后 kill -9", () => {
  if (process.platform === "win32") return; // 仅测 unix 分支
  const calls: { cmd: string; args: string[] }[] = [];
  const fakeSpawn = mock((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    // lsof 返回两个 PID
    if (cmd === "lsof") return { stdout: "1111\n2222\n", status: 0 };
    return { stdout: "", status: 0 };
  }) as any;
  const pids = killPortOccupants(9776, fakeSpawn);
  // 一次 lsof 查询 + 两次 kill
  expect(calls[0]).toEqual({ cmd: "lsof", args: ["-ti:9776"] });
  expect(calls.some((c) => c.cmd === "kill" && c.args.includes("1111"))).toBe(true);
  expect(calls.some((c) => c.cmd === "kill" && c.args.includes("2222"))).toBe(true);
  expect(pids).toEqual([1111, 2222]);
});

test("killPortOccupants: 端口无占用时返回空数组（unix）", () => {
  if (process.platform === "win32") return;
  const fakeSpawn = mock(() => ({ stdout: "", status: 0 })) as any;
  const pids = killPortOccupants(9776, fakeSpawn);
  expect(pids).toEqual([]);
});

test("killPortOccupants: windows 用 netstat 解析 PID 后 taskkill", () => {
  if (process.platform !== "win32") return; // 仅测 win 分支
  const calls: { cmd: string; args: string[] }[] = [];
  const fakeSpawn = mock((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    if (cmd === "netstat") {
      return {
        stdout: "  TCP    127.0.0.1:9776   0.0.0.0:0  LISTENING  3333\r\n  TCP    0.0.0.0:9777  0.0.0.0:0  LISTENING  9999\r\n",
        status: 0,
      };
    }
    return { stdout: "", status: 0 };
  }) as any;
  const pids = killPortOccupants(9776, fakeSpawn);
  // 只杀 9776 对应的 3333，不杀 9777 的 9999
  expect(pids).toEqual([3333]);
  expect(calls.some((c) => c.cmd === "taskkill" && c.args.includes("3333"))).toBe(true);
  expect(calls.some((c) => c.cmd === "taskkill" && c.args.includes("9999"))).toBe(false);
});
