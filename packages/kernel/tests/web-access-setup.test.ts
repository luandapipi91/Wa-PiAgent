import { test, expect } from "bun:test";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ensureWebAccessInstalled } from "../src/web-access-setup";

// pi-web-access 本地路径（与 web-access-setup.ts 中的 resolveWebAccessLocalPath 一致）
function webAccessLocalPath(): string {
  const url = import.meta.resolve("pi-web-access");
  const dirUrl = new URL(".", url);
  return dirUrl.pathname;
}

// 测试工具：建独立临时目录，避免污染真实 ~/.hiagent
function tmpDir() {
  return `/tmp/hiagent-webaccess-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

test("ensureWebAccessInstalled 首次调用写入本地路径 packages 配置", async () => {
  const dir = tmpDir();
  try {
    await ensureWebAccessInstalled(dir);

    const raw = await readFile(join(dir, "settings.json"), "utf8");
    const settings = JSON.parse(raw);
    expect(settings.packages).toContain(webAccessLocalPath());
    expect(settings.packages).not.toContain("npm:pi-web-access");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureWebAccessInstalled 幂等：已存在本地路径不重复写入", async () => {
  const dir = tmpDir();
  try {
    await mkdir(dir, { recursive: true });
    const localPath = webAccessLocalPath();
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ packages: [localPath] }),
    );

    await ensureWebAccessInstalled(dir);

    const raw = await readFile(join(dir, "settings.json"), "utf8");
    const settings = JSON.parse(raw);
    expect(settings.packages).toHaveLength(1);
    expect(settings.packages).toEqual([localPath]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureWebAccessInstalled 迁移旧 npm:pi-web-access 为本地路径", async () => {
  const dir = tmpDir();
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ packages: ["npm:pi-web-access"] }),
    );

    await ensureWebAccessInstalled(dir);

    const raw = await readFile(join(dir, "settings.json"), "utf8");
    const settings = JSON.parse(raw);
    const localPath = webAccessLocalPath();
    expect(settings.packages).toHaveLength(1);
    expect(settings.packages).toContain(localPath);
    expect(settings.packages).not.toContain("npm:pi-web-access");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureWebAccessInstalled 保留已有 packages 并追加本地路径", async () => {
  const dir = tmpDir();
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ packages: ["npm:other-ext"], foo: "bar" }),
    );

    await ensureWebAccessInstalled(dir);

    const raw = await readFile(join(dir, "settings.json"), "utf8");
    const settings = JSON.parse(raw);
    expect(settings.packages).toHaveLength(2);
    expect(settings.packages).toContain("npm:other-ext");
    expect(settings.packages).toContain(webAccessLocalPath());
    expect(settings.foo).toBe("bar");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureWebAccessInstalled settings.json 存在但无 packages 字段时补上", async () => {
  const dir = tmpDir();
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ someOtherField: 123 }),
    );

    await ensureWebAccessInstalled(dir);

    const raw = await readFile(join(dir, "settings.json"), "utf8");
    const settings = JSON.parse(raw);
    const localPath = webAccessLocalPath();
    expect(settings.packages).toEqual([localPath]);
    expect(settings.someOtherField).toBe(123);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
