import { test, expect, spyOn, describe } from "bun:test";
import {
  parseBunVersion,
  isBunAtLeast,
  currentBunVersion,
  checkBunVersion,
  bunVersionCheckMessage,
  assertBunVersionOrExit,
  ensureBunBeBunEnv,
  MIN_BUN_VERSION,
} from "../src/runtime-check";

test("parseBunVersion: 标准三段版本", () => {
  expect(parseBunVersion("1.4.0")).toEqual({ major: 1, minor: 4, patch: 0 });
  expect(parseBunVersion("1.3.14")).toEqual({ major: 1, minor: 3, patch: 14 });
});

test("parseBunVersion: canary 剥离 - 后缀", () => {
  expect(parseBunVersion("1.4.0-canary.5")).toEqual({
    major: 1,
    minor: 4,
    patch: 0,
  });
});

test("parseBunVersion: 缺段补 0", () => {
  expect(parseBunVersion("1.2")).toEqual({ major: 1, minor: 2, patch: 0 });
});

test("parseBunVersion: 非数字容错为 0", () => {
  expect(parseBunVersion("abc")).toEqual({ major: 0, minor: 0, patch: 0 });
  expect(parseBunVersion("")).toEqual({ major: 0, minor: 0, patch: 0 });
});

test("isBunAtLeast: 1.4.0 及以上为 true", () => {
  expect(isBunAtLeast("1.4.0")).toBe(true);
  expect(isBunAtLeast("1.4.1")).toBe(true);
  expect(isBunAtLeast("1.5.0")).toBe(true);
  expect(isBunAtLeast("2.0.0")).toBe(true);
});

test("isBunAtLeast: 1.3.x 为 false（1.3.15 仍低于 1.4.0）", () => {
  expect(isBunAtLeast("1.3.14")).toBe(false);
  expect(isBunAtLeast("1.3.15")).toBe(false);
  expect(isBunAtLeast("1.3.99")).toBe(false);
});

test("isBunAtLeast: 自定义最低版本比较", () => {
  expect(isBunAtLeast("1.3.15", { major: 1, minor: 3, patch: 15 })).toBe(true);
  expect(isBunAtLeast("1.3.14", { major: 1, minor: 3, patch: 15 })).toBe(false);
});

test("MIN_BUN_VERSION 恒为 1.4.0", () => {
  expect(MIN_BUN_VERSION).toEqual({ major: 1, minor: 4, patch: 0 });
});

test("currentBunVersion: bun 环境返回 Bun.version", () => {
  expect(currentBunVersion()).toBe(Bun.version);
});

test("currentBunVersion: 非 bun 分支由 typeof Bun 保护（bun 运行时不可模拟删除只读全局）", () => {
  // globalThis.Bun 在 bun 下 writable/configurable 均为 false，无法在测试中
  // 删除后恢复。null 分支的文案路径由 bunVersionCheckMessage(null) 用例覆盖。
  expect(typeof Bun).toBe("object");
  expect(typeof Bun.version).toBe("string");
});

test("checkBunVersion: bun 环境返回 ok 与版本", () => {
  const result = checkBunVersion();
  expect(typeof result.ok).toBe("boolean");
  expect(typeof result.version).toBe("string");
  // 本仓库要求 bun >= 1.4.0，测试运行时若低于此值检查应为 false。
  expect(result.ok).toBe(isBunAtLeast(Bun.version));
});

test("bunVersionCheckMessage: 包含当前版本、最低要求与升级引导", () => {
  const msg = bunVersionCheckMessage("1.3.14");
  expect(msg).toContain("1.3.14");
  expect(msg).toContain("1.4.0");
  expect(msg).toContain("bun upgrade");
  expect(msg).toContain("npm install -g bun@latest");
});

test("bunVersionCheckMessage: 非 bun 运行时提示未知", () => {
  const msg = bunVersionCheckMessage(null);
  expect(msg).toContain("未知");
});

test("assertBunVersionOrExit: 低版本打印错误并以退出码 1 退出", () => {
  const exitSpy = spyOn(process, "exit").mockImplementation(() => {
    throw new Error("exit called");
  });
  const errorSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(() => assertBunVersionOrExit("1.3.14")).toThrow("exit called");
    expect(errorSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  } finally {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  }
});

test("assertBunVersionOrExit: 满足最低版本时不退出", () => {
  const exitSpy = spyOn(process, "exit").mockImplementation(() => {
    throw new Error("exit called");
  });
  try {
    expect(() => assertBunVersionOrExit("1.4.0")).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  } finally {
    exitSpy.mockRestore();
  }
});

describe("ensureBunBeBunEnv", () => {
  test("未设置时写入 BUN_BE_BUN=1（编译产物的子进程充当 bun CLI）", () => {
    delete process.env.BUN_BE_BUN;
    ensureBunBeBunEnv();
    expect(process.env.BUN_BE_BUN).toBe("1");
  });

  test("已显式设置时不覆盖（幂等，尊重用户 env）", () => {
    process.env.BUN_BE_BUN = "0";
    try {
      ensureBunBeBunEnv();
      expect(process.env.BUN_BE_BUN).toBe("0");
    } finally {
      delete process.env.BUN_BE_BUN;
    }
  });
});
