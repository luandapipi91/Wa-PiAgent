import { test, expect } from "bun:test";
import { bunAssetForPlatform, bunDownloadUrls } from "../src/bun-download";

test("bunAssetForPlatform: win32 → bun-windows-x64.zip / bun.exe", () => {
  expect(bunAssetForPlatform("win32", "x64")).toEqual({
    archive: "bun-windows-x64.zip",
    dir: "bun-windows-x64",
    bin: "bun.exe",
  });
});

test("bunAssetForPlatform: linux → bun-linux-x64.zip / bun", () => {
  expect(bunAssetForPlatform("linux", "x64")).toEqual({
    archive: "bun-linux-x64.zip",
    dir: "bun-linux-x64",
    bin: "bun",
  });
});

test("bunAssetForPlatform: darwin arm64 → aarch64 资产名（防 404 回归）", () => {
  expect(bunAssetForPlatform("darwin", "arm64")).toEqual({
    archive: "bun-darwin-aarch64.zip",
    dir: "bun-darwin-aarch64",
    bin: "bun",
  });
});

test("bunAssetForPlatform: darwin x64 → x64 资产名", () => {
  expect(bunAssetForPlatform("darwin", "x64")).toEqual({
    archive: "bun-darwin-x64.zip",
    dir: "bun-darwin-x64",
    bin: "bun",
  });
});

test("bunAssetForPlatform: 不支持平台抛错", () => {
  expect(() => bunAssetForPlatform("freebsd", "x64")).toThrow();
});

test("bunDownloadUrls: 默认版本 1.4.0，GitHub 固定 tag + npmmirror 固定版本", () => {
  const urls = bunDownloadUrls("bun-windows-x64.zip");
  expect(urls).toHaveLength(2);
  expect(urls[0]).toBe(
    "https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-windows-x64.zip",
  );
  expect(urls[1]).toBe(
    "https://registry.npmmirror.com/-/binary/bun/bun-v1.4.0/bun-windows-x64.zip",
  );
});

test("bunDownloadUrls: 自定义版本参数生效", () => {
  const urls = bunDownloadUrls("bun-linux-x64.zip", "1.5.0");
  expect(urls[0]).toContain("bun-v1.5.0");
  expect(urls[1]).toContain("bun-v1.5.0");
});
