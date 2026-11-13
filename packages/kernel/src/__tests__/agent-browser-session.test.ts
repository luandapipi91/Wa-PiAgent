import { expect, test } from "bun:test";
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
  expect(
    resolveAgentBrowserBinary({ runtimeDir: "/r", platform: "darwin", arch: "x64", fileExists: exists }),
  ).toBe("/r/node_modules/@agent-browser/cli-darwin-x64/bin/agent-browser");
  expect(
    resolveAgentBrowserBinary({ runtimeDir: "/r", platform: "win32", arch: "x64", fileExists: exists }),
  ).toBe("/r/node_modules/@agent-browser/cli-win32-x64-msvc/bin/agent-browser.exe");
  expect(
    resolveAgentBrowserBinary({ runtimeDir: "/r", platform: "linux", arch: "x64", fileExists: exists }),
  ).toBe("/r/node_modules/@agent-browser/cli-linux-x64-gnu/bin/agent-browser");
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
