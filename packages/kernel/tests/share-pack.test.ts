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

test("hashPaths：相同集合（任意顺序）同 hash，不同集合不同 hash", () => {
  const a = hashPaths([join(dir, "index.html"), join(dir, "assets", "a.css")]);
  const b = hashPaths([join(dir, "assets", "a.css"), join(dir, "index.html")]);
  const c = hashPaths([join(dir, "index.html")]);
  expect(a).toBe(b);
  expect(a).not.toBe(c);
  expect(a).toMatch(/^[0-9a-f]{12}$/);
});

test("buildZip：文件夹递归展开、保持相对路径，可解压还原", () => {
  const zip = buildZip([join(dir, "index.html"), join(dir, "assets")], dir);
  const files = unzipSync(zip);
  expect(Object.keys(files)).toContain("index.html");
  expect(Object.keys(files)).toContain("assets/a.css");
  expect(new TextDecoder().decode(files["index.html"])).toContain("hi");
});
