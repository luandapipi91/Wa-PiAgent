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

test("win32：环境变量缺失时不拼出相对路径（硬编码候选均为绝对盘符路径）", () => {
  const seen: string[] = [];
  detectBash({
    platform: "win32",
    env: {},
    pathExists: (p) => {
      seen.push(p);
      return false;
    },
    which: () => null,
    readGitInstallPath: () => null,
  });
  // 只剩 MSYS2 / Cygwin 两个硬编码候选，都必须是绝对路径
  expect(seen.length).toBeGreaterThan(0);
  for (const p of seen) expect(p).toMatch(/^[A-Za-z]:\\/);
});

test("win32：Git 用户级安装（%LOCALAPPDATA%\\Programs\\Git）命中", () => {
  const hit = "C:\\Users\\co\\AppData\\Local\\Programs\\Git\\bin\\bash.exe";
  expect(
    detectBash({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\co\\AppData\\Local" },
      pathExists: (p) => p === hit,
      which: () => null,
    }),
  ).toBe(hit);
});

test("win32：MSYS2 / Cygwin 默认安装目录命中（未加 PATH 也能发现）", () => {
  expect(
    detectBash({
      platform: "win32",
      env: {},
      pathExists: (p) => p === "C:\\msys64\\usr\\bin\\bash.exe",
      which: () => null,
    }),
  ).toBe("C:\\msys64\\usr\\bin\\bash.exe");
  expect(
    detectBash({
      platform: "win32",
      env: {},
      pathExists: (p) => p === "C:\\cygwin64\\bin\\bash.exe",
      which: () => null,
    }),
  ).toBe("C:\\cygwin64\\bin\\bash.exe");
});

test("win32：注册表 InstallPath 命中（Git 装在非标准盘）且优先于 ProgramFiles", () => {
  const regHit = "D:\\Tools\\Git\\bin\\bash.exe";
  expect(
    detectBash({
      platform: "win32",
      env: { ProgramFiles: "C:\\Program Files" },
      pathExists: (p) =>
        p === regHit || p === "C:\\Program Files\\Git\\bin\\bash.exe",
      which: () => null,
      readGitInstallPath: () => "D:\\Tools\\Git",
    }),
  ).toBe(regHit);
});

test("win32：注册表指向的目录已失效（文件不存在）时继续走后续候选", () => {
  const pf = "C:\\Program Files\\Git\\bin\\bash.exe";
  expect(
    detectBash({
      platform: "win32",
      env: { ProgramFiles: "C:\\Program Files" },
      pathExists: (p) => p === pf,
      which: () => null,
      readGitInstallPath: () => "D:\\Gone\\Git",
    }),
  ).toBe(pf);
});

test("默认实现在 win32 无任何候选时不误判（access(F_OK) 语义，不抛错）", () => {
  // 不注入 pathExists / which / readGitInstallPath：走默认真实探测（macOS 上没有
  // bash.exe 与注册表），必须返回 null 而不是抛错或误判为可用。
  expect(
    detectBash({ platform: "win32", env: {}, readGitInstallPath: () => null }),
  ).toBeNull();
});
