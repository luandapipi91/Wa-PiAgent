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

describe("browser_* 错误分支与参数透传", () => {
  // ---------- 错误分支（fake view 注入失败，断言错误码/文本） ----------

  test("handleBrowserTool 未知工具：返回 unknown_tool", async () => {
    const m = makeManager();
    const r = await handleBrowserTool(m, "s1", "browser_xxx", {});
    expect(JSON.stringify(r)).toContain("unknown_tool");
    expect(r.content[0].text).toContain("未知 browser 工具");
    m.dispose();
  });

  test("browser_navigate 引擎不可用：返回 engine_unavailable", async () => {
    const m = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-tools-")),
      viewFactory: () =>
        makeFakeView({
          async navigate() {
            throw new Error("spawn chrome ENOENT");
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    try {
      const r = await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
      expect(JSON.stringify(r)).toContain("engine_unavailable");
      expect(r.content[0].text).toContain("浏览器引擎不可用");
    } finally {
      m.dispose();
    }
  });

  test("browser_navigate 导航失败（非引擎）：返回 导航失败 与错误消息", async () => {
    const m = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-tools-")),
      viewFactory: () =>
        makeFakeView({
          async navigate() {
            throw new Error("net::ERR_NAME_NOT_RESOLVED");
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    try {
      const r = await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
      expect(JSON.stringify(r)).toContain("导航失败");
      expect(JSON.stringify(r)).toContain("net::ERR_NAME_NOT_RESOLVED");
    } finally {
      m.dispose();
    }
  });

  test("browser_evaluate 缺 action：返回 missing_action", async () => {
    const m = makeManager();
    await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
    const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: undefined });
    expect(JSON.stringify(r)).toContain("missing_action");
    m.dispose();
  });

  test("browser_evaluate eval 缺 script：返回 missing_script", async () => {
    const m = makeManager();
    await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
    const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "eval" });
    expect(JSON.stringify(r)).toContain("missing_script");
    m.dispose();
  });

  test("browser_evaluate eval 序列化失败：fallback 到 String(raw) 不抛异常", async () => {
    const circular = (() => {
      const o: Record<string, unknown> = {};
      o.self = o;
      return o;
    })();
    const m = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-tools-")),
      viewFactory: () => makeFakeView({ async evaluate() { return circular; } }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "eval", script: "1" });
      expect(r.content[0].text).toContain('"ok":true');
      expect(r.content[0].text).toContain("[object Object]");
    } finally {
      m.dispose();
    }
  });

  test("browser_evaluate click 缺目标：返回 missing_click_target", async () => {
    const m = makeManager();
    await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
    const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "click" });
    expect(JSON.stringify(r)).toContain("missing_click_target");
    m.dispose();
  });

  test("browser_evaluate type 缺 text：返回 missing_text", async () => {
    const m = makeManager();
    await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
    const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "type" });
    expect(JSON.stringify(r)).toContain("missing_text");
    m.dispose();
  });

  test("browser_evaluate press 缺 key：返回 missing_key", async () => {
    const m = makeManager();
    await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
    const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "press" });
    expect(JSON.stringify(r)).toContain("missing_key");
    m.dispose();
  });

  test("browser_evaluate scrollTo 缺 selector：返回 missing_selector", async () => {
    const m = makeManager();
    await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
    const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "scrollTo" });
    expect(JSON.stringify(r)).toContain("missing_selector");
    m.dispose();
  });

  test("browser_screenshot 视图未创建：返回 no_view", async () => {
    const m = makeManager();
    const r = await handleBrowserTool(m, "s1", "browser_screenshot", {});
    expect(JSON.stringify(r)).toContain("no_view");
    m.dispose();
  });

  test("browser_screenshot 失败：返回 截图失败 与错误消息", async () => {
    const m = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-tools-")),
      viewFactory: () =>
        makeFakeView({
          async screenshot() {
            throw new Error("screenshot failed");
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
      const r = await handleBrowserTool(m, "s1", "browser_screenshot", {});
      expect(JSON.stringify(r)).toContain("截图失败");
      expect(JSON.stringify(r)).toContain("screenshot failed");
    } finally {
      m.dispose();
    }
  });

  test("browser_evaluate 操作抛错：错误含动作名与页面上下文", async () => {
    const m = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-tools-")),
      viewFactory: () =>
        makeFakeView({
          async evaluate() {
            throw new Error("boom");
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "eval", script: "1" });
      const text = r.content[0].text;
      expect(text).toContain("browser_evaluate");
      expect(text).toContain("失败");
      expect(text).toContain("about:blank"); // fake view 的 url（navigate 未更新 url 字段）
    } finally {
      m.dispose();
    }
  });

  test("browser_close 视图不存在：closed=false 且 ok（幂等）", async () => {
    const m = makeManager();
    const r = await handleBrowserTool(m, "s1", "browser_close", {});
    expect(r.content[0].text).toContain('"ok":true');
    expect(r.content[0].text).toContain('"closed":false');
    m.dispose();
  });

  // ---------- 参数透传（fake view 记录调用并断言） ----------

  test("browser_evaluate type：text 透传到 view.type", async () => {
    const typed: string[] = [];
    const m = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-tools-")),
      viewFactory: () =>
        makeFakeView({
          async type(text: string) {
            typed.push(text);
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "type", text: "hello" });
      expect(typed).toEqual(["hello"]);
      expect(r.content[0].text).toContain('"ok":true');
    } finally {
      m.dispose();
    }
  });

  test("browser_evaluate press：key 与 modifiers 透传到 view.press", async () => {
    const pressed: Array<[string, unknown]> = [];
    const m = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-tools-")),
      viewFactory: () =>
        makeFakeView({
          async press(key: string, opts?: unknown) {
            pressed.push([key, opts]);
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "press", key: "Enter", modifiers: ["Shift"] });
      expect(pressed).toEqual([["Enter", { modifiers: ["Shift"] }]]);
      expect(r.content[0].text).toContain('"ok":true');
    } finally {
      m.dispose();
    }
  });

  test("browser_evaluate scroll：dx/dy 透传，缺省为 0,0", async () => {
    const scrolled: Array<[number, number]> = [];
    const m = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-tools-")),
      viewFactory: () =>
        makeFakeView({
          async scroll(dx: number, dy: number) {
            scrolled.push([dx, dy]);
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
      const r1 = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "scroll", dx: 10, dy: 20 });
      expect(scrolled).toEqual([[10, 20]]);
      const r2 = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "scroll" });
      expect(scrolled).toEqual([[10, 20], [0, 0]]);
      expect(r1.content[0].text).toContain('"ok":true');
      expect(r2.content[0].text).toContain('"ok":true');
    } finally {
      m.dispose();
    }
  });

  test("browser_evaluate scrollTo：selector 与 block 透传", async () => {
    const scrollTos: Array<[string, unknown]> = [];
    const m = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-tools-")),
      viewFactory: () =>
        makeFakeView({
          async scrollTo(selector: string, opts?: unknown) {
            scrollTos.push([selector, opts]);
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "scrollTo", selector: "#footer", block: "start" });
      expect(scrollTos).toEqual([["#footer", { block: "start" }]]);
      expect(r.content[0].text).toContain('"ok":true');
    } finally {
      m.dispose();
    }
  });

  test("browser_evaluate click 选择器模式：selector 与 button 透传（cleanOpts 过滤 undefined）", async () => {
    const clicked: Array<[string, unknown]> = [];
    const m = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-tools-")),
      viewFactory: () =>
        makeFakeView({
          async click(selectorOrX: string | number, yOrOpts?: unknown) {
            clicked.push([selectorOrX as string, yOrOpts]);
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "click", selector: "#btn", button: "right" });
      expect(clicked).toEqual([["#btn", { button: "right" }]]);
      expect(r.content[0].text).toContain('"ok":true');
    } finally {
      m.dispose();
    }
  });
});
