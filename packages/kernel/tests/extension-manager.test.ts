import { test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ExtensionManager } from "../src/extension-manager";

function tmpDir(): string {
  const dir = join(import.meta.dir, ".tmp-ext-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

// 用真实 npm 布局路径（含 node_modules/<pkg>/），让 pathBelongsToPackage 能正确判定归属
const FAKE_LENS_PATH = "/fake/node_modules/pi-lens/dist/index.js";
// 注入 fake 解析器，避免单测依赖真实 pi-lens 安装
const FAKE_VERSIONS: Record<string, string> = {
  "pi-lens": "3.8.68",
};
const injectOpts = {
  resolveEntryPath: (pkg: string) => `/fake/node_modules/${pkg}/dist/index.js`,
  readVersion: (pkg: string) => FAKE_VERSIONS[pkg] ?? "0.0.0",
};

let dir: string;
beforeEach(() => { dir = tmpDir(); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test("list 首启播种：defaultEnabled 插件路径写入 settings.extensions", async () => {
  const mgr = new ExtensionManager(dir, injectOpts);
  const { plugins } = await mgr.list();
  expect(plugins).toHaveLength(1);
  expect(plugins[0].id).toBe("pi-lens");
  expect(plugins[0].enabled).toBe(true);
  expect(plugins[0].version).toBe("3.8.68");
  const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings.extensions).toContain(FAKE_LENS_PATH);
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

// ---- 回归：bun install 产生新 .bun 缓存 hash 后，旧路径残留导致双重加载 ----
// 复现：首启用路径 A 播种 → 模拟 bun install 后 resolveEntryPath 返回路径 B
// → list() 应把 A 收敛为 B，settings.extensions 只剩一条，不会双重加载。
test("list 收敛同包历史路径：bun install 后旧路径替换为新路径", async () => {
  // 首启：用路径 A 播种
  let currentPath = "/fake/.bun/pi-lens@aaa/node_modules/pi-lens/dist/index.js";
  const mgr = new ExtensionManager(dir, {
    resolveEntryPath: () => currentPath,
    readVersion: () => "3.8.68",
  });
  await mgr.list();
  let settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings.extensions).toEqual([currentPath]);

  // 模拟 bun install：解析路径变成 B（新 hash）
  currentPath = "/fake/.bun/pi-lens@bbb/node_modules/pi-lens/dist/index.js";
  await mgr.list();
  settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  // 旧路径 A 应被替换为新路径 B，不是追加
  expect(settings.extensions).toEqual([currentPath]);
  expect(settings.extensions).toHaveLength(1);
});

test("list 收敛：禁用的插件其所有历史路径一并移除", async () => {
  // 预置：settings 同时有旧、新两条 pi-lens 路径（模拟 toggle 追加了新路径但旧路径残留）
  const oldPath = "/fake/.bun/pi-lens@aaa/node_modules/pi-lens/dist/index.js";
  const newPath = "/fake/.bun/pi-lens@bbb/node_modules/pi-lens/dist/index.js";
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ extensions: [oldPath, newPath] }),
    "utf8",
  );
  const mgr = new ExtensionManager(dir, {
    resolveEntryPath: () => newPath,
    readVersion: () => "3.8.68",
  });
  // 禁用 pi-lens
  await mgr.toggle("pi-lens", false);
  const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  // 两条历史路径都应被清理
  expect(settings.extensions).not.toContain(oldPath);
  expect(settings.extensions).not.toContain(newPath);
});

test("list 收敛：保留不属于任何可选插件的外部路径", async () => {
  // settings.extensions 可能含其它来源的路径（如用户手动加的、或 SDK 写的）
  const extPath = "/some/other/node_modules/other-ext/dist/index.js";
  const lensPath = "/fake/.bun/pi-lens@old/node_modules/pi-lens/dist/index.js";
  const newPath = "/fake/.bun/pi-lens@new/node_modules/pi-lens/dist/index.js";
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ extensions: [extPath, lensPath] }),
    "utf8",
  );
  const mgr = new ExtensionManager(dir, {
    resolveEntryPath: () => newPath,
    readVersion: () => "3.8.68",
  });
  await mgr.list();
  const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  // 外部路径保留，pi-lens 收敛为新路径
  expect(settings.extensions).toContain(extPath);
  expect(settings.extensions).toContain(newPath);
  expect(settings.extensions).not.toContain(lensPath);
});
