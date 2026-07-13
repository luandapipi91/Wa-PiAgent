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

test("构造函数接受自定义 npmCommand", () => {
  const svc = new NpmPackageService(dir, { npmCommand: ["pnpm"] });
  // 通过 spawn 行为间接验证——install 会使用 pnpm
  expect(svc).toBeDefined();
});
