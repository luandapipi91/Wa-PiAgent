// main.cjs 的「先出帧再显窗」顺序测试。
//
// main.cjs 顶层有 require("electron") 等副作用无法直接 import，故按 web-preferences.test.ts 的
// 范式读源码字符串断言。修复的问题：原实现在 did-finish-load 回调里**立即** revealMainWindow()，
// 而首帧探测（rAF）是异步的 → `windowShown` 早于 `firstFrame`，用户先看到一个白窗/半渲染页面
// （跨平台问题，macOS 同样存在；实测修复前 windowShown=+2992 而 firstFrame=+3082）。
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "..", "src", "main.cjs"), "utf8");

/** did-finish-load（主窗口）到显窗这一段 */
function revealSegment() {
  const anchor = src.indexOf('startup.mark("didFinishLoad")');
  expect(anchor).toBeGreaterThan(-1);
  return src.slice(anchor, anchor + 1600);
}

test("显窗在首帧之后：firstFrame 的 mark 必须早于 revealMainWindow()", () => {
  const seg = revealSegment();
  const firstFrameIdx = seg.indexOf('startup.mark("firstFrame")');
  const revealIdx = seg.indexOf("revealMainWindow();");
  expect(firstFrameIdx).toBeGreaterThan(-1);
  expect(revealIdx).toBeGreaterThan(firstFrameIdx);
});

test("首帧探测之前不得显窗（不能先给用户一个白窗）", () => {
  const seg = revealSegment();
  const execIdx = seg.indexOf(".executeJavaScript(");
  expect(execIdx).toBeGreaterThan(-1);
  // 首帧探测开始之前，这一段落里不允许出现 revealMainWindow()
  expect(seg.slice(0, execIdx)).not.toContain("revealMainWindow();");
});

test("首帧探测失败也要显窗（探测异常不能把用户困在启动页）", () => {
  const seg = revealSegment();
  const catchIdx = seg.indexOf(".catch(() => {");
  expect(catchIdx).toBeGreaterThan(-1);
  // catch 分支之后必须还有一次 revealMainWindow()
  expect(seg.slice(catchIdx, catchIdx + 400)).toContain("revealMainWindow();");
});
