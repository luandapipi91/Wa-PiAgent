import { test, expect } from "bun:test";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ensureIntercomInstalled } from "../src/intercom-setup";

// pi-intercom 本地路径（与 intercom-setup.ts 中的 resolveIntercomLocalPath 一致）
function intercomLocalPath(): string {
  const url = import.meta.resolve("pi-intercom");
  const dirUrl = new URL(".", url);
  return dirUrl.pathname;
}

// 测试工具：建独立临时目录，避免污染真实 ~/.hiagent
function tmpDir() {
  return `/tmp/hiagent-intercom-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

test("ensureIntercomInstalled 首次调用写入本地路径 packages 配置", async () => {
  const dir = tmpDir();
  try {
    // 目录与 settings.json 均不存在 —— 模拟首次启动
    await ensureIntercomInstalled(dir);

    const raw = await readFile(join(dir, "settings.json"), "utf8");
    const settings = JSON.parse(raw);
    expect(settings.packages).toContain(intercomLocalPath());
    // 不应包含旧 npm: 格式
    expect(settings.packages).not.toContain("npm:pi-intercom");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureIntercomInstalled 幂等：已存在本地路径不重复写入", async () => {
  const dir = tmpDir();
  try {
    // 预置已含本地 pi-intercom 路径的 settings.json
    await mkdir(dir, { recursive: true });
    const localPath = intercomLocalPath();
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ packages: [localPath] }),
    );

    await ensureIntercomInstalled(dir);

    const raw = await readFile(join(dir, "settings.json"), "utf8");
    const settings = JSON.parse(raw);
    expect(settings.packages).toHaveLength(1);
    expect(settings.packages).toEqual([localPath]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureIntercomInstalled 迁移旧 npm:pi-intercom 为本地路径", async () => {
  const dir = tmpDir();
  try {
    // 预置旧 npm:pi-intercom 格式
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ packages: ["npm:pi-intercom"] }),
    );

    await ensureIntercomInstalled(dir);

    const raw = await readFile(join(dir, "settings.json"), "utf8");
    const settings = JSON.parse(raw);
    const localPath = intercomLocalPath();
    expect(settings.packages).toHaveLength(1);
    expect(settings.packages).toContain(localPath);
    expect(settings.packages).not.toContain("npm:pi-intercom");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureIntercomInstalled 保留已有 packages 并追加本地路径", async () => {
  const dir = tmpDir();
  try {
    await mkdir(dir, { recursive: true });
    // 预置已有别的扩展
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ packages: ["npm:other-ext"], foo: "bar" }),
    );

    await ensureIntercomInstalled(dir);

    const raw = await readFile(join(dir, "settings.json"), "utf8");
    const settings = JSON.parse(raw);
    expect(settings.packages).toHaveLength(2);
    expect(settings.packages).toContain("npm:other-ext");
    expect(settings.packages).toContain(intercomLocalPath());
    // 其他字段保留
    expect(settings.foo).toBe("bar");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureIntercomInstalled settings.json 存在但无 packages 字段时补上", async () => {
  const dir = tmpDir();
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ someOtherField: 123 }),
    );

    await ensureIntercomInstalled(dir);

    const raw = await readFile(join(dir, "settings.json"), "utf8");
    const settings = JSON.parse(raw);
    const localPath = intercomLocalPath();
    expect(settings.packages).toEqual([localPath]);
    expect(settings.someOtherField).toBe(123);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
