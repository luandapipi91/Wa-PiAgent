import { test, expect } from "bun:test";
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  buildAdditionalExtensionPaths,
  migrateSettingsPackages,
  resolveExtensionEntryFile,
} from "../src/extensions";
import { GENERATED_DIR } from "@hiagent/shared";

test("buildAdditionalExtensionPaths 返回 npm 扩展入口，provider-extension 按需追加", () => {
  const paths = buildAdditionalExtensionPaths();

  // npm 包入口必须存在且解析到实际 .ts 文件
  const intercom = paths.find((p) => p.includes("pi-intercom"));
  const webAccess = paths.find((p) => p.includes("pi-web-access"));
  expect(intercom).toBeTruthy();
  expect(webAccess).toBeTruthy();
  for (const p of [intercom, webAccess]) {
    expect(p!.endsWith(".ts")).toBe(true);
    expect(existsSync(p!)).toBe(true);
  }

  // provider-extension 由 GENERATED_DIR 按需追加（文件存在时才加入）。
  // 用存在性等同断言而非创建文件，避免与 provider-extension.test.ts 并发写同一文件产生 flaky。
  const providerExt = join(GENERATED_DIR, "provider-extension.ts");
  expect(paths.includes(providerExt)).toBe(existsSync(providerExt));
});

test("migrateSettingsPackages 清空 packages 但保留其他字段", async () => {
  const dir = join(import.meta.dir, ".tmp-migrate-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  const settingsPath = join(dir, "settings.json");
  writeFileSync(
    settingsPath,
    JSON.stringify({
      packages: ["/some/old/path", "/another/old"],
      skills: ["a", "b"],
      disabledSkills: ["c"],
      other: 123,
    }),
    "utf8",
  );

  await migrateSettingsPackages(dir);

  const after = JSON.parse(readFileSync(settingsPath, "utf8"));
  expect(after.packages).toBeUndefined();
  // skills/disabledSkills 由 SkillManager 独立读写，迁移不得触碰
  expect(after.skills).toEqual(["a", "b"]);
  expect(after.disabledSkills).toEqual(["c"]);
  expect(after.other).toBe(123);

  rmSync(dir, { recursive: true, force: true });
});

test("migrateSettingsPackages 无 packages 字段时 no-op（文件内容不变）", async () => {
  const dir = join(import.meta.dir, ".tmp-migrate2-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  const settingsPath = join(dir, "settings.json");
  const original = JSON.stringify({ skills: ["a"], other: 1 });
  writeFileSync(settingsPath, original, "utf8");

  await migrateSettingsPackages(dir);

  // 无 packages 字段 → 不重写文件，字节级一致
  expect(readFileSync(settingsPath, "utf8")).toBe(original);

  rmSync(dir, { recursive: true, force: true });
});

test("migrateSettingsPackages 无 settings.json 时 no-op（不抛错、不创建文件）", async () => {
  const dir = join(import.meta.dir, ".tmp-migrate3-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  // 不创建 settings.json
  await expect(migrateSettingsPackages(dir)).resolves.toBeUndefined();
  expect(existsSync(join(dir, "settings.json"))).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("buildAdditionalExtensionPaths 不含可选插件 pi-lens（由 settings.extensions 驱动）", () => {
  const paths = buildAdditionalExtensionPaths();
  // 精确比对 pi-lens 入口路径，避免与本工作区目录名 pi-lens-plugin-menu 的子串误匹配
  const piLensEntry = resolveExtensionEntryFile("pi-lens");
  expect(paths.includes(piLensEntry)).toBe(false);
});
