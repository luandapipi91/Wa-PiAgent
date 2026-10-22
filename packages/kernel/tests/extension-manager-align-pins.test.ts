// extension-manager 的 pin 对齐单测（TDD：先于实现编写）
//
// 背景：settings.json 的 packages 存的是**精确实装版本**，而 agentDir/npm/package.json
// 是 caret 范围。依赖树被盘外重解析（repair 删 lock 后 bun install、装/卸其它包时的
// bun add）会把 node_modules 顶到新版本而 pin 不动；pi 在 --offline 下遇到
// 「pin ≠ 实装」会整包跳过（扩展静默不加载、界面无报错）。
// 启动时对齐 pin 可覆盖所有成因，并把已漂移的现网机器拉回。

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alignPinList, ExtensionManager } from "../src/extension-manager";
import type { NpmPackageService } from "../src/npm-package-service";

/** 只提供 getInstalledVersion 的假包服务 */
function fakePkgService(versions: Record<string, string>): NpmPackageService {
  return {
    getInstalledVersion: (name: string) => versions[name],
  } as unknown as NpmPackageService;
}

describe("alignPinList —— 只改版本、其余原样", () => {
  const getInstalled = (name: string) =>
    ({ "pi-token-speed": "0.10.1", "pi-lens": "4.1.6" })[name];

  test("pin 落后于实装版本时改写为实装版本，并记录变更", () => {
    const r = alignPinList(
      ["npm:pi-token-speed@0.9.0", "npm:pi-lens@4.1.6"],
      getInstalled,
    );
    expect(r.list).toEqual(["npm:pi-token-speed@0.10.1", "npm:pi-lens@4.1.6"]);
    expect(r.changes).toEqual(["pi-token-speed: 0.9.0 → 0.10.1"]);
  });

  test("pin 与实装一致时原样返回且无变更", () => {
    const r = alignPinList(["npm:pi-lens@4.1.6"], getInstalled);
    expect(r.list).toEqual(["npm:pi-lens@4.1.6"]);
    expect(r.changes).toEqual([]);
  });

  test("实装版本不存在（未安装/半安装）时不动该条目", () => {
    const r = alignPinList(["npm:未安装的包@1.0.0"], getInstalled);
    expect(r.list).toEqual(["npm:未安装的包@1.0.0"]);
    expect(r.changes).toEqual([]);
  });

  test("git: 与本地路径条目原样保留", () => {
    const entries = [
      "git:github.com/a/b",
      "/Users/co/some/ext",
      "./relative/ext",
    ];
    const r = alignPinList(entries, getInstalled);
    expect(r.list).toEqual(entries);
    expect(r.changes).toEqual([]);
  });

  test("scoped 包名解析正确（@scope/pkg@ver）", () => {
    const r = alignPinList(["npm:@scope/pkg@1.0.0"], () => "1.2.0");
    expect(r.list).toEqual(["npm:@scope/pkg@1.2.0"]);
    expect(r.changes).toEqual(["@scope/pkg: 1.0.0 → 1.2.0"]);
  });

  test("没有版本后缀的 npm 条目不动（无从判断落后）", () => {
    const r = alignPinList(["npm:pi-lens", "npm:@scope/pkg"], getInstalled);
    expect(r.list).toEqual(["npm:pi-lens", "npm:@scope/pkg"]);
    expect(r.changes).toEqual([]);
  });
});

describe("ExtensionManager.alignPackagePins —— 只在下标真有漂移时写文件", () => {
  function makeDir(settings: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "align-pins-"));
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify(settings, null, 2),
    );
    return dir;
  }

  test("有漂移：写回实装版本（packages 与 waPiDisabledPackages 都覆盖）", async () => {
    const dir = makeDir({
      packages: ["npm:pi-token-speed@0.9.0", "npm:pi-lens@4.1.6"],
      waPiDisabledPackages: ["npm:pi-cache-optimizer@2.8.7"],
      defaultTools: ["read"],
    });
    try {
      const em = new ExtensionManager(
        dir,
        fakePkgService({
          "pi-token-speed": "0.10.1",
          "pi-lens": "4.1.6",
          "pi-cache-optimizer": "2.8.10",
        }),
      );
      const { aligned } = await em.alignPackagePins();
      expect(aligned.sort()).toEqual([
        "pi-cache-optimizer: 2.8.7 → 2.8.10",
        "pi-token-speed: 0.9.0 → 0.10.1",
      ]);

      const written = JSON.parse(
        readFileSync(join(dir, "settings.json"), "utf8"),
      );
      expect(written.packages).toEqual([
        "npm:pi-token-speed@0.10.1",
        "npm:pi-lens@4.1.6",
      ]);
      expect(written.waPiDisabledPackages).toEqual([
        "npm:pi-cache-optimizer@2.8.10",
      ]);
      // 其它字段不得被破坏
      expect(written.defaultTools).toEqual(["read"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("无漂移：不改写文件（保持原样、零副作用）", async () => {
    const settings = { packages: ["npm:pi-lens@4.1.6"] };
    const dir = makeDir(settings);
    try {
      const before = readFileSync(join(dir, "settings.json"), "utf8");
      const em = new ExtensionManager(
        dir,
        fakePkgService({ "pi-lens": "4.1.6" }),
      );
      const { aligned } = await em.alignPackagePins();
      expect(aligned).toEqual([]);
      expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("settings.json 不存在时不报错、不创建（幂等空转）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "align-pins-empty-"));
    try {
      const em = new ExtensionManager(dir, fakePkgService({}));
      const { aligned } = await em.alignPackagePins();
      expect(aligned).toEqual([]);
      expect(existsSync(join(dir, "settings.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
