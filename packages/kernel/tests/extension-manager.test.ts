// packages/kernel/tests/extension-manager.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExtensionManager, validatePackageName, parseExtensionInput } from "../src/extension-manager";
import { NpmPackageService } from "../src/npm-package-service";
import { HIAGENT_DIR } from "@hiagent/shared";

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
  expect(settings.hiagent_packages).toContain("npm:test-pkg@9.9.9");
});

test("install 拒绝重复安装", async () => {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    npmCommand: ["bun"],
    hiagent_packages: ["npm:test-pkg@1.0.0"],
  }), "utf8");
  const mgr = mockManager(dir);
  await expect(mgr.install("test-pkg")).rejects.toThrow("已安装");
});

test("uninstall 从 packages 移除", async () => {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    npmCommand: ["bun"],
    hiagent_packages: ["npm:test-pkg@1.0.0", "npm:other@2.0.0"],
  }), "utf8");
  const mgr = mockManager(dir);
  await mgr.uninstall("test-pkg");

  const settings = JSON.parse(require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings.hiagent_packages).toEqual(["npm:other@2.0.0"]);
  expect(settings.hiagent_packages).not.toContain("npm:test-pkg@1.0.0");
});

test("disable 把条目从 packages 移到 disabledPackages（仍可见 enabled:false）", async () => {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    npmCommand: ["bun"],
    hiagent_packages: ["npm:test-pkg@1.0.0"],
  }), "utf8");
  const mgr = mockManager(dir);
  await mgr.disable("test-pkg");

  const settings = JSON.parse(require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings.hiagent_packages).toEqual([]);
  expect(settings.hiagent_disabledPackages).toEqual(["npm:test-pkg@1.0.0"]);

  // disable 后该包仍出现在 list() 里，enabled:false
  const { packages } = await mgr.list();
  const found = packages.find(p => p.name === "test-pkg");
  expect(found).toBeDefined();
  expect(found!.enabled).toBe(false);
});

test("disable 对已禁用包幂等（no-op，不写）", async () => {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    npmCommand: ["bun"],
    hiagent_packages: [],
    hiagent_disabledPackages: ["npm:test-pkg@1.0.0"],
  }), "utf8");
  const mgr = mockManager(dir);
  await mgr.disable("test-pkg"); // should not throw

  const settings = JSON.parse(require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings.hiagent_disabledPackages).toEqual(["npm:test-pkg@1.0.0"]);
  expect(settings.hiagent_packages).toEqual([]);
});

test("disable 对未安装包抛错", async () => {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    npmCommand: ["bun"],
    hiagent_packages: [],
  }), "utf8");
  const mgr = mockManager(dir);
  await expect(mgr.disable("nope")).rejects.toThrow("未安装");
});

test("enable 把 disabled 包移回 packages（enabled:true）", async () => {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    npmCommand: ["bun"],
    hiagent_packages: [],
    hiagent_disabledPackages: ["npm:test-pkg@1.0.0"],
  }), "utf8");
  const mgr = mockManager(dir);
  await mgr.enable("test-pkg");

  const settings = JSON.parse(require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings.hiagent_packages).toContain("npm:test-pkg@1.0.0");
  expect(settings.hiagent_disabledPackages).toEqual([]);

  // list 中该包 enabled:true
  const { packages } = await mgr.list();
  const found = packages.find(p => p.name === "test-pkg");
  expect(found).toBeDefined();
  expect(found!.enabled).toBe(true);
});

test("enable 对已启用包幂等（no-op）", async () => {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    npmCommand: ["bun"],
    hiagent_packages: ["npm:test-pkg@1.0.0"],
    hiagent_disabledPackages: [],
  }), "utf8");
  const mgr = mockManager(dir);
  await mgr.enable("test-pkg");

  const settings = JSON.parse(require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings.hiagent_packages).toEqual(["npm:test-pkg@1.0.0"]);
  expect(settings.hiagent_disabledPackages).toEqual([]);
});

test("enable 兜底：从 node_modules 恢复（在两列表皆无时）", async () => {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    npmCommand: ["bun"],
    hiagent_packages: [],
    hiagent_disabledPackages: [],
  }), "utf8");
  const mgr = mockManager(dir);
  // mockPkgService.getInstalledVersion("test-pkg") 返回 "9.9.9"
  await mgr.enable("test-pkg");

  const settings = JSON.parse(require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings.hiagent_packages).toContain("npm:test-pkg@9.9.9");
});

test("list 把 disabledPackages 条目标为 enabled:false", async () => {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    npmCommand: ["bun"],
    hiagent_packages: ["npm:enabled-pkg@1.0.0"],
    hiagent_disabledPackages: ["npm:disabled-pkg@2.0.0", "git:github.com/x/y", "/local/path"],
  }), "utf8");
  const mgr = mockManager(dir);
  const { packages } = await mgr.list();

  const enabled = packages.find(p => p.name === "enabled-pkg");
  expect(enabled).toBeDefined();
  expect(enabled!.enabled).toBe(true);

  const disabled = packages.find(p => p.name === "disabled-pkg");
  expect(disabled).toBeDefined();
  expect(disabled!.enabled).toBe(false);

  const gitPkg = packages.find(p => p.source === "git");
  expect(gitPkg).toBeDefined();
  expect(gitPkg!.enabled).toBe(false);

  const localPkg = packages.find(p => p.source === "local");
  expect(localPkg).toBeDefined();
  expect(localPkg!.enabled).toBe(false);
});

test("uninstall 同时支持 packages 和 disabledPackages", async () => {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    npmCommand: ["bun"],
    hiagent_packages: ["npm:other@2.0.0"],
    hiagent_disabledPackages: ["npm:test-pkg@1.0.0"],
  }), "utf8");
  const mgr = mockManager(dir);
  await mgr.uninstall("test-pkg");

  const settings = JSON.parse(require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings.hiagent_disabledPackages).toEqual([]);
  expect(settings.hiagent_packages).toEqual(["npm:other@2.0.0"]);
});

test("uninstall 对两列表皆无的包抛错", async () => {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    npmCommand: ["bun"],
    hiagent_packages: [],
    hiagent_disabledPackages: [],
  }), "utf8");
  const mgr = mockManager(dir);
  await expect(mgr.uninstall("nope")).rejects.toThrow("未安装");
});

test("install 命中 disabledPackages 时抛「已禁用，请先启用」", async () => {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    npmCommand: ["bun"],
    hiagent_packages: [],
    hiagent_disabledPackages: ["npm:test-pkg@1.0.0"],
  }), "utf8");
  const mgr = mockManager(dir);
  await expect(mgr.install("test-pkg")).rejects.toThrow("该插件已禁用，请先启用");
});

test("upgrade 对仅在 disabledPackages 的包抛「请先启用后升级」", async () => {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    npmCommand: ["bun"],
    hiagent_packages: [],
    hiagent_disabledPackages: ["npm:test-pkg@1.0.0"],
  }), "utf8");
  const mgr = mockManager(dir);
  await expect(mgr.upgrade("test-pkg")).rejects.toThrow("该插件已禁用，请先启用后升级");
});

test("不可变更新：保留 settings.json 其他字段（含 disabledPackages）", async () => {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    npmCommand: ["bun"],
    disabledSkills: ["x"],
    other: 1,
    hiagent_packages: [],
    hiagent_disabledPackages: ["npm:legacy@1.0.0"],
  }), "utf8");
  const mgr = mockManager(dir);
  await mgr.install("new-pkg");

  const settings = JSON.parse(require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings.disabledSkills).toEqual(["x"]);
  expect(settings.other).toBe(1);
  expect(settings.hiagent_disabledPackages).toEqual(["npm:legacy@1.0.0"]);
});

// ---- SHOULD-FIX 5 新增覆盖：upgrade happy-path / git 生命周期 / scoped+version 解析 ----

test("upgrade happy-path：升级 npm 包并更新 settings 条目为新版本", async () => {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    npmCommand: ["bun"],
    hiagent_packages: ["npm:test-pkg@1.0.0"],
  }), "utf8");
  const mgr = mockManager(dir);
  const info = await mgr.upgrade("test-pkg");
  // mock upgrade 返回 version "9.9.9"
  expect(info.name).toBe("test-pkg");
  expect(info.source).toBe("npm");
  expect(info.version).toBe("9.9.9");
  expect(info.enabled).toBe(true);

  const settings = JSON.parse(require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"));
  // 旧条目被替换为新版本
  expect(settings.hiagent_packages).toContain("npm:test-pkg@9.9.9");
  expect(settings.hiagent_packages).not.toContain("npm:test-pkg@1.0.0");
});

test("git 来源生命周期：install→disable→enable→uninstall 按 bare name 查找（验证 fix #2）", async () => {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    npmCommand: ["bun"],
    hiagent_packages: [],
  }), "utf8");
  const mgr = mockManager(dir);
  const repo = "github.com/user/repo";
  const info = await mgr.install(`git:${repo}`);
  expect(info.name).toBe(repo);
  expect(info.source).toBe("git");

  let settings = JSON.parse(require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings.hiagent_packages).toEqual([`git:${repo}`]);

  // disable 按 bare name（repo）查找，证明 extractNames 已正确剥掉 git: 前缀
  await mgr.disable(repo);
  settings = JSON.parse(require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings.hiagent_packages).toEqual([]);
  expect(settings.hiagent_disabledPackages).toEqual([`git:${repo}`]);

  // enable 按 bare name 移回
  await mgr.enable(repo);
  settings = JSON.parse(require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings.hiagent_packages).toEqual([`git:${repo}`]);
  expect(settings.hiagent_disabledPackages).toEqual([]);

  // uninstall 按 bare name 移除
  await mgr.uninstall(repo);
  settings = JSON.parse(require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings.hiagent_packages).toEqual([]);
  expect(settings.hiagent_disabledPackages).toEqual([]);
});

test("scoped+version 安装：@scope/pkg@1.0.0 拆分为 name + version（验证 fix #3）", async () => {
  // 用 spy 捕获 mock install 的入参
  const calls: Array<{ name: string; version?: string }> = [];
  const scopedMock = {
    ...mockPkgService,
    install: async (name: string, version?: string) => {
      calls.push({ name, version });
      return { version: version ?? "9.9.9" };
    },
    getInstalledVersion: (_name: string) => "1.0.0" as string | undefined,
  };
  const mgr = new ExtensionManager(dir, scopedMock as unknown as NpmPackageService);

  writeFileSync(join(dir, "settings.json"), JSON.stringify({ npmCommand: ["bun"] }), "utf8");
  const info = await mgr.install("@scope/pkg@1.0.0");
  expect(info.name).toBe("@scope/pkg");
  expect(info.version).toBe("1.0.0");

  // install 被以拆分后的 name + version 调用
  expect(calls).toEqual([{ name: "@scope/pkg", version: "1.0.0" }]);

  const settings = JSON.parse(require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"));
  // 写入条目为 npm:@scope/pkg@<resolved>
  expect(settings.hiagent_packages).toContain("npm:@scope/pkg@1.0.0");
});

test("parseExtensionInput scoped+version：@scope/pkg@1.0.0 正确拆分", () => {
  const r = parseExtensionInput("@scope/pkg@1.0.0");
  expect(r?.source).toBe("npm");
  expect(r?.name).toBe("@scope/pkg");
  expect(r?.version).toBe("1.0.0");
});

test("parseExtensionInput scoped-only：@scope/pkg 无 version 不误拆", () => {
  const r = parseExtensionInput("@scope/pkg");
  expect(r?.source).toBe("npm");
  expect(r?.name).toBe("@scope/pkg");
  expect(r?.version).toBeUndefined();
});

test("parseExtensionInput npm: 前缀 + scoped+version", () => {
  const r = parseExtensionInput("npm:@scope/pkg@2.0.0");
  expect(r?.source).toBe("npm");
  expect(r?.name).toBe("@scope/pkg");
  expect(r?.version).toBe("2.0.0");
});

// ---- getEnabledExtensionSkillPaths ----

// 辅助：在扩展 runtime 目录下创建带 skills/ 的包结构
function createExtSkillPackage(pkgName: string, skillName: string) {
  const pkgDir = join(HIAGENT_DIR, "runtime", "node_modules", pkgName);
  const skillsDir = join(pkgDir, "skills");
  mkdirSync(join(skillsDir, skillName), { recursive: true });
  writeFileSync(join(skillsDir, skillName, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: ext skill\n---\n# ${skillName}`);
}

test("getEnabledExtensionSkillPaths 返回含 SKILL.md 的扩展技能路径", async () => {
  const dataDir = tmpDir();
  const mgr = mockManager(dataDir);

  // 先安装一个 npm 包（mock）
  await mgr.install("my-ext-pkg");

  // 创建扩展技能目录结构
  createExtSkillPackage("my-ext-pkg", "ext-tool");

  const paths = await mgr.getEnabledExtensionSkillPaths();
  expect(paths).toHaveLength(1);
  expect(paths[0].packageName).toBe("my-ext-pkg");
  expect(paths[0].path).toContain("my-ext-pkg/skills");

  rmSync(dataDir, { recursive: true, force: true });
  rmSync(join(HIAGENT_DIR, "runtime", "node_modules", "my-ext-pkg"), { recursive: true, force: true });
});

test("getEnabledExtensionSkillPaths 跳过无 skills/ 的扩展", async () => {
  const dataDir = tmpDir();
  const mgr = mockManager(dataDir);
  await mgr.install("no-skill-pkg");

  // 不创建 skills/ 目录
  const paths = await mgr.getEnabledExtensionSkillPaths();
  expect(paths).toHaveLength(0);

  rmSync(dataDir, { recursive: true, force: true });
  rmSync(join(HIAGENT_DIR, "runtime", "node_modules", "no-skill-pkg"), { recursive: true, force: true });
});

test("getEnabledExtensionSkillPaths 不返回已禁用的扩展", async () => {
  const dataDir = tmpDir();
  const mgr = mockManager(dataDir);
  await mgr.install("disabled-pkg");
  await mgr.disable("disabled-pkg");

  createExtSkillPackage("disabled-pkg", "some-skill");

  const paths = await mgr.getEnabledExtensionSkillPaths();
  expect(paths).toHaveLength(0);

  rmSync(dataDir, { recursive: true, force: true });
  rmSync(join(HIAGENT_DIR, "runtime", "node_modules", "disabled-pkg"), { recursive: true, force: true });
});
