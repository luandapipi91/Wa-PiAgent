import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  browserSessionName,
  closeBrowserSession,
  resolveAgentBrowserBinary,
} from "../agent-browser-session";

test("会话名归一化", () => {
  expect(browserSessionName("550e8400-e29b-41d4-a716-446655440000")).toBe(
    "550e8400-e29b-41d4-a716-446655440000",
  );
  expect(browserSessionName("sched-task:1/2")).toBe("sched-task_1_2");
  expect(browserSessionName("")).toBe("wa-pi");
});

test("平台包解析", () => {
  const exists = () => true;
  // 期望值用 join 构造：被测函数返回宿主分隔符的文件系统路径，这里只验证
  // 「平台 → 包名 → 可执行文件名」的映射，不绑定某一种分隔符（Windows 下 join 为反斜杠）
  const expectBin = (pkg: string, bin: string) =>
    join("/r", "node_modules", "@agent-browser", pkg, "bin", bin);
  expect(
    resolveAgentBrowserBinary({ runtimeDir: "/r", platform: "darwin", arch: "x64", fileExists: exists }),
  ).toBe(expectBin("cli-darwin-x64", "agent-browser"));
  expect(
    resolveAgentBrowserBinary({ runtimeDir: "/r", platform: "win32", arch: "x64", fileExists: exists }),
  ).toBe(expectBin("cli-win32-x64-msvc", "agent-browser.exe"));
  expect(
    resolveAgentBrowserBinary({ runtimeDir: "/r", platform: "linux", arch: "x64", fileExists: exists }),
  ).toBe(expectBin("cli-linux-x64-gnu", "agent-browser"));
});

test("二进制缺失返回 null", () => {
  expect(
    resolveAgentBrowserBinary({ runtimeDir: "/r", platform: "darwin", arch: "x64", fileExists: () => false }),
  ).toBeNull();
});

test("close 使用 --session 且失败不抛", async () => {
  const calls: string[][] = [];
  const fakeSpawn = ((_cmd: string, args: string[]) => {
    calls.push(args);
    return { unref: () => {}, kill: () => {} };
  }) as never;
  await closeBrowserSession("/bin/ab", "s1", { spawn: fakeSpawn });
  expect(calls[0]).toEqual(["--session", "s1", "close"]);
  await expect(closeBrowserSession(null, "s1")).resolves.toBeUndefined();
});
