// packages/kernel/tests/extension-manager.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExtensionManager, validatePackageName, parseExtensionInput } from "../src/extension-manager";
import { NpmPackageService } from "../src/npm-package-service";

function tmpDir(): string {
  const dir = join(import.meta.dir, ".tmp-ext-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

let dir: string;
beforeEach(() => { dir = tmpDir(); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// ---- validatePackageName ----
test("validatePackageName 接受合法裸名", () => {
  expect(validatePackageName("pi-intercom")).toBe("pi-intercom");
  expect(validatePackageName("superpowers-zh")).toBe("superpowers-zh");
});

test("validatePackageName 接受 scope 包", () => {
  expect(validatePackageName("@scope/my-pkg")).toBe("@scope/my-pkg");
});

test("validatePackageName 接受带版本", () => {
  expect(validatePackageName("pkg@1.0.0")).toBe("pkg@1.0.0");
});

test("validatePackageName 拒绝路径字符", () => {
  expect(validatePackageName("../evil")).toBeNull();
  expect(validatePackageName("/etc/passwd")).toBeNull();
  expect(validatePackageName("./local")).toBeNull();
});

test("validatePackageName 拒绝 shell 元字符", () => {
  expect(validatePackageName("pkg; rm -rf /")).toBeNull();
  expect(validatePackageName("pkg|cat /etc/passwd")).toBeNull();
  expect(validatePackageName("`evil`")).toBeNull();
});

// ---- parseExtensionInput ----
test("parseExtensionInput 解析裸名", () => {
  const r = parseExtensionInput("pi-intercom");
  expect(r?.source).toBe("npm");
  expect(r?.name).toBe("pi-intercom");
});

test("parseExtensionInput 解析 npm: 前缀", () => {
  const r = parseExtensionInput("npm:pi-intercom");
  expect(r?.source).toBe("npm");
  expect(r?.name).toBe("pi-intercom");
});

test("parseExtensionInput 解析 git: 前缀", () => {
  const r = parseExtensionInput("git:github.com/user/repo@v1");
  expect(r?.source).toBe("git");
  expect(r?.name).toBe("github.com/user/repo@v1");
});

test("parseExtensionInput 解析本地路径", () => {
  const r = parseExtensionInput("/absolute/path");
  expect(r?.source).toBe("local");
  expect(r?.name).toBe("/absolute/path");
});

test("parseExtensionInput 解析 CLI 格式", () => {
  const r = parseExtensionInput("pi install npm:superpowers-zh");
  expect(r?.source).toBe("npm");
  expect(r?.name).toBe("superpowers-zh");
});

// ---- ExtensionManager ----

const mockPkgService = {
  install: async (name: string, version?: string) => ({ version: "9.9.9" }),
  uninstall: async (_name: string) => {},
  upgrade: async (name: string) => ({ version: "9.9.9" }),
  getInstalledVersion: (_name: string) => "9.9.9" as string | undefined,
  getLatestVersion: async (_name: string) => "9.9.10" as string | undefined,
  getDescription: (_name: string) => "Mock description" as string | undefined,
} satisfies Omit<NpmPackageService, "runtimeDir" | "spawn">;

function mockManager(dataDir: string) {
  return new ExtensionManager(dataDir, mockPkgService as unknown as NpmPackageService);
}

test("list 返回空列表", async () => {
  const mgr = mockManager(dir);
  const { packages } = await mgr.list();
  expect(packages).toEqual([]);
});

test("install 写入 npm:name@version 到 packages", async () => {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ npmCommand: ["bun"] }), "utf8");
  const mgr = mockManager(dir);
  const info = await mgr.install("test-pkg");
  expect(info.name).toBe("test-pkg");
  expect(info.version).toBe("9.9.9");

  const settings = JSON.parse(require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings.packages).toContain("npm:test-pkg@9.9.9");
});

test("install 拒绝重复安装", async () => {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    npmCommand: ["bun"],
    packages: ["npm:test-pkg@1.0.0"],
  }), "utf8");
  const mgr = mockManager(dir);
  await expect(mgr.install("test-pkg")).rejects.toThrow("已安装");
});

test("uninstall 从 packages 移除", async () => {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    npmCommand: ["bun"],
    packages: ["npm:test-pkg@1.0.0", "npm:other@2.0.0"],
  }), "utf8");
  const mgr = mockManager(dir);
  await mgr.uninstall("test-pkg");

  const settings = JSON.parse(require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings.packages).toEqual(["npm:other@2.0.0"]);
  expect(settings.packages).not.toContain("npm:test-pkg@1.0.0");
});

test("disable 从 packages 移除但保留 node_modules", async () => {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    npmCommand: ["bun"],
    packages: ["npm:test-pkg@1.0.0"],
  }), "utf8");
  const mgr = mockManager(dir);
  await mgr.disable("test-pkg");

  const settings = JSON.parse(require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings.packages).toEqual([]);
});

test("enable 将包重新加入 packages（检查 node_modules 版本）", async () => {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    npmCommand: ["bun"],
    packages: [],
    extensions: ["/fake/node_modules/test-pkg/index.js"],
  }), "utf8");
  const mgr = mockManager(dir);
  await mgr.enable("test-pkg");

  const settings = JSON.parse(require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings.packages).toContain("npm:test-pkg@9.9.9");
  expect(settings.extensions).toBeUndefined();
});

test("不可变更新：保留 settings.json 其他字段", async () => {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    npmCommand: ["bun"],
    disabledSkills: ["x"],
    other: 1,
    packages: [],
  }), "utf8");
  const mgr = mockManager(dir);
  await mgr.install("new-pkg");

  const settings = JSON.parse(require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings.disabledSkills).toEqual(["x"]);
  expect(settings.other).toBe(1);
});
