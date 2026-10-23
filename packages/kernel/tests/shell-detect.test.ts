import { test, expect } from "bun:test";
import { detectBash, isBashAvailable } from "../src/shell-detect";

// 探测顺序与 pi 引擎一致（pi-coding-agent dist/utils/shell.js 的 getBashShellConfig）：
//   1. Git Bash 已知安装目录：%ProgramFiles%\Git\bin\bash.exe、%ProgramFiles(x86)%\Git\bin\bash.exe
//   2. PATH 上的 bash.exe（Cygwin / MSYS2 / WSL 等）
// 顺序是关键：若我们判定「有 bash」而引擎找不到，默认启用 bash 工具会让每次命令执行报错。

test("非 win32：直接视为可用（POSIX 系统自带 shell）", () => {
  expect(detectBash({ platform: "darwin" })).toBe("bash");
  expect(detectBash({ platform: "linux" })).toBe("bash");
  expect(isBashAvailable({ platform: "darwin" })).toBe(true);
});

test("win32：Git Bash 已知安装目录命中 → 可用（PATH 无需含 bash）", () => {
  const hit = "C:\\Program Files\\Git\\bin\\bash.exe";
  expect(
    detectBash({
      platform: "win32",
      env: { ProgramFiles: "C:\\Program Files" },
      pathExists: (p) => p === hit,
      which: () => null,
    }),
  ).toBe(hit);
});

test("win32：ProgramFiles(x86) 下的 Git Bash 也能命中", () => {
  const hit = "C:\\Program Files (x86)\\Git\\bin\\bash.exe";
  expect(
    detectBash({
      platform: "win32",
      env: { "ProgramFiles(x86)": "C:\\Program Files (x86)" },
      pathExists: (p) => p === hit,
      which: () => null,
    }),
  ).toBe(hit);
});

test("win32：PATH 上的 bash.exe 命中 → 可用（Cygwin / MSYS2 / WSL）", () => {
  const hit = "C:\\msys64\\usr\\bin\\bash.exe";
  expect(
    detectBash({
      platform: "win32",
      env: {},
      pathExists: () => false,
      which: (cmd) => (cmd === "bash.exe" ? hit : null),
    }),
  ).toBe(hit);
});

test("win32：两处都未命中 → 不可用", () => {
  expect(
    detectBash({
      platform: "win32",
      env: { ProgramFiles: "C:\\Program Files" },
      pathExists: () => false,
      which: () => null,
    }),
  ).toBeNull();
  expect(
    isBashAvailable({
      platform: "win32",
      env: {},
      pathExists: () => false,
      which: () => null,
    }),
  ).toBe(false);
});

test("win32：ProgramFiles 缺失时只查 PATH，不拼出相对路径", () => {
  const seen: string[] = [];
  detectBash({
    platform: "win32",
    env: {},
    pathExists: (p) => {
      seen.push(p);
      return false;
    },
    which: () => null,
  });
  expect(seen).toHaveLength(0);
});
