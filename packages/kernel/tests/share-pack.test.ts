import { test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { hashPaths, collectZipEntries, buildZip } from "../src/share/pack";
import { unzipSync } from "fflate";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pack-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<h1>hi</h1>");
  writeFileSync(join(dir, "assets", "a.css"), "body{}");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("hashPaths：正/反斜杠两种入口同 hash（Windows 跨平台一致）", () => {
  const fwd = hashPaths(["C:/proj/a.txt", "C:/proj/b.txt"]);
  const bwd = hashPaths(["C:\\proj\\b.txt", "C:\\proj\\a.txt"]);
  expect(fwd).toBe(bwd);
  expect(fwd).toMatch(/^[0-9a-f]{12}$/);
});

test("hashPaths：相同集合（任意顺序）同 hash，不同集合不同 hash", () => {
  const a = hashPaths([join(dir, "index.html"), join(dir, "assets", "a.css")]);
  const b = hashPaths([join(dir, "assets", "a.css"), join(dir, "index.html")]);
  const c = hashPaths([join(dir, "index.html")]);
  expect(a).toBe(b);
  expect(a).not.toBe(c);
  expect(a).toMatch(/^[0-9a-f]{12}$/);
});

test("buildZip：root 外路径被剔除，不含 ../ 开头条目", () => {
  const outside = mkdtempSync(join(tmpdir(), "pack-out-"));
  writeFileSync(join(outside, "evil.txt"), "boom");
  try {
    const zip = buildZip(
      [join(dir, "index.html"), join(outside, "evil.txt")],
      dir,
    );
    const files = unzipSync(zip);
    const keys = Object.keys(files);
    expect(keys).toContain("index.html");
    expect(keys).not.toContain("../evil.txt");
    expect(keys.some((k) => k.startsWith("../") || k.startsWith("/"))).toBe(
      false,
    );
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("buildZip：文件夹递归展开、保持相对路径，可解压还原", () => {
  const zip = buildZip([join(dir, "index.html"), join(dir, "assets")], dir);
  const files = unzipSync(zip);
  expect(Object.keys(files)).toContain("index.html");
  expect(Object.keys(files)).toContain("assets/a.css");
  expect(new TextDecoder().decode(files["index.html"])).toContain("hi");
});
