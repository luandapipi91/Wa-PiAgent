// packages/kernel/tests/npm-package-service.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NpmPackageService } from "../src/npm-package-service";

let dir: string;
beforeEach(() => {
  dir = join(import.meta.dir, ".tmp-npm-svc-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "node_modules"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("getInstalledVersion 读取 node_modules 中 package.json 的版本", () => {
  const pkgDir = join(dir, "node_modules", "test-pkg");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "test-pkg", version: "1.2.3" }));

  const svc = new NpmPackageService(dir);
  expect(svc.getInstalledVersion("test-pkg")).toBe("1.2.3");
});

test("getInstalledVersion 包不存在返回 undefined", () => {
  const svc = new NpmPackageService(dir);
  expect(svc.getInstalledVersion("nonexistent")).toBeUndefined();
});

test("getDescription 返回 description 字段", () => {
  const pkgDir = join(dir, "node_modules", "desc-pkg");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "desc-pkg", version: "1.0.0", description: "A test package" }));

  const svc = new NpmPackageService(dir);
  expect(svc.getDescription("desc-pkg")).toBe("A test package");
});

test("构造函数接受自定义 npmCommand 且实际被 spawn 使用", async () => {
  // 验证自定义 npmCommand 透传到 spawn：用一个 PATH 里不存在的命令触发 Bun.spawn 的
  // "Executable not found" 错误——错误信息里包含该命令名，证明 spawn 用的是自定义命令
  // 而非默认 "bun"。
  const customCmd = "this-cmd-does-not-exist-xyz";
  const svc = new NpmPackageService(dir, { npmCommand: [customCmd] });
  expect(svc).toBeDefined();
  try {
    await svc.install("any-pkg");
    // 若走到这里说明 spawn 未抛错（不应该发生），强制失败
    expect.unreachable("expected spawn to fail with Executable not found");
  } catch (err) {
    const msg = (err as Error).message;
    // Bun.spawn 在可执行文件不存在时抛 "Executable not found in $PATH: \"<cmd>\""
    expect(msg).toContain(customCmd);
  }
});
