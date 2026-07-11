import { test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ExtensionManager } from "../src/extension-manager";

function tmpDir(): string {
  const dir = join(import.meta.dir, ".tmp-ext-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

const FAKE_LENS_PATH = "/fake/pi-lens/dist/index.js";
const FAKE_MEMORY_PATH = "/fake/pi-hermes-memory/dist/index.js";
// 注入 fake 解析器，避免单测依赖真实 pi-lens / pi-hermes-memory 安装
const FAKE_VERSIONS: Record<string, string> = {
  "pi-lens": "3.8.68",
  "pi-hermes-memory": "0.7.23",
};
const injectOpts = {
  resolveEntryPath: (pkg: string) =>
    pkg === "pi-hermes-memory" ? FAKE_MEMORY_PATH : FAKE_LENS_PATH,
  readVersion: (pkg: string) => FAKE_VERSIONS[pkg] ?? "0.0.0",
};

let dir: string;
beforeEach(() => { dir = tmpDir(); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test("list 首启播种：defaultEnabled 插件路径写入 settings.extensions", async () => {
  const mgr = new ExtensionManager(dir, injectOpts);
  const { plugins } = await mgr.list();
  expect(plugins).toHaveLength(2);
  expect(plugins[0].id).toBe("pi-lens");
  expect(plugins[0].enabled).toBe(true);
  expect(plugins[0].version).toBe("3.8.68");
  expect(plugins[1].id).toBe("pi-hermes-memory");
  expect(plugins[1].enabled).toBe(true);
  expect(plugins[1].version).toBe("0.7.23");
  const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings.extensions).toContain(FAKE_LENS_PATH);
  expect(settings.extensions).toContain(FAKE_MEMORY_PATH);
});

test("toggle 禁用后路径从 settings.extensions 移除", async () => {
  const mgr = new ExtensionManager(dir, injectOpts);
  await mgr.list();                 // 先播种
  await mgr.toggle("pi-lens", false);
  const { plugins } = await mgr.list();
  expect(plugins[0].enabled).toBe(false);
  const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings.extensions).not.toContain(FAKE_LENS_PATH);
});

test("toggle 启用后路径回到 settings.extensions", async () => {
  const mgr = new ExtensionManager(dir, injectOpts);
  await mgr.list();
  await mgr.toggle("pi-lens", false);
  await mgr.toggle("pi-lens", true);
  const { plugins } = await mgr.list();
  expect(plugins[0].enabled).toBe(true);
});

test("不可变更新：保留 settings.json 其他字段", async () => {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ disabledSkills: ["x"], other: 1 }), "utf8");
  const mgr = new ExtensionManager(dir, injectOpts);
  await mgr.toggle("pi-lens", true);
  const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings.disabledSkills).toEqual(["x"]);
  expect(settings.other).toBe(1);
  expect(settings.extensions).toContain(FAKE_LENS_PATH);
});

test("list 幂等：路径已在 settings.extensions 时不重复写入", async () => {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ extensions: [FAKE_LENS_PATH] }), "utf8");
  const before = readFileSync(join(dir, "settings.json"), "utf8");
  const mgr = new ExtensionManager(dir, injectOpts);
  await mgr.list();
  const after = readFileSync(join(dir, "settings.json"), "utf8");
  expect(after).toBe(before);
});

test("toggle 未知 id 抛错", async () => {
  const mgr = new ExtensionManager(dir, injectOpts);
  await expect(mgr.toggle("nope", true)).rejects.toThrow("未知插件");
});
