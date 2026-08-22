// packages/kernel/tests/browser-manager.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserManager, type WebViewLike } from "../src/browser-manager";

/** fake WebView：记录调用、可配置 navigate 结果 */
function makeFakeView(): WebViewLike & { closed: boolean; navigated: string[] } {
  return {
    url: "about:blank",
    title: "",
    loading: false,
    closed: false,
    navigated: [] as string[],
    async navigate(url: string) {
      this.navigated.push(url);
      this.url = url;
    },
    async evaluate() { return undefined; },
    async click() {},
    async type() {},
    async press() {},
    async scroll() {},
    async scrollTo() {},
    async screenshot() { return new Blob(["png"]); },
    close() { this.closed = true; },
  };
}

describe("BrowserManager", () => {
  test("getOrCreate：首次创建，二次复用同一实例", async () => {
    const dir = mkdtempSync(join(tmpdir(), "browser-mgr-"));
    const manager = new BrowserManager({
      screenshotDir: dir,
      viewFactory: () => makeFakeView(),
    });
    const a = await manager.getOrCreate("s1");
    const b = await manager.getOrCreate("s1");
    expect(a.view).toBe(b.view); // 同一实例
    manager.dispose();
  });

  test("不同会话返回不同视图（隔离）", async () => {
    const manager = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-mgr-")),
      viewFactory: () => makeFakeView(),
    });
    const a = await manager.getOrCreate("s1");
    const b = await manager.getOrCreate("s2");
    expect(a.view).not.toBe(b.view);
    manager.dispose();
  });

  test("closeSession：销毁并移除，再次 get 返回 undefined", async () => {
    const manager = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-mgr-")),
      viewFactory: () => makeFakeView(),
    });
    const { view } = await manager.getOrCreate("s1");
    manager.closeSession("s1");
    expect((view as unknown as { closed: boolean }).closed).toBe(true);
    expect(manager.get("s1")).toBeUndefined();
    manager.dispose();
  });

  test("sweepIdle：闲置超时的会话被销毁", async () => {
    const manager = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-mgr-")),
      viewFactory: () => makeFakeView(),
      idleTimeoutMs: 100,
      sweepIntervalMs: 50,
    });
    const { view } = await manager.getOrCreate("s1");
    await new Promise((r) => setTimeout(r, 250));
    manager.sweepIdle(); // 主动触发
    expect((view as unknown as { closed: boolean }).closed).toBe(true);
    expect(manager.get("s1")).toBeUndefined();
    manager.dispose();
  });

  test("dispose：全部销毁", async () => {
    const manager = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-mgr-")),
      viewFactory: () => makeFakeView(),
    });
    const { view } = await manager.getOrCreate("s1");
    manager.dispose();
    expect((view as unknown as { closed: boolean }).closed).toBe(true);
  });

  test("截图目录被自动创建", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "browser-mgr-")), "shots");
    const manager = new BrowserManager({ screenshotDir: dir, viewFactory: () => makeFakeView() });
    expect(existsSync(dir)).toBe(true);
    manager.dispose();
  });
});
