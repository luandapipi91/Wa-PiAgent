import { test, expect } from "bun:test";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ensureIntercomInstalled } from "../src/intercom-setup";
import { HIAGENT_DIR } from "@hiagent/shared";

// 测试工具：建独立临时目录，避免污染真实 ~/.hiagent
function tmpDir() {
  return `/tmp/hiagent-intercom-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

test("ensureIntercomInstalled 首次调用写入 packages 配置", async () => {
  const dir = tmpDir();
  try {
    // 目录与 settings.json 均不存在 —— 模拟首次启动
    await ensureIntercomInstalled(dir);

    const raw = await readFile(join(dir, "settings.json"), "utf8");
    const settings = JSON.parse(raw);
    expect(settings.packages).toContain("npm:pi-intercom");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureIntercomInstalled 幂等：已存在不重复写入", async () => {
  const dir = tmpDir();
  try {
    // 预置已含 pi-intercom 的 settings.json
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ packages: ["npm:pi-intercom"] }),
    );

    await ensureIntercomInstalled(dir);

    const raw = await readFile(join(dir, "settings.json"), "utf8");
    const settings = JSON.parse(raw);
    expect(settings.packages).toHaveLength(1);
    expect(settings.packages).toEqual(["npm:pi-intercom"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureIntercomInstalled 保留已有 packages 并追加", async () => {
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
    expect(settings.packages).toContain("npm:pi-intercom");
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
    expect(settings.packages).toEqual(["npm:pi-intercom"]);
    expect(settings.someOtherField).toBe(123);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
