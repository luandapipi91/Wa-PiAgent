// packages/kernel/tests/browser-manager.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrowserManager,
  makeDefaultViewFactory,
  toDesktopUserAgent,
  type WebViewLike,
} from "../src/browser-manager";

/** 引擎（headless）默认 UA 样例：平台段为实时机器，仅 Chrome 名带 Headless 前缀 */
const HEADLESS_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36";

/** fake WebView：记录调用、可配置 navigate 结果 */
function makeFakeView(): WebViewLike & {
  closed: boolean;
  navigated: string[];
} {
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
    async evaluate() {
      return undefined;
    },
    async click() {},
    async type() {},
    async press() {},
    async scroll() {},
    async scrollTo() {},
    async screenshot() {
      return new Blob(["png"]);
    },
    close() {
      this.closed = true;
    },
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
    const manager = new BrowserManager({
      screenshotDir: dir,
      viewFactory: () => makeFakeView(),
    });
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
  test("默认视图工厂：Chrome 后端带 --mute-audio（页面媒体不自动出声）+ 关 AutomationControlled", () => {
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
      backend: {
        type: "chrome",
        argv: ["--mute-audio", "--disable-blink-features=AutomationControlled"],
      },
    });
    (view as unknown as { close(): void }).close();
  });

  test("默认视图工厂：argv 关闭 AutomationControlled（防 navigator.webdriver 外露被反爬识别）", () => {
    // 实测：epub.cnipa.gov.cn 对 headless UA + webdriver=true 直接回空页，
    // 关掉 AutomationControlled（webdriver=false）后才放行 —— 锁死该参数防回归
    const captured: Array<Record<string, unknown>> = [];
    const FakeCtor = class {
      constructor(opts: Record<string, unknown>) {
        captured.push(opts);
      }
      close() {}
    };
    const factory = makeDefaultViewFactory(FakeCtor as never);
    factory({ width: 800, height: 600 });
    const backend = captured[0].backend as { argv?: string[] };
    expect(backend.argv).toContain("--disable-blink-features=AutomationControlled");
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

describe("toDesktopUserAgent", () => {
  test("HeadlessChrome 换成 Chrome，平台段与版本号原样保留", () => {
    const desktop = toDesktopUserAgent(HEADLESS_UA);
    expect(desktop).not.toContain("Headless");
    expect(desktop).toContain(
      "Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
    );
  });

  test("多处出现全部替换；已非 headless 的 UA 不变", () => {
    expect(toDesktopUserAgent("HeadlessChrome/1 HeadlessChrome/2")).toBe(
      "Chrome/1 Chrome/2",
    );
    const normal =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
    expect(toDesktopUserAgent(normal)).toBe(normal);
  });
});

/** fake WebView（带 CDP 记录 + 可配置 UA）：用于 UA 伪装测试 */
function makeCdpFakeView(opts: { ua?: string; mutesCdp?: boolean } = {}): WebViewLike & {
  navigated: string[];
  cdpCalls: Array<{ method: string; params?: Record<string, unknown> }>;
} {
  const navigated: string[] = [];
  const cdpCalls: Array<{ method: string; params?: Record<string, unknown> }> =
    [];
  return {
    url: "about:blank",
    title: "",
    loading: false,
    navigated,
    cdpCalls,
    async navigate(url: string) {
      navigated.push(url);
    },
    async evaluate(script: string) {
      return script === "navigator.userAgent" ? (opts.ua ?? HEADLESS_UA) : undefined;
    },
    async cdp(method: string, params?: Record<string, unknown>) {
      if (opts.mutesCdp) throw new Error("cdp 不可用");
      cdpCalls.push({ method, params });
      return {};
    },
    async click() {},
    async type() {},
    async press() {},
    async scroll() {},
    async scrollTo() {},
    async screenshot() {
      return new Blob(["png"]);
    },
    close() {},
  };
}

describe("BrowserManager.prepareUserAgent", () => {
  test("把引擎 headless UA 伪装成同机桌面 Chrome UA（申请 CDP 覆盖）", async () => {
    const view = makeCdpFakeView();
    const manager = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-mgr-")),
      viewFactory: () => view,
    });
    const state = await manager.getOrCreate("s1");
    await manager.prepareUserAgent(state);

    expect(view.navigated).toEqual(["about:blank"]); // 覆盖前先建立 CDP 会话
    expect(view.cdpCalls).toHaveLength(1);
    expect(view.cdpCalls[0].method).toBe("Emulation.setUserAgentOverride");
    const ua = view.cdpCalls[0].params?.userAgent as string;
    expect(ua).not.toContain("Headless");
    expect(ua).toBe(toDesktopUserAgent(HEADLESS_UA));
    expect(ua).toContain("Macintosh; Intel Mac OS X 10_15_7"); // 平台段随实时机器
    manager.dispose();
  });

  test("幂等：同视图只伪装一次（不重复预热导航/覆盖）", async () => {
    const view = makeCdpFakeView();
    const manager = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-mgr-")),
      viewFactory: () => view,
    });
    const state = await manager.getOrCreate("s1");
    await manager.prepareUserAgent(state);
    await manager.prepareUserAgent(state);
    expect(view.navigated).toEqual(["about:blank"]);
    expect(view.cdpCalls).toHaveLength(1);
    manager.dispose();
  });

  test("并发调用共享同一次伪装（不重复覆盖）", async () => {
    const view = makeCdpFakeView();
    const manager = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-mgr-")),
      viewFactory: () => view,
    });
    const state = await manager.getOrCreate("s1");
    await Promise.all([
      manager.prepareUserAgent(state),
      manager.prepareUserAgent(state),
    ]);
    expect(view.navigated).toEqual(["about:blank"]);
    expect(view.cdpCalls).toHaveLength(1);
    manager.dispose();
  });

  test("引擎不支持 cdp（fake/旧视图）：静默跳过，不产生额外导航", async () => {
    const view = makeFakeView();
    const manager = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-mgr-")),
      viewFactory: () => view,
    });
    const state = await manager.getOrCreate("s1");
    await expect(manager.prepareUserAgent(state)).resolves.toBeUndefined();
    expect(view.navigated).toEqual([]);
    manager.dispose();
  });

  test("CDP 覆盖失败：静默吞掉，不阻断后续导航", async () => {
    const view = makeCdpFakeView({ mutesCdp: true });
    const manager = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-mgr-")),
      viewFactory: () => view,
    });
    const state = await manager.getOrCreate("s1");
    await expect(manager.prepareUserAgent(state)).resolves.toBeUndefined();
    await state.view.navigate("http://example.com");
    expect(view.navigated).toContain("http://example.com");
    manager.dispose();
  });

  test("引擎已是桌面 UA（无 Headless）：不申请覆盖", async () => {
    const view = makeCdpFakeView({ ua: toDesktopUserAgent(HEADLESS_UA) });
    const manager = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-mgr-")),
      viewFactory: () => view,
    });
    const state = await manager.getOrCreate("s1");
    await manager.prepareUserAgent(state);
    expect(view.cdpCalls).toHaveLength(0);
    manager.dispose();
  });

  test("新会话各自伪装（视图级隔离）", async () => {
    const views = [makeCdpFakeView(), makeCdpFakeView()];
    const manager = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-mgr-")),
      viewFactory: () => views.shift() as WebViewLike,
    });
    const s1 = await manager.getOrCreate("s1");
    const s2 = await manager.getOrCreate("s2");
    await manager.prepareUserAgent(s1);
    await manager.prepareUserAgent(s2);
    expect((s1.view as unknown as { cdpCalls: unknown[] }).cdpCalls).toHaveLength(1);
    expect((s2.view as unknown as { cdpCalls: unknown[] }).cdpCalls).toHaveLength(1);
    manager.dispose();
  });
});
