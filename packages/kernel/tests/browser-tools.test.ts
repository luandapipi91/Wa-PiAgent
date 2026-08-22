import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserManager, type WebViewLike } from "../src/browser-manager";
import { handleBrowserTool } from "../src/browser-tools";

function makeFakeView(overrides: Partial<WebViewLike> = {}): WebViewLike {
  return {
    url: "about:blank",
    title: "",
    loading: false,
    async navigate(url: string) { (this as unknown as { navUrl: string }).navUrl = url; },
    async evaluate(script: string) {
      if (script.includes("document.title")) return "fake-title";
      return script;
    },
    async click() {},
    async type() {},
    async press() {},
    async scroll() {},
    async scrollTo() {},
    async screenshot(opts?: { encoding?: string }) {
      if (opts?.encoding === "buffer") return Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      if (opts?.encoding === "base64") return "iVBORw0KGgo=";
      return new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });
    },
    close() {},
    ...overrides,
  };
}

function makeManager() {
  return new BrowserManager({
    screenshotDir: mkdtempSync(join(tmpdir(), "browser-tools-")),
    viewFactory: () => makeFakeView(),
    idleTimeoutMs: 60_000,
    sweepIntervalMs: 60_000,
  });
}

describe("handleBrowserTool", () => {
  test("browser_navigate：缺 url 报错", async () => {
    const m = makeManager();
    const r = await handleBrowserTool(m, "s1", "browser_navigate", {});
    expect(JSON.stringify(r)).toContain("missing_url");
    m.dispose();
  });

  test("browser_navigate：首次调用自动创建视图并返回 url/title", async () => {
    const m = makeManager();
    const r = await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
    expect(r.content[0].type).toBe("text");
    expect(r.content[0].text).toContain('"ok":true');
    expect(r.content[0].text).toContain("s1");
    m.dispose();
  });

  test("browser_evaluate：视图未创建时报错提示先 navigate", async () => {
    const m = makeManager();
    const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "eval", script: "1+1" });
    expect(JSON.stringify(r)).toContain("navigate");
    m.dispose();
  });

  test("browser_evaluate eval：返回结果", async () => {
    const m = makeManager();
    await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
    const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "eval", script: "document.title" });
    expect(r.content[0].text).toContain("fake-title");
    m.dispose();
  });

  test("browser_evaluate eval：超长结果截断", async () => {
    const longStr = "x".repeat(20_000);
    const m = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-tools-")),
      viewFactory: () => makeFakeView({ async evaluate() { return longStr; } }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
    const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "eval", script: "1" });
    expect(r.content[0].text).toContain("截断");
    expect(r.content[0].text.length).toBeLessThan(8_200);
    m.dispose();
  });

  test("browser_evaluate click：选择器模式转发", async () => {
    const m = makeManager();
    await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
    const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "click", selector: "#btn" });
    expect(r.content[0].text).toContain('"ok":true');
    m.dispose();
  });

  test("browser_evaluate click：坐标模式转发 (x/y)", async () => {
    const m = makeManager();
    await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
    const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "click", x: 100, y: 200 });
    expect(r.content[0].text).toContain('"ok":true');
    m.dispose();
  });

  test("browser_evaluate：非法 action 报错", async () => {
    const m = makeManager();
    await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
    const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "hack" } as never);
    expect(JSON.stringify(r)).toContain("unknown_action");
    m.dispose();
  });

  test("browser_screenshot path 模式：写文件并返回路径", async () => {
    const m = makeManager();
    await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
    const r = await handleBrowserTool(m, "s1", "browser_screenshot", {});
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.path).toBe("string");
    expect(readFileSync(parsed.path).length).toBeGreaterThan(0);
    m.dispose();
  });

  test("browser_screenshot base64 模式：返回 data URL", async () => {
    const m = makeManager();
    await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
    const r = await handleBrowserTool(m, "s1", "browser_screenshot", { return: "base64" });
    expect(r.content[0].text).toContain("data:image/png;base64,");
    m.dispose();
  });

  test("browser_close：销毁视图", async () => {
    const m = makeManager();
    await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
    const r = await handleBrowserTool(m, "s1", "browser_close", {});
    expect(r.content[0].text).toContain('"closed":true');
    expect(m.get("s1")).toBeUndefined();
    m.dispose();
  });
});

describe("runWithRetry / withTimeout（经 handleBrowserTool 行为路径）", () => {
  // runWithRetry：Bun.WebView 并发槽冲突抛 ERR_INVALID_STATE，应递增间隔重试后成功
  test("ERR_INVALID_STATE 首次失败后重试成功", async () => {
    let calls = 0;
    const m = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-tools-retry-")),
      viewFactory: () =>
        makeFakeView({
          async navigate() {
            calls++;
            if (calls === 1) throw new Error("ERR_INVALID_STATE: 并发操作");
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    try {
      const r = await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
      expect(r.content[0].text).toContain('"ok":true');
      expect(calls).toBe(2); // 首次失败 + 重试成功
    } finally {
      m.dispose();
    }
  });

  test("ERR_INVALID_STATE 持续失败达重试上限后返回错误（不无限重试）", async () => {
    let calls = 0;
    const m = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-tools-retry2-")),
      viewFactory: () =>
        makeFakeView({
          async navigate() {
            calls++;
            throw new Error("ERR_INVALID_STATE: 并发操作");
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    try {
      const r = await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
      // 1 次初始 + 3 次重试 = 4 次调用后放弃
      expect(calls).toBe(4);
      expect(JSON.stringify(r)).toContain("导航失败");
    } finally {
      m.dispose();
    }
  });

  // withTimeout：Promise.race 超时，避免 WebView 操作永久挂起
  test("navigate 永久挂起时按 timeout 超时返回错误（不无限等待）", async () => {
    const m = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-tools-timeout-")),
      viewFactory: () =>
        makeFakeView({
          navigate() {
            return new Promise<void>(() => {}); // 永不 resolve
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    try {
      // navigateTool 接受 timeout 参数注入；设 200ms 让测试快速结束
      const r = await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", timeout: 200 });
      expect(JSON.stringify(r)).toContain("超时");
    } finally {
      m.dispose();
    }
  });

  test("正常操作不受超时影响（timeout 内完成）", async () => {
    const m = makeManager();
    try {
      const r = await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", timeout: 500 });
      expect(r.content[0].text).toContain('"ok":true');
    } finally {
      m.dispose();
    }
  });
});
