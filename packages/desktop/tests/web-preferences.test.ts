import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// main.cjs 顶层有 require("electron") 等副作用，无法直接 import；
// 这里读源码字符串校验 webPreferences 配置，防止后续误删 sandbox:false 导致打包后复制失效。
// （Electron 20+ 默认开启 sandbox，preload 无法 require electron.clipboard → 复制功能失效）
const src = readFileSync(join(import.meta.dir, "..", "src", "main.cjs"), "utf8");

test("splashWindow 与 mainWindow 均显式关闭 sandbox，保证 preload 能 require clipboard", () => {
  // 两个窗口的 webPreferences 都应含 sandbox:false
  const blocks = src.match(/webPreferences:\s*\{[^}]*\}/g) ?? [];
  expect(blocks.length).toBeGreaterThanOrEqual(2);

  for (const b of blocks) {
    expect(b).toContain("contextIsolation: true");
    expect(b).toContain("nodeIntegration: false");
    // 关键：sandbox 必须为 false，否则 Electron 43 默认 sandbox 会让 preload 的 require('electron') 只拿到白名单子集
    expect(b).toContain("sandbox: false");
    expect(b).toContain("preload:");
  }
});

test("两个窗口都挂载同一个 preload.cjs", () => {
  const preloadRefs = (src.match(/preload:\s*path\.join\(__dirname,\s*"preload\.cjs"\)/g) ?? []).length;
  expect(preloadRefs).toBe(2);
});
