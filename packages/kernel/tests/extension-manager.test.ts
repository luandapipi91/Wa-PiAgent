// packages/kernel/tests/extension-manager.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ExtensionManager,
  validatePackageName,
  parseExtensionInput,
} from "../src/extension-manager";
import type { NpmPackageService } from "../src/npm-package-service";
import { WA_PI_DIR } from "@wa-pi/shared";
import { errorCodeOf } from "./helpers/kernel-error-code";

function tmpDir(): string {
  const dir = join(
    import.meta.dir,
    ".tmp-ext-" + Math.random().toString(36).slice(2),
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

let dir: string;
beforeEach(() => {
  dir = tmpDir();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

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

test("parseExtensionInput 解析 Windows 盘符路径（反斜杠/正斜杠）", () => {
  const backslash = parseExtensionInput(
    "H:\\workspace\\hiagent\\examples\\ext-ui-bridge-demo",
  );
  expect(backslash?.source).toBe("local");
  expect(backslash?.name).toBe(
    "H:\\workspace\\hiagent\\examples\\ext-ui-bridge-demo",
  );

  const slash = parseExtensionInput(
    "/path/to/HiAgent/examples/ext-ui-bridge-demo",
  );
  expect(slash?.source).toBe("local");
  expect(slash?.name).toBe("/path/to/HiAgent/examples/ext-ui-bridge-demo");
});

test("parseExtensionInput 解析 Windows UNC 路径", () => {
  const r = parseExtensionInput("\\\\server\\share\\pkg");
  expect(r?.source).toBe("local");
  expect(r?.name).toBe("\\\\server\\share\\pkg");
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
  upgrade: async (_name: string, onProgress?: (line: string) => void) => {
    onProgress?.("mock upgrade progress");
    return { version: "9.9.9" };
  },
  repair: async (_onProgress?: (line: string) => void) => {},
  getInstalledVersion: (_name: string) => "9.9.9" as string | undefined,
  getLatestVersion: async (_name: string) => "9.9.10" as string | undefined,
  getDescription: (_name: string) => "Mock description" as string | undefined,
} satisfies Omit<NpmPackageService, "runtimeDir" | "spawn">;

function mockManager(dataDir: string) {
  return new ExtensionManager(
    dataDir,
    mockPkgService as unknown as NpmPackageService,
  );
}

test("list 返回空列表", async () => {
  const mgr = mockManager(dir);
  const { packages } = await mgr.list();
  expect(packages).toEqual([]);
});

test("install 写入 npm:name@version 到 packages", async () => {
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ npmCommand: ["bun"] }),
    "utf8",
  );
  const mgr = mockManager(dir);
  const info = await mgr.install("test-pkg");
  expect(info.name).toBe("test-pkg");
  expect(info.version).toBe("9.9.9");

  const settings = JSON.parse(
    require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"),
  );
  expect(settings.packages).toContain("npm:test-pkg@9.9.9");
});

test("install 拒绝重复安装", async () => {
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      npmCommand: ["bun"],
      packages: ["npm:test-pkg@1.0.0"],
    }),
    "utf8",
  );
  const mgr = mockManager(dir);
  expect(await errorCodeOf(mgr.install("test-pkg"))).toBe(
    "ext.alreadyInstalled",
  );
});

test("uninstall 从 packages 移除", async () => {
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      npmCommand: ["bun"],
      packages: ["npm:test-pkg@1.0.0", "npm:other@2.0.0"],
    }),
    "utf8",
  );
  const mgr = mockManager(dir);
  await mgr.uninstall("test-pkg");

  const settings = JSON.parse(
    require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"),
  );
  expect(settings.packages).toEqual(["npm:other@2.0.0"]);
  expect(settings.packages).not.toContain("npm:test-pkg@1.0.0");
});

test("disable 把条目从 packages 移到 disabledPackages（仍可见 enabled:false）", async () => {
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      npmCommand: ["bun"],
      packages: ["npm:test-pkg@1.0.0"],
    }),
    "utf8",
  );
  const mgr = mockManager(dir);
  await mgr.disable("test-pkg");

  const settings = JSON.parse(
    require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"),
  );
  expect(settings.packages).toEqual([]);
  expect(settings.waPiDisabledPackages).toEqual(["npm:test-pkg@1.0.0"]);

  // disable 后该包仍出现在 list() 里，enabled:false
  const { packages } = await mgr.list();
  const found = packages.find((p) => p.name === "test-pkg");
  expect(found).toBeDefined();
  expect(found!.enabled).toBe(false);
});

test("disable 对已禁用包幂等（no-op，不写）", async () => {
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      npmCommand: ["bun"],
      packages: [],
      waPiDisabledPackages: ["npm:test-pkg@1.0.0"],
    }),
    "utf8",
  );
  const mgr = mockManager(dir);
  await mgr.disable("test-pkg"); // should not throw

  const settings = JSON.parse(
    require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"),
  );
  expect(settings.waPiDisabledPackages).toEqual(["npm:test-pkg@1.0.0"]);
  expect(settings.packages).toEqual([]);
});

test("disable 对未安装包抛错", async () => {
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      npmCommand: ["bun"],
      packages: [],
    }),
    "utf8",
  );
  const mgr = mockManager(dir);
  expect(await errorCodeOf(mgr.disable("nope"))).toBe("ext.notInstalled");
});

test("enable 把 disabled 包移回 packages（enabled:true）", async () => {
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      npmCommand: ["bun"],
      packages: [],
      waPiDisabledPackages: ["npm:test-pkg@1.0.0"],
    }),
    "utf8",
  );
  const mgr = mockManager(dir);
  await mgr.enable("test-pkg");

  const settings = JSON.parse(
    require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"),
  );
  expect(settings.packages).toContain("npm:test-pkg@1.0.0");
  expect(settings.waPiDisabledPackages).toEqual([]);

  // list 中该包 enabled:true
  const { packages } = await mgr.list();
  const found = packages.find((p) => p.name === "test-pkg");
  expect(found).toBeDefined();
  expect(found!.enabled).toBe(true);
});

test("enable 对已启用包幂等（no-op）", async () => {
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      npmCommand: ["bun"],
      packages: ["npm:test-pkg@1.0.0"],
      waPiDisabledPackages: [],
    }),
    "utf8",
  );
  const mgr = mockManager(dir);
  await mgr.enable("test-pkg");

  const settings = JSON.parse(
    require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"),
  );
  expect(settings.packages).toEqual(["npm:test-pkg@1.0.0"]);
  expect(settings.waPiDisabledPackages).toEqual([]);
});

test("enable 兜底：从 node_modules 恢复（在两列表皆无时）", async () => {
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      npmCommand: ["bun"],
      packages: [],
      waPiDisabledPackages: [],
    }),
    "utf8",
  );
  const mgr = mockManager(dir);
  // mockPkgService.getInstalledVersion("test-pkg") 返回 "9.9.9"
  await mgr.enable("test-pkg");

  const settings = JSON.parse(
    require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"),
  );
  expect(settings.packages).toContain("npm:test-pkg@9.9.9");
});

test("list 把 disabledPackages 条目标为 enabled:false", async () => {
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      npmCommand: ["bun"],
      packages: ["npm:enabled-pkg@1.0.0"],
      waPiDisabledPackages: [
        "npm:disabled-pkg@2.0.0",
        "git:github.com/x/y",
        "/local/path",
      ],
    }),
    "utf8",
  );
  const mgr = mockManager(dir);
  const { packages } = await mgr.list();

  const enabled = packages.find((p) => p.name === "enabled-pkg");
  expect(enabled).toBeDefined();
  expect(enabled!.enabled).toBe(true);

  const disabled = packages.find((p) => p.name === "disabled-pkg");
  expect(disabled).toBeDefined();
  expect(disabled!.enabled).toBe(false);

  const gitPkg = packages.find((p) => p.source === "git");
  expect(gitPkg).toBeDefined();
  expect(gitPkg!.enabled).toBe(false);

  const localPkg = packages.find((p) => p.source === "local");
  expect(localPkg).toBeDefined();
  expect(localPkg!.enabled).toBe(false);
});

test("uninstall 同时支持 packages 和 disabledPackages", async () => {
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      npmCommand: ["bun"],
      packages: ["npm:other@2.0.0"],
      waPiDisabledPackages: ["npm:test-pkg@1.0.0"],
    }),
    "utf8",
  );
  const mgr = mockManager(dir);
  await mgr.uninstall("test-pkg");

  const settings = JSON.parse(
    require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"),
  );
  expect(settings.waPiDisabledPackages).toEqual([]);
  expect(settings.packages).toEqual(["npm:other@2.0.0"]);
});

test("uninstall 对两列表皆无的包抛错", async () => {
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      npmCommand: ["bun"],
      packages: [],
      waPiDisabledPackages: [],
    }),
    "utf8",
  );
  const mgr = mockManager(dir);
  expect(await errorCodeOf(mgr.uninstall("nope"))).toBe("ext.notInstalled");
});

test("install 命中 disabledPackages 时抛「已禁用，请先启用」", async () => {
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      npmCommand: ["bun"],
      packages: [],
      waPiDisabledPackages: ["npm:test-pkg@1.0.0"],
    }),
    "utf8",
  );
  const mgr = mockManager(dir);
  expect(await errorCodeOf(mgr.install("test-pkg"))).toBe("ext.disabled");
});

// ---- local 来源：身份统一为 package.json name ----

/** 造一个带 package.json 的本地扩展目录 */
function makeLocalPkg(name?: string): string {
  const pkgDir = join(dir, "local-ext");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify(name ? { name } : {}),
    "utf8",
  );
  return pkgDir;
}

test("install local：身份用 package.json name，settings 存绝对路径", async () => {
  const pkgDir = makeLocalPkg("local-demo");
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ npmCommand: ["bun"] }),
    "utf8",
  );
  const mgr = mockManager(dir);

  const info = await mgr.install(pkgDir);
  expect(info.name).toBe("local-demo");
  expect(info.source).toBe("local");

  const settings = JSON.parse(
    require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"),
  );
  expect(settings.packages).toEqual([pkgDir]);

  // list() 展示名也是包名（前端「附加命令」弹窗按此 name 匹配命令的 packageName）
  const { packages } = await mgr.list();
  const found = packages.find((p) => p.source === "local");
  expect(found?.name).toBe("local-demo");
});

test("install local：重复安装按原始路径命中「已安装」（路径别名）", async () => {
  const pkgDir = makeLocalPkg("local-demo");
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ npmCommand: ["bun"] }),
    "utf8",
  );
  const mgr = mockManager(dir);
  await mgr.install(pkgDir);
  // 再次按同一路径安装：extractNames 的路径别名必须命中，否则产生重复条目
  expect(await errorCodeOf(mgr.install(pkgDir))).toBe("ext.alreadyInstalled");
  // 按包名安装（不同写法同一身份）不重复：包名不是合法输入格式，走 npm 校验被拒，
  // 这里验证 disable/uninstall 按包名操作即可（见下条）
});

test("local 生命周期：按包名 disable / enable / uninstall", async () => {
  const pkgDir = makeLocalPkg("local-demo");
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ npmCommand: ["bun"] }),
    "utf8",
  );
  const mgr = mockManager(dir);
  await mgr.install(pkgDir);

  await mgr.disable("local-demo");
  let settings = JSON.parse(
    require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"),
  );
  expect(settings.packages).toEqual([]);
  expect(settings.waPiDisabledPackages).toEqual([pkgDir]);

  await mgr.enable("local-demo");
  settings = JSON.parse(
    require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"),
  );
  expect(settings.packages).toEqual([pkgDir]);
  expect(settings.waPiDisabledPackages).toEqual([]);

  await mgr.uninstall("local-demo");
  settings = JSON.parse(
    require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"),
  );
  expect(settings.packages).toEqual([]);
});

test("install local：package.json 无 name 字段时身份退化为路径", async () => {
  const pkgDir = makeLocalPkg();
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ npmCommand: ["bun"] }),
    "utf8",
  );
  const mgr = mockManager(dir);
  const info = await mgr.install(pkgDir);
  expect(info.name).toBe(pkgDir);
  const { packages } = await mgr.list();
  expect(packages.find((p) => p.source === "local")?.name).toBe(pkgDir);
});

test("upgrade 对仅在 disabledPackages 的包抛「请先启用后升级」", async () => {
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      npmCommand: ["bun"],
      packages: [],
      waPiDisabledPackages: ["npm:test-pkg@1.0.0"],
    }),
    "utf8",
  );
  const mgr = mockManager(dir);
  expect(await errorCodeOf(mgr.upgrade("test-pkg"))).toBe("ext.disabled");
});

test("不可变更新：保留 settings.json 其他字段（含 disabledPackages）", async () => {
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      npmCommand: ["bun"],
      disabledSkills: ["x"],
      other: 1,
      packages: [],
      waPiDisabledPackages: ["npm:legacy@1.0.0"],
    }),
    "utf8",
  );
  const mgr = mockManager(dir);
  await mgr.install("new-pkg");

  const settings = JSON.parse(
    require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"),
  );
  expect(settings.disabledSkills).toEqual(["x"]);
  expect(settings.other).toBe(1);
  expect(settings.waPiDisabledPackages).toEqual(["npm:legacy@1.0.0"]);
});

// ---- SHOULD-FIX 5 新增覆盖：upgrade happy-path / git 生命周期 / scoped+version 解析 ----

test("upgrade happy-path：升级 npm 包并更新 settings 条目为新版本", async () => {
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      npmCommand: ["bun"],
      packages: ["npm:test-pkg@1.0.0"],
    }),
    "utf8",
  );
  const mgr = mockManager(dir);
  const info = await mgr.upgrade("test-pkg");
  // mock upgrade 返回 version "9.9.9"
  expect(info.name).toBe("test-pkg");
  expect(info.source).toBe("npm");
  expect(info.version).toBe("9.9.9");
  expect(info.enabled).toBe(true);

  const settings = JSON.parse(
    require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"),
  );
  // 旧条目被替换为新版本
  expect(settings.packages).toContain("npm:test-pkg@9.9.9");
  expect(settings.packages).not.toContain("npm:test-pkg@1.0.0");
});

test("upgrade 透传 onProgress 给 pkgService（流式进度回推）", async () => {
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      npmCommand: ["bun"],
      packages: ["npm:test-pkg@1.0.0"],
    }),
    "utf8",
  );
  const lines: string[] = [];
  const mgr = mockManager(dir);
  await mgr.upgrade("test-pkg", (l) => lines.push(l));
  expect(lines).toEqual(["mock upgrade progress"]);
});

test("git 来源生命周期：install→disable→enable→uninstall 按 bare name 查找（验证 fix #2）", async () => {
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      npmCommand: ["bun"],
      packages: [],
    }),
    "utf8",
  );
  const mgr = mockManager(dir);
  const repo = "github.com/user/repo";
  const info = await mgr.install(`git:${repo}`);
  expect(info.name).toBe(repo);
  expect(info.source).toBe("git");

  let settings = JSON.parse(
    require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"),
  );
  expect(settings.packages).toEqual([`git:${repo}`]);

  // disable 按 bare name（repo）查找，证明 extractNames 已正确剥掉 git: 前缀
  await mgr.disable(repo);
  settings = JSON.parse(
    require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"),
  );
  expect(settings.packages).toEqual([]);
  expect(settings.waPiDisabledPackages).toEqual([`git:${repo}`]);

  // enable 按 bare name 移回
  await mgr.enable(repo);
  settings = JSON.parse(
    require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"),
  );
  expect(settings.packages).toEqual([`git:${repo}`]);
  expect(settings.waPiDisabledPackages).toEqual([]);

  // uninstall 按 bare name 移除
  await mgr.uninstall(repo);
  settings = JSON.parse(
    require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"),
  );
  expect(settings.packages).toEqual([]);
  expect(settings.waPiDisabledPackages).toEqual([]);
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
  const mgr = new ExtensionManager(
    dir,
    scopedMock as unknown as NpmPackageService,
  );

  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ npmCommand: ["bun"] }),
    "utf8",
  );
  const info = await mgr.install("@scope/pkg@1.0.0");
  expect(info.name).toBe("@scope/pkg");
  expect(info.version).toBe("1.0.0");

  // install 被以拆分后的 name + version 调用
  expect(calls).toEqual([{ name: "@scope/pkg", version: "1.0.0" }]);

  const settings = JSON.parse(
    require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"),
  );
  // 写入条目为 npm:@scope/pkg@<resolved>
  expect(settings.packages).toContain("npm:@scope/pkg@1.0.0");
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
  const pkgDir = join(WA_PI_DIR, "npm", "node_modules", pkgName);
  const skillsDir = join(pkgDir, "skills");
  mkdirSync(join(skillsDir, skillName), { recursive: true });
  writeFileSync(
    join(skillsDir, skillName, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: ext skill\n---\n# ${skillName}`,
  );
}

test("getEnabledExtensionSkillPaths 返回含 SKILL.md 的扩展技能路径", async () => {
  const dataDir = tmpDir();
  try {
    const mgr = mockManager(dataDir);

    // 先安装一个 npm 包（mock）
    await mgr.install("my-ext-pkg");

    // 创建扩展技能目录结构
    createExtSkillPackage("my-ext-pkg", "ext-tool");

    const paths = await mgr.getEnabledExtensionSkillPaths();
    expect(paths).toHaveLength(1);
    expect(paths[0].packageName).toBe("my-ext-pkg");
    // 跨平台断言：Windows 下 join 产出反斜杠，统一为正斜杠再比对
    expect(paths[0].path.replace(/\\/g, "/")).toContain("my-ext-pkg/skills");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(join(WA_PI_DIR, "npm", "node_modules", "my-ext-pkg"), {
      recursive: true,
      force: true,
    });
  }
});

test("getEnabledExtensionSkillPaths 跳过无 skills/ 的扩展", async () => {
  const dataDir = tmpDir();
  try {
    const mgr = mockManager(dataDir);
    await mgr.install("no-skill-pkg");

    // 不创建 skills/ 目录
    const paths = await mgr.getEnabledExtensionSkillPaths();
    expect(paths).toHaveLength(0);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(join(WA_PI_DIR, "npm", "node_modules", "no-skill-pkg"), {
      recursive: true,
      force: true,
    });
  }
});

test("getEnabledExtensionSkillPaths 不返回已禁用的扩展", async () => {
  const dataDir = tmpDir();
  try {
    const mgr = mockManager(dataDir);
    await mgr.install("disabled-pkg");
    await mgr.disable("disabled-pkg");

    createExtSkillPackage("disabled-pkg", "some-skill");

    const paths = await mgr.getEnabledExtensionSkillPaths();
    expect(paths).toHaveLength(0);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(join(WA_PI_DIR, "npm", "node_modules", "disabled-pkg"), {
      recursive: true,
      force: true,
    });
  }
});

// ---- listEnabledPackageNames（热路径轻量方法）----

test("listEnabledPackageNames 返回启用包裸名（npm:/git:/local 条目）", async () => {
  const mgr = mockManager(dir);
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      packages: ["npm:npm-pkg@9.9.9", "git:github.com/u/r", "/opt/local-pkg"],
    }),
  );
  const names = await mgr.listEnabledPackageNames();
  expect(names).toEqual(["npm-pkg", "github.com/u/r", "/opt/local-pkg"]);
});

test("listEnabledPackageNames 无 settings.json 返回空数组", async () => {
  const mgr = mockManager(dir);
  expect(await mgr.listEnabledPackageNames()).toEqual([]);
});

test("listEnabledPackageNames 不触碰 pkgService（无版本/registry 查询）", async () => {
  // 根因回归守卫：会话启动链路曾因 list() 内 getLatestVersion → npm view 网络请求卡数秒。
  // 轻量方法必须纯读 settings.json；注入全部抛错的 pkgService，被调用即测试失败。
  const throwingService = {
    install: async () => {
      throw new Error("不应调用 install");
    },
    uninstall: async () => {
      throw new Error("不应调用 uninstall");
    },
    upgrade: async () => {
      throw new Error("不应调用 upgrade");
    },
    repair: async () => {
      throw new Error("不应调用 repair");
    },
    getInstalledVersion: () => {
      throw new Error("不应调用 getInstalledVersion");
    },
    getLatestVersion: async () => {
      throw new Error("不应调用 getLatestVersion");
    },
    getDescription: () => {
      throw new Error("不应调用 getDescription");
    },
  } satisfies Omit<NpmPackageService, "runtimeDir" | "spawn">;
  const mgr = new ExtensionManager(
    dir,
    throwingService as unknown as NpmPackageService,
  );
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      packages: ["npm:a@1.0.0"],
      waPiDisabledPackages: ["npm:b@2.0.0"],
    }),
  );
  // 只返回启用列表，不含禁用包
  expect(await mgr.listEnabledPackageNames()).toEqual(["a"]);
});

// ---- waPiCommandToggles（命令级开关持久化）----

test("getCommandToggle 缺省返回 true（无 settings.json）", async () => {
  const mgr = mockManager(dir);
  expect(await mgr.getCommandToggle("my-pkg", "my-command")).toBe(true);
});

test("getCommandToggle 缺省返回 true（有 settings.json 但无 toggles）", async () => {
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      packages: ["npm:my-pkg@1.0.0"],
    }),
    "utf8",
  );
  const mgr = mockManager(dir);
  expect(await mgr.getCommandToggle("my-pkg", "my-command")).toBe(true);
});

test("setCommandToggle 持久化后重读返回新值", async () => {
  const mgr = mockManager(dir);
  await mgr.setCommandToggle("my-pkg", "cmd-a", true);
  expect(await mgr.getCommandToggle("my-pkg", "cmd-a")).toBe(true);

  // 新实例重读（模拟重启后从磁盘加载）
  const mgr2 = mockManager(dir);
  expect(await mgr2.getCommandToggle("my-pkg", "cmd-a")).toBe(true);

  // settings.json 落盘结构验证
  const settings = JSON.parse(
    require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"),
  );
  expect(settings.waPiCommandToggles).toEqual({ "my-pkg": { "cmd-a": true } });
});

test("setCommandToggle 关闭开关并持久化", async () => {
  const mgr = mockManager(dir);
  await mgr.setCommandToggle("my-pkg", "cmd-a", true);
  await mgr.setCommandToggle("my-pkg", "cmd-a", false);
  expect(await mgr.getCommandToggle("my-pkg", "cmd-a")).toBe(false);

  const settings = JSON.parse(
    require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"),
  );
  expect(settings.waPiCommandToggles).toEqual({ "my-pkg": { "cmd-a": false } });
});

test("getCommandToggles 返回全部（多包多命令）", async () => {
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      waPiCommandToggles: {
        "pkg-a": { "cmd-1": true, "cmd-2": false },
        "pkg-b": { "cmd-3": true },
      },
    }),
    "utf8",
  );
  const mgr = mockManager(dir);
  expect(await mgr.getCommandToggles()).toEqual({
    "pkg-a": { "cmd-1": true, "cmd-2": false },
    "pkg-b": { "cmd-3": true },
  });
});

test("getCommandToggles 无 settings.json 返回空对象", async () => {
  const mgr = mockManager(dir);
  expect(await mgr.getCommandToggles()).toEqual({});
});

test("setCommandToggle 保留其他 toggles 与其他 settings 字段", async () => {
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      npmCommand: ["bun"],
      packages: ["npm:my-pkg@1.0.0"],
      waPiCommandToggles: { "my-pkg": { "cmd-a": true } },
    }),
    "utf8",
  );
  const mgr = mockManager(dir);
  await mgr.setCommandToggle("my-pkg", "cmd-b", true);
  await mgr.setCommandToggle("other-pkg", "cmd-x", true);

  const settings = JSON.parse(
    require("node:fs").readFileSync(join(dir, "settings.json"), "utf8"),
  );
  // 已有 toggles 不被覆盖，其他 settings 字段保留
  expect(settings.waPiCommandToggles).toEqual({
    "my-pkg": { "cmd-a": true, "cmd-b": true },
    "other-pkg": { "cmd-x": true },
  });
  expect(settings.npmCommand).toEqual(["bun"]);
  expect(settings.packages).toEqual(["npm:my-pkg@1.0.0"]);
});

// ---- 任务 4 i18n：KernelError code 断言（人话文案由前端 kernelMsg 字典渲染） ----

test("install 非法输入 → KernelError ext.invalidName", async () => {
  const mgr = mockManager(dir);
  expect(await errorCodeOf(mgr.install("bad name!"))).toBe("ext.invalidName");
});

test("install local 路径无效 → KernelError ext.invalidPackagePath", async () => {
  const mgr = mockManager(dir);
  expect(await errorCodeOf(mgr.install("/no/such/dir"))).toBe(
    "ext.invalidPackagePath",
  );
});

test("upgrade git 来源 → KernelError ext.upgradeUnsupported", async () => {
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      npmCommand: ["bun"],
      packages: ["git:some/repo"],
    }),
    "utf8",
  );
  const mgr = mockManager(dir);
  expect(await errorCodeOf(mgr.upgrade("some/repo"))).toBe(
    "ext.upgradeUnsupported",
  );
});

test("upgrade 未安装 → KernelError ext.notInstalled", async () => {
  const mgr = mockManager(dir);
  expect(await errorCodeOf(mgr.upgrade("ghost"))).toBe("ext.notInstalled");
});

test("并发升级两个包：后完成者不覆盖先完成者的版本（写回重读最新快照）", async () => {
  // 回归：upgrade 曾在开始时读 settings 快照、完成后按旧快照整文件覆盖写回——
  // 并发升级 a、b 时，后完成的 b 用旧快照把 a 刚写入的新版本抹掉（丢失更新），
  // 表现为「升级成功后又回退」。写回必须在互斥队列内重读最新快照，只替换自己的条目。
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      npmCommand: ["bun"],
      packages: ["npm:a@1.0.0", "npm:b@1.0.0"],
    }),
    "utf8",
  );
  const slowMock = {
    ...mockPkgService,
    upgrade: async (name: string) => {
      // b 慢于 a 完成：a 先写回，b 后写回——旧实现会把 a 的新版本覆盖回 1.0.0
      if (name === "b") await new Promise((r) => setTimeout(r, 50));
      return { version: "2.0.0" };
    },
    getDescription: () => "Mock description" as string | undefined,
  } satisfies Omit<NpmPackageService, "runtimeDir" | "spawn">;
  const mgr = new ExtensionManager(
    dir,
    slowMock as unknown as NpmPackageService,
  );

  await Promise.all([mgr.upgrade("a"), mgr.upgrade("b")]);

  const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings.packages).toContain("npm:a@2.0.0");
  expect(settings.packages).toContain("npm:b@2.0.0");
  expect(settings.packages).not.toContain("npm:a@1.0.0");
  expect(settings.packages).not.toContain("npm:b@1.0.0");
});
