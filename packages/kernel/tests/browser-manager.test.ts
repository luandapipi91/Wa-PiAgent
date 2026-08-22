// packages/kernel/tests/browser-manager.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserManager, makeDefaultViewFactory, type WebViewLike } from "../src/browser-manager";

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

  test("closeSession 幂等：重复 close 不抛错，get 返回 undefined", async () => {
    const manager = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-mgr-")),
      viewFactory: () => makeFakeView(),
    });
    const { view } = await manager.getOrCreate("s1");
    manager.closeSession("s1");
    expect(() => manager.closeSession("s1")).not.toThrow(); // 第二次 close 不抛
    expect((view as unknown as { closed: boolean }).closed).toBe(true);
    expect(manager.get("s1")).toBeUndefined();
    manager.dispose();
  });
  test("默认视图工厂：Chrome 后端带 --mute-audio（页面媒体不自动出声）", () => {
    // 注入假 WebView 构造器捕获参数（避免拉起真实 Chrome）
    const captured: Array<Record<string, unknown>> = [];
    const FakeCtor = class {
      constructor(opts: Record<string, unknown>) {
        captured.push(opts);
      }
      close() {}
    };
    const factory = makeDefaultViewFactory(FakeCtor as never);
    const view = factory({ width: 800, height: 600 });
    expect(captured).toHaveLength(1);
    // backend 必须是 chrome 对象形式且带 --mute-audio 静音参数
    expect(captured[0]).toMatchObject({
      width: 800,
      height: 600,
      backend: { type: "chrome", argv: ["--mute-audio"] },
    });
    (view as unknown as { close(): void }).close();
  });

  test("默认视图工厂：缺少 --mute-audio 会失败（防回归静音参数）", () => {
    // 变异验证辅助：直接断言参数里的 argv 精确包含 --mute-audio
    const captured: Array<Record<string, unknown>> = [];
    const FakeCtor = class {
      constructor(opts: Record<string, unknown>) {
        captured.push(opts);
      }
      close() {}
    };
    const factory = makeDefaultViewFactory(FakeCtor as never);
    factory({ width: 800, height: 600 });
    const backend = captured[0].backend as { type: string; argv?: string[] };
    expect(backend.type).toBe("chrome");
    expect(backend.argv).toContain("--mute-audio");
  });
});
