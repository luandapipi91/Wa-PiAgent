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
      // toStrictEqual 区分 undefined 属性：锁定 cleanOpts 把未传的 timeout 从 opts 剔除
      expect(scrollTos).toStrictEqual([["#footer", { block: "start" }]]);
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
      // toStrictEqual 区分 undefined 属性：锁定 cleanOpts 把未传的 modifiers/clickCount/timeout 剔除
      expect(clicked).toStrictEqual([["#btn", { button: "right" }]]);
      expect(r.content[0].text).toContain('"ok":true');
    } finally {
      m.dispose();
    }
  });
});

describe("browser_screenshot annotate", () => {
  const fakeRefs = { "@1": { n: 1, tag: "button", label: "go", x: 50, y: 30 } };

  function makeAnnotateManager(evaluateImpl: (script: string) => unknown) {
    return new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-annotate-")),
      viewFactory: () =>
        makeFakeView({
          async evaluate(script: string) {
            return script.includes("wa-annotate") ? evaluateImpl(script) : script;
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
  }

  test("annotate:true：注入脚本、返回 refs 并写入会话缓存", async () => {
    const m = makeAnnotateManager(() => fakeRefs);
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
      const r = await handleBrowserTool(m, "s1", "browser_screenshot", { annotate: true });
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.refs["@1"].label).toBe("go");
      expect(m.get("s1")?.refs?.["@1"]?.tag).toBe("button");
    } finally {
      m.dispose();
    }
  });

  test("annotate:true：注入失败时整体报错、不返回截图", async () => {
    const m = makeAnnotateManager(() => {
      throw new Error("inject failed");
    });
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
      const r = await handleBrowserTool(m, "s1", "browser_screenshot", { annotate: true });
      // errResult 的 content 是纯文本（非 JSON），断言报错信息存在且无成功标记
      expect(r.content[0].text).toContain("inject failed");
      expect(r.content[0].text).not.toContain('"ok":true');
    } finally {
      m.dispose();
    }
  });

  test("不传 annotate：行为不变、返回体无 refs 字段", async () => {
    const m = makeAnnotateManager(() => fakeRefs);
    try {
      // snapshot:false 隔离 navigate 的自动快照，只验证 screenshot 自身语义
      await handleBrowserTool(m, "s1", "browser_navigate", {
        url: "http://example.com",
        snapshot: false,
      });
      const r = await handleBrowserTool(m, "s1", "browser_screenshot", {});
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.refs).toBeUndefined();
    } finally {
      m.dispose();
    }
  });

  test("browser_navigate 后旧 refs/selectorMap 清空（过期锚点不得被消费）", async () => {
    const m = makeAnnotateManager(() => fakeRefs);
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      // 预置上一轮过期的 annotate refs 与快照 selectorMap
      (m.get("s1") as { refs?: unknown; selectorMap?: unknown }).refs = {
        "@9": { n: 9, tag: "div", label: "stale", x: 0, y: 0 },
      };
      (m.get("s1") as { selectorMap?: unknown }).selectorMap = { 999: { role: "button", name: "stale" } };
      // 第二次导航：旧缓存全部失效清空
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      expect(m.get("s1")?.refs?.["@9"]).toBeUndefined();
      expect(m.get("s1")?.selectorMap?.[999]).toBeUndefined();
    } finally {
      m.dispose();
    }
  });
});

describe("browser_evaluate click ref（backendDOMNodeId 新链路）", () => {
  /** 登录页形态 AX 树：RootWebArea → heading/textbox/button */
  const AX_LOGIN: unknown = {
    nodes: [
      { nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2", "3", "4"] },
      { nodeId: "2", role: { type: "role", value: "heading" }, name: { type: "computedString", value: "慧来客" }, backendDOMNodeId: 10 },
      { nodeId: "3", role: { type: "role", value: "textbox" }, name: { type: "computedString", value: "请输入手机号" }, backendDOMNodeId: 12 },
      { nodeId: "4", role: { type: "role", value: "button" }, name: { type: "computedString", value: "登 录" }, backendDOMNodeId: 15 },
    ],
  };

  /**
   * click ref fake：cdp 提供 AX 树与 getBoxModel（boxes 表驱动；未命中抛错模拟失效），
   * evaluate 提供遮挡探针结果。
   */
  function makeRefManager(opts: {
    boxes?: Record<number, number[]>;
    axTree?: unknown;
    occlusion?: unknown;
    probeError?: boolean;
  } = {}) {
    const clicked: Array<[unknown, unknown]> = [];
    const probes: string[] = [];
    const cdpCalls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const m = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-ref-")),
      viewFactory: () =>
        makeFakeView({
          async evaluate(script: string) {
            if (script.includes("wa-occlusion")) {
              if (opts.probeError) throw new Error("probe boom");
              probes.push(script);
              return opts.occlusion ?? { occluded: false };
            }
            return script;
          },
          async cdp(method: string, params?: Record<string, unknown>) {
            cdpCalls.push({ method, params });
            if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "u-1" } } };
            if (method === "Accessibility.getFullAXTree") return opts.axTree ?? AX_LOGIN;
            if (method === "DOM.scrollIntoViewIfNeeded") return {};
            if (method === "DOM.getBoxModel") {
              const quad = opts.boxes?.[Number(params?.backendNodeId)];
              if (!quad) throw new Error("No node with id");
              return { model: { content: quad } };
            }
            return {};
          },
          async click(a?: unknown, b?: unknown) {
            clicked.push([a, b]);
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    return { m, clicked, probes, cdpCalls };
  }

  async function seedSelectorMap(m: BrowserManager, map: Record<number, { role: string; name: string }>) {
    await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
    (m.get("s1") as { selectorMap?: unknown }).selectorMap = map;
  }

  test("click ref：getBoxModel quad 中心坐标真实点击（先 scrollIntoViewIfNeeded）", async () => {
    const { m, clicked, cdpCalls } = makeRefManager({
      boxes: { 15: [10, 20, 30, 20, 30, 40, 10, 40] },
    });
    try {
      await seedSelectorMap(m, { 15: { role: "button", name: "登 录" } });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "click", ref: 15 });
      expect(r.content[0].text).toContain('"ok":true');
      expect(clicked[0]?.[0]).toBe(20); // quad 四点平均
      expect(clicked[0]?.[1]).toBe(30);
      const idxScroll = cdpCalls.findIndex((c) => c.method === "DOM.scrollIntoViewIfNeeded");
      const idxBox = cdpCalls.findIndex((c) => c.method === "DOM.getBoxModel");
      expect(idxBox).toBeGreaterThan(idxScroll);
    } finally {
      m.dispose();
    }
  });

  test("click ref：selectorMap 无此 ref → invalid_ref 提示重新 snapshot", async () => {
    const { m } = makeRefManager({ boxes: { 15: [0, 0, 1, 0, 1, 1, 0, 1] } });
    try {
      await seedSelectorMap(m, { 15: { role: "button", name: "登 录" } });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "click", ref: 99 });
      expect(JSON.stringify(r)).toContain("invalid_ref");
      expect(r.content[0].text).toContain("browser_snapshot");
    } finally {
      m.dispose();
    }
  });

  test("click ref：原 ref 失效 → AX 重拉按 role+name 唯一回查新 backendId 并更新缓存", async () => {
    const { m, clicked } = makeRefManager({
      boxes: { 15: [0, 0, 20, 0, 20, 10, 0, 10] }, // 只有新 id=15 有盒子；旧 id=99 抛错触发回查
    });
    try {
      await seedSelectorMap(m, { 99: { role: "button", name: "登 录" } });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "click", ref: 99 });
      expect(r.content[0].text).toContain('"ok":true');
      expect(clicked[0]?.[0]).toBe(10);
      // 回查结果写回 selectorMap：后续点击直接命中新 id
      expect(m.get("s1")?.selectorMap?.[15]).toStrictEqual({ role: "button", name: "登 录" });
    } finally {
      m.dispose();
    }
  });

  test("click ref：回查重名歧义 → 报错要求重新 snapshot（宁失效不错点）", async () => {
    const dupTree = {
      nodes: [
        { nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2", "3"] },
        { nodeId: "2", role: { type: "role", value: "button" }, name: { type: "computedString", value: "登 录" }, backendDOMNodeId: 15 },
        { nodeId: "3", role: { type: "role", value: "button" }, name: { type: "computedString", value: "登 录" }, backendDOMNodeId: 16 },
      ],
    };
    const { m, clicked } = makeRefManager({ axTree: dupTree });
    try {
      await seedSelectorMap(m, { 99: { role: "button", name: "登 录" } });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "click", ref: 99 });
      expect(JSON.stringify(r)).toContain("invalid_ref");
      expect(r.content[0].text).toContain("多个");
      expect(r.content[0].text).toContain("重新 browser_snapshot");
      expect(clicked.length).toBe(0);
    } finally {
      m.dispose();
    }
  });

  test("click ref：非法编号（0 / 1.5 / 负数）报 invalid_ref", async () => {
    const { m } = makeRefManager({ boxes: { 15: [0, 0, 1, 0, 1, 1, 0, 1] } });
    try {
      await seedSelectorMap(m, { 15: { role: "button", name: "登 录" } });
      for (const bad of [0, 1.5, -3]) {
        const r = await handleBrowserTool(m, "s1", "browser_evaluate", {
          action: "click",
          ref: bad,
        });
        expect(JSON.stringify(r)).toContain("invalid_ref");
      }
    } finally {
      m.dispose();
    }
  });

  test("click ref：遮挡校验走坐标+文本模式，报遮挡时不派发点击", async () => {
    const { m, clicked, probes } = makeRefManager({
      boxes: { 15: [10, 20, 30, 20, 30, 40, 10, 40] },
      occlusion: { occluded: true, occluder: { tag: "div", cls: "mask", text: "遮罩文本" } },
    });
    try {
      await seedSelectorMap(m, { 15: { role: "button", name: "登 录" } });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "click", ref: 15, snapshot: false });
      expect(JSON.stringify(r)).toContain("click_occluded");
      expect(clicked.length).toBe(0);
      // 新链路探针带定位阶段算好的 quad 中心坐标 + 目标文本（不再有 data-wa-ref 锚点）
      expect(probes[0]).toContain("wa-occlusion");
      expect(probes[0]).not.toContain("data-wa-ref");
      expect(probes[0]).toContain("登 录");
    } finally {
      m.dispose();
    }
  });
});

describe("操作后自动快照（差值+稳定检测）", () => {
  const S1 = { "@1": { n: 1, tag: "button", label: "登 录", x: 10, y: 20 } };
  const S2 = {
    "@1": {
      n: 1,
      tag: "input",
      inputType: "text",
      label: "手机号",
      value: "132",
      x: 10,
      y: 20,
    },
  };

  // 帧序列按消费次序给足（稳定检测每帧消费一次，末帧重复返回）
  function makeAutoSnapManager(frames: Record<string, unknown>[]) {
    let i = 0;
    const m = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-autosnap-")),
      viewFactory: () =>
        makeFakeView({
          async evaluate(script: string) {
            if (!script.includes("wa-snapshot")) return script;
            return frames[Math.min(i++, frames.length - 1)];
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    return m;
  }

  test("navigate 默认附首帧快照（无星；降级线无 selectorMap 产物）", async () => {
    const m = makeAutoSnapManager([S1, S1]);
    try {
      const r = await handleBrowserTool(m, "s1", "browser_navigate", {
        url: "http://example.com",
      });
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.snapshot).toContain('@1 button "登 录"');
      expect(parsed.snapshot).not.toContain("* ");
      // 平铺降级线（fake 无 cdp）无 selectorMap 产物；AX 线的 selectorMap 写入见下用例
      expect(parsed.refCount).toBe(0);
      expect(m.get("s1")?.selectorMap).toBeUndefined();
    } finally {
      m.dispose();
    }
  });

  test("操作后页面有变化 → snapshot 带星行", async () => {
    const m = makeAutoSnapManager([S1, S1, S2, S2]);
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", {
        action: "click",
        selector: "#btn",
      });
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.snapshot).toContain('* @1 textbox "手机号" = "132"');
      expect(parsed.snapshotUnchanged).toBeUndefined();
    } finally {
      m.dispose();
    }
  });

  test("操作后无变化 → snapshotUnchanged 且无 snapshot 字段", async () => {
    const m = makeAutoSnapManager([S1, S1, S1, S1]);
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", {
        action: "click",
        selector: "#btn",
      });
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.snapshotUnchanged).toBe(true);
      expect(parsed.snapshot).toBeUndefined();
    } finally {
      m.dispose();
    }
  });

  test("snapshot:false → 不抓帧、无附加字段", async () => {
    const m = makeAutoSnapManager([S1]);
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", {
        url: "http://example.com",
        snapshot: false,
      });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", {
        action: "click",
        selector: "#btn",
        snapshot: false,
      });
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.snapshot).toBeUndefined();
      expect(parsed.snapshotUnchanged).toBeUndefined();
      // 从未抓帧：refs 缓存从未被填充
      expect(m.get("s1")?.refs).toBeUndefined();
    } finally {
      m.dispose();
    }
  });

  test("快照注入失败 → 操作仍成功 + snapshotError", async () => {
    const m = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-autosnap-")),
      viewFactory: () =>
        makeFakeView({
          async evaluate(script: string) {
            if (script.includes("wa-snapshot")) throw new Error("inject boom");
            return script;
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", {
        action: "click",
        selector: "#btn",
      });
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.snapshotError).toContain("inject boom");
    } finally {
      m.dispose();
    }
  });

  test("导航后页面始终未渲染出元素 → snapshotNote 提示而非空快照", async () => {
    const m = makeAutoSnapManager([{}]); // 恒空帧：SPA 首屏未挂载的降级场景
    try {
      const r = await handleBrowserTool(m, "s1", "browser_navigate", {
        url: "http://example.com",
      });
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.refCount).toBe(0);
      expect(parsed.snapshot).toBeUndefined(); // 空文本不作为快照返回
      expect(parsed.snapshotNote).toContain("browser_snapshot");
      // 空快照不污染差值基准（lastSnapshot 保持无基准状态）
      expect(m.get("s1")?.lastSnapshot).toBeUndefined();
    } finally {
      m.dispose();
    }
  });

  test("eval 不附快照", async () => {
    const m = makeAutoSnapManager([S1]);
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", {
        action: "eval",
        script: "document.title",
      });
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.snapshot).toBeUndefined();
      expect(parsed.snapshotUnchanged).toBeUndefined();
    } finally {
      m.dispose();
    }
  });
});

describe("browser_snapshot 文本快照（AX 树形线）", () => {
  /** 登录页形态 AX 树 fixture（heading/text/textbox/button） */
  const AX_LOGIN = {
    nodes: [
      { nodeId: "1", role: { type: "role", value: "RootWebArea" }, name: { type: "computedString", value: "慧来客" }, childIds: ["2", "3", "4", "5"] },
      { nodeId: "2", role: { type: "role", value: "heading" }, name: { type: "computedString", value: "慧来客" }, backendDOMNodeId: 10 },
      { nodeId: "3", role: { type: "role", value: "StaticText" }, name: { type: "computedString", value: "手机号登录后可进行后续操作" } },
      { nodeId: "4", role: { type: "role", value: "textbox" }, name: { type: "computedString", value: "请输入手机号" }, backendDOMNodeId: 12 },
      { nodeId: "5", role: { type: "role", value: "button" }, name: { type: "computedString", value: "登 录" }, backendDOMNodeId: 15 },
    ],
  };

  /** AX 线 fake（cdp 可用）；failAx 时 cdp 抛错走降级平铺线 */
  function makeSnapManager(opts: { axTree?: unknown; failAx?: boolean; flatFrames?: unknown[] } = {}) {
    let i = 0;
    const m = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-snap-")),
      viewFactory: () =>
        makeFakeView({
          async evaluate(script: string) {
            if (script.includes("wa-snapshot")) {
              const frames = opts.flatFrames ?? [];
              return frames[Math.min(i++, Math.max(frames.length - 1, 0))];
            }
            return script;
          },
          async cdp(method: string) {
            if (opts.failAx) throw new Error("ax boom");
            if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "u-1" } } };
            if (method === "Accessibility.getFullAXTree") return opts.axTree ?? AX_LOGIN;
            return {};
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    return m;
  }

  test("snapshot：树形缩进文本 + selectorMap 缓存（ref=backendDOMNodeId）", async () => {
    const m = makeSnapManager();
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      const r = await handleBrowserTool(m, "s1", "browser_snapshot", {});
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.refCount).toBe(3); // heading/textbox/button
      expect(parsed.snapshot).toContain('- heading "慧来客" [ref=10]');
      expect(parsed.snapshot).toContain('- text "手机号登录后可进行后续操作"');
      expect(parsed.snapshot).toContain('- textbox "请输入手机号" = "" [ref=12]');
      expect(parsed.snapshot).toContain('- button "登 录" [ref=15]');
      // selectorMap 写入会话供 click ref 回查
      expect(m.get("s1")?.selectorMap?.[15]).toStrictEqual({ role: "button", name: "登 录" });
    } finally {
      m.dispose();
    }
  });

  test("snapshot：AX 线失败 → 降级平铺线（兼容产物，无 selectorMap）", async () => {
    const m = makeSnapManager({
      failAx: true,
      flatFrames: [{ "@2": { n: 2, tag: "button", label: "登 录", x: 1, y: 1 } }],
    });
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      const r = await handleBrowserTool(m, "s1", "browser_snapshot", {});
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.snapshot).toContain('@2 button "登 录"');
      expect(m.get("s1")?.selectorMap).toBeUndefined();
    } finally {
      m.dispose();
    }
  });

  test("snapshot：双线均失败（平铺线返回非对象）报错", async () => {
    const m = makeSnapManager({ failAx: true, flatFrames: ["not-an-object"] });
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      const r = await handleBrowserTool(m, "s1", "browser_snapshot", {});
      expect(r.content[0].text).toContain("browser_snapshot 失败"); // lastError（ax boom）优先呈现
    } finally {
      m.dispose();
    }
  });

  test("snapshot：视图未创建报错", async () => {
    const m = makeSnapManager();
    try {
      const r = await handleBrowserTool(m, "s1", "browser_snapshot", {});
      expect(JSON.stringify(r)).toContain("no_view");
    } finally {
      m.dispose();
    }
  });

  test("snapshot 后 click ref 用 selectorMap（真实快照产物→点击）", async () => {
    const m = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-snap-")),
      viewFactory: () =>
        makeFakeView({
          async evaluate(script: string) {
            if (script.includes("wa-occlusion")) return { occluded: false };
            return script;
          },
          async cdp(method: string, params?: Record<string, unknown>) {
            if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "u-1" } } };
            if (method === "Accessibility.getFullAXTree") return AX_LOGIN;
            if (method === "DOM.scrollIntoViewIfNeeded") return {};
            if (method === "DOM.getBoxModel") {
              if (Number(params?.backendNodeId) === 15) {
                return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
              }
              throw new Error("No node with id");
            }
            return {};
          },
          async click(a?: unknown) {
            clickedSnap.push(a);
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    const clickedSnap: unknown[] = [];
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      await handleBrowserTool(m, "s1", "browser_snapshot", {});
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "click", ref: 15, snapshot: false });
      expect(r.content[0].text).toContain('"ok":true');
      expect(clickedSnap[0]).toBe(5);
    } finally {
      m.dispose();
    }
  });
});

describe("browser_evaluate click text 文本定位", () => {
  function makeTextManager(evalResult: unknown) {
    const clicked: Array<[unknown, unknown]> = [];
    const m = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-text-")),
      viewFactory: () =>
        makeFakeView({
          async evaluate(script: string) {
            if (script.includes("wa-click-text")) return evalResult;
            if (script.includes("wa-occlusion")) return { occluded: false };
            return script;
          },
          async cdp(method: string) {
            if (method === "DOM.scrollIntoViewIfNeeded") return {};
            if (method === "DOM.getBoxModel") {
              return { model: { content: [0, 0, 14, 0, 14, 8, 0, 8] } };
            }
            return {};
          },
          async click(a?: unknown, b?: unknown) {
            clicked.push([a, b]);
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    return { m, clicked };
  }

  test("text 模式：定位元素中心并坐标真实点击", async () => {
    const { m, clicked } = makeTextManager({ found: true, x: 111, y: 222, label: "盘点完成" });
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", {
        url: "http://example.com",
        snapshot: false,
      });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", {
        action: "click",
        text: "盘点完成",
      });
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.textMatch).toBe("盘点完成");
      expect(clicked[0]?.[0]).toBe(111);
      expect(clicked[0]?.[1]).toBe(222);
    } finally {
      m.dispose();
    }
  });

  test("text 未找到 → click_text_not_found 并提示替代手段", async () => {
    const { m } = makeTextManager({ found: false });
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", {
        url: "http://example.com",
        snapshot: false,
      });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", {
        action: "click",
        text: "不存在的按钮",
      });
      expect(JSON.stringify(r)).toContain("click_text_not_found");
      expect(r.content[0].text).toContain("browser_snapshot");
    } finally {
      m.dispose();
    }
  });

  test("ref 与 text 并存 → ref 优先（不触发文本脚本）", async () => {
    const { m, clicked } = makeTextManager({ found: true, x: 111, y: 222, label: "盘点完成" });
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", {
        url: "http://example.com",
        snapshot: false,
      });
      (m.get("s1") as { selectorMap?: unknown }).selectorMap = { 1: { role: "button", name: "go" } };
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", {
        action: "click",
        ref: 1,
        text: "盘点完成",
      });
      expect(r.content[0].text).toContain('"ref":1');
      expect(clicked[0]?.[0]).toBe(7); // ref 路径的 quad 中心坐标
      expect(clicked[0]?.[1]).toBe(4);
    } finally {
      m.dispose();
    }
  });

  test("text 为空白 → invalid_click_text", async () => {
    const { m } = makeTextManager({ found: true, x: 1, y: 1 });
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", {
        url: "http://example.com",
        snapshot: false,
      });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", {
        action: "click",
        text: "   ",
      });
      expect(JSON.stringify(r)).toContain("invalid_click_text");
    } finally {
      m.dispose();
    }
  });
});

describe("browser_read 读页面文本", () => {
  function makeReadManager(evalResult: unknown) {
    return new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-read-")),
      viewFactory: () =>
        makeFakeView({
          async evaluate(script: string) {
            if (script.includes("wa-read")) return evalResult;
            return script;
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
  }

  test("无 selector：返回页面文本", async () => {
    const m = makeReadManager("第一行文本\n第二行 化石骨贴 20");
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      const r = await handleBrowserTool(m, "s1", "browser_read", {});
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.text).toContain("化石骨贴 20");
      expect(parsed.truncated).toBeUndefined();
    } finally {
      m.dispose();
    }
  });

  test("selector 指向不存在元素 → read_element_not_found", async () => {
    const m = makeReadManager(null);
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      const r = await handleBrowserTool(m, "s1", "browser_read", { selector: "#nope" });
      expect(JSON.stringify(r)).toContain("read_element_not_found");
    } finally {
      m.dispose();
    }
  });

  test("超长文本截断并标记 truncated", async () => {
    const m = makeReadManager("x".repeat(20_000));
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      const r = await handleBrowserTool(m, "s1", "browser_read", {});
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.truncated).toBe(true);
      expect(parsed.text.length).toBeLessThan(9_000);
    } finally {
      m.dispose();
    }
  });

  test("视图未创建 → no_view", async () => {
    const m = makeReadManager("t");
    try {
      const r = await handleBrowserTool(m, "s1", "browser_read", {});
      expect(JSON.stringify(r)).toContain("no_view");
    } finally {
      m.dispose();
    }
  });
});

describe("browser_wait 条件等待", () => {
  // 探针契约：evaluate 返回布尔（真实引擎 innerText.includes → boolean）
  function makeWaitManager(probeResults: boolean[]) {
    let i = 0;
    return new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-wait-")),
      viewFactory: () =>
        makeFakeView({
          async evaluate(script: string) {
            if (script.includes("wa-wait-text") || script.includes("wa-wait-hidden")) {
              return probeResults[Math.min(i++, probeResults.length - 1)];
            }
            return script;
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
  }

  test("text 立即满足 → ok", async () => {
    const m = makeWaitManager([true]);
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      const r = await handleBrowserTool(m, "s1", "browser_wait", { text: "操作成功" });
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.matched).toBe(true);
    } finally {
      m.dispose();
    }
  });

  test("text 轮询后满足 → ok（模拟渲染延迟）", async () => {
    const m = makeWaitManager([false, false, true]);
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      const r = await handleBrowserTool(m, "s1", "browser_wait", { text: "操作成功", timeout: 3000 });
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.matched).toBe(true);
    } finally {
      m.dispose();
    }
  });

  test("text 超时 → wait_timeout", async () => {
    const m = makeWaitManager([false]);
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      const r = await handleBrowserTool(m, "s1", "browser_wait", { text: "永不出现", timeout: 600 });
      expect(JSON.stringify(r)).toContain("wait_timeout");
    } finally {
      m.dispose();
    }
  });

  test("ms 模式：直接等待后 ok", async () => {
    const m = makeWaitManager([true]);
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      const r = await handleBrowserTool(m, "s1", "browser_wait", { ms: 50 });
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.waitedMs).toBeGreaterThanOrEqual(40);
    } finally {
      m.dispose();
    }
  });

  test("无任何条件 → wait_missing_condition", async () => {
    const m = makeWaitManager([true]);
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      const r = await handleBrowserTool(m, "s1", "browser_wait", {});
      expect(JSON.stringify(r)).toContain("wait_missing_condition");
    } finally {
      m.dispose();
    }
  });

  test("视图未创建 → no_view", async () => {
    const m = makeWaitManager([true]);
    try {
      const r = await handleBrowserTool(m, "s1", "browser_wait", { ms: 10 });
      expect(JSON.stringify(r)).toContain("no_view");
    } finally {
      m.dispose();
    }
  });
});

describe("browser_wait 命中后自动附快照（2026-11-03）", () => {
  /** 稳定 AX 树：button "go" + heading "待命页"（有名 content 角色也有 ref） */
  const AX_WAIT_TREE: unknown = {
    nodes: [
      { nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2", "3"] },
      { nodeId: "2", role: { type: "role", value: "button" }, name: { type: "computedString", value: "go" }, backendDOMNodeId: 5 },
      { nodeId: "3", role: { type: "role", value: "heading" }, name: { type: "computedString", value: "待命页" }, backendDOMNodeId: 7 },
    ],
  };

  /** wait fake：探测结果可控，AX 树恒定（供 attachAutoSnapshot 走 AX 线） */
  function makeWaitSnapManager(opts: { textHit?: boolean; hiddenHit?: boolean } = {}) {
    const m = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-waitsnap-")),
      viewFactory: () =>
        makeFakeView({
          async evaluate(script: string) {
            if (script.includes("wa-wait-text")) return opts.textHit === true;
            if (script.includes("wa-wait-hidden")) return opts.hiddenHit === true;
            return script;
          },
          async cdp(method: string) {
            if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "u-1" } } };
            if (method === "Accessibility.getFullAXTree") return AX_WAIT_TREE;
            return {};
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    return m;
  }

  const HINT = "提示：操作元素优先用上方快照中的 [ref=";

  test("wait text 命中 → 返回体附 snapshot（提示首行+树形行）与 refCount", async () => {
    const m = makeWaitSnapManager({ textHit: true });
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      const r = await handleBrowserTool(m, "s1", "browser_wait", { text: "go", timeout: 2000 });
      const parsed = JSON.parse(r.content[0].text) as {
        ok?: boolean; matched?: boolean; snapshot?: string; refCount?: number; hint?: string;
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.matched).toBe(true);
      expect(parsed.snapshot?.startsWith(HINT)).toBe(true);
      expect(parsed.snapshot).toContain('- button "go" [ref=5]');
      expect(parsed.refCount).toBe(2); // button + 有名 heading
    } finally {
      m.dispose();
    }
  });

  test("wait 命中但页面无变化 → snapshotUnchanged + hint 字段降级", async () => {
    const m = makeWaitSnapManager({ textHit: true });
    try {
      // navigate 默认附快照 → 基准已建立；wait 后页面同基准 → unchanged
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
      const r = await handleBrowserTool(m, "s1", "browser_wait", { text: "go", timeout: 2000 });
      const parsed = JSON.parse(r.content[0].text) as {
        snapshotUnchanged?: boolean; hint?: string; snapshot?: string;
      };
      expect(parsed.snapshotUnchanged).toBe(true);
      expect(parsed.snapshot).toBeUndefined();
      expect(parsed.hint).toContain("[ref=");
    } finally {
      m.dispose();
    }
  });

  test("wait ms 固定等待完成 → 附快照", async () => {
    const m = makeWaitSnapManager({});
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      const r = await handleBrowserTool(m, "s1", "browser_wait", { ms: 50 });
      const parsed = JSON.parse(r.content[0].text) as { ok?: boolean; snapshot?: string; refCount?: number };
      expect(parsed.ok).toBe(true);
      expect(parsed.snapshot?.startsWith(HINT)).toBe(true);
      expect(parsed.refCount).toBe(2);
    } finally {
      m.dispose();
    }
  });

  test("wait hiddenSelector 命中 → 附快照", async () => {
    const m = makeWaitSnapManager({ hiddenHit: true });
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      const r = await handleBrowserTool(m, "s1", "browser_wait", { hiddenSelector: "#loading", timeout: 2000 });
      const parsed = JSON.parse(r.content[0].text) as { ok?: boolean; matched?: boolean; snapshot?: string };
      expect(parsed.ok).toBe(true);
      expect(parsed.snapshot?.startsWith(HINT)).toBe(true);
    } finally {
      m.dispose();
    }
  });

  test("wait 超时 → 错误文本附当前页面快照（模型自查未等到原因）", async () => {
    const m = makeWaitSnapManager({ textHit: false });
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      const r = await handleBrowserTool(m, "s1", "browser_wait", { text: "never", timeout: 400 });
      const text = r.content[0].text;
      expect(text).toContain("等待超时");
      expect((r.details as { error?: string }).error).toBe("wait_timeout");
      // 附当前快照：提示首行 + 树形行（模型直接判断页面状态，免再 snapshot）
      expect(text).toContain("当前页面快照");
      expect(text).toContain(HINT);
      expect(text).toContain('[ref=5]');
    } finally {
      m.dispose();
    }
  });
});

describe("click selector 鲁棒性（无效选择器快速失败+错误引导）", () => {
  function makeSelManager(clickErr?: Error) {
    return new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-sel-")),
      viewFactory: () =>
        makeFakeView({
          async click(selectorOrX: string | number) {
            if (clickErr) throw clickErr;
            void selectorOrX;
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
  }

  test("selector 为字面 null/undefined/空白 → 立即 invalid_click_selector（不烧超时）", async () => {
    for (const bad of ["null", "undefined", "   "]) {
      const m = makeSelManager();
      try {
        await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
        const r = await handleBrowserTool(m, "s1", "browser_evaluate", {
          action: "click",
          selector: bad,
        });
        expect(JSON.stringify(r)).toContain("invalid_click_selector");
        expect(r.content[0].text).toContain("text");
      } finally {
        m.dispose();
      }
    }
  });

  test("selector 超时未命中 → 错误信息引导 text 定位/snapshot", async () => {
    const m = makeSelManager(new Error("timeout waiting for '#nope' to be actionable"));
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", {
        action: "click",
        selector: "#nope",
      });
      expect(JSON.stringify(r)).toContain("invalid_click_selector");
      expect(r.content[0].text).toContain("#nope");
      expect(r.content[0].text).toContain("browser_snapshot");
    } finally {
      m.dispose();
    }
  });
});

describe("browser_evaluate hover 悬停动作", () => {
  function makeHoverManager(locResult: unknown, withCdp = true) {
    const cdpCalls: Array<{ method: string; params?: unknown }> = [];
    const m = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-hover-")),
      viewFactory: () => {
        const base = makeFakeView({
          async evaluate(script: string) {
            if (script.includes("wa-hover")) return locResult;
            return script;
          },
        }) as WebViewLike & { cdp?: unknown };
        if (withCdp) {
          base.cdp = async (method: string, params?: unknown) => {
            cdpCalls.push({ method, params });
            return {};
          };
        }
        return base;
      },
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    return { m, cdpCalls };
  }

  test("hover text：定位后 CDP 真实鼠标移动 + 附快照", async () => {
    const { m, cdpCalls } = makeHoverManager({ found: true, x: 131, y: 42, label: "库存" });
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "hover", text: "库存" });
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.hovered).toContain("库存");
      const mv = cdpCalls.find((c) => c.method === "Input.dispatchMouseEvent");
      expect(mv).toBeDefined();
      expect((mv!.params as { type: string }).type).toBe("mouseMoved");
      expect((mv!.params as { x: number }).x).toBe(131);
      expect((mv!.params as { y: number }).y).toBe(42);
      // 附自动快照机制运行：fake cdp 无 AX 实现 → 快照以 snapshotError 可观测（不阻断 hover 成功）
      expect(parsed.snapshotError).toBeDefined();
    } finally {
      m.dispose();
    }
  });

  test("hover selector 模式", async () => {
    const { m, cdpCalls } = makeHoverManager({ found: true, x: 50, y: 60, label: "下拉" });
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "hover", selector: ".tab_select" });
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.ok).toBe(true);
      expect((cdpCalls[0].params as { x: number }).x).toBe(50);
    } finally {
      m.dispose();
    }
  });

  test("未找到目标 → hover_target_not_found", async () => {
    const { m } = makeHoverManager({ found: false });
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "hover", text: "不存在" });
      expect(JSON.stringify(r)).toContain("hover_target_not_found");
    } finally {
      m.dispose();
    }
  });

  test("引擎无 CDP → hover_unavailable（提示需要 Chrome 后端）", async () => {
    const { m } = makeHoverManager({ found: true, x: 1, y: 1 }, false);
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "hover", text: "库存" });
      expect(JSON.stringify(r)).toContain("hover_unavailable");
    } finally {
      m.dispose();
    }
  });
});

describe("browser_navigate fresh 干净起步", () => {
  function makeFreshManager() {
    let navCount = 0;
    const evals: string[] = [];
    const m = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-fresh-")),
      viewFactory: () =>
        makeFakeView({
          async navigate() {
            navCount++;
          },
          async evaluate(script: string) {
            evals.push(script);
            return script;
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    return { m, getNavCount: () => navCount, evals };
  }

  test("fresh:true → 清存储后 location.reload 刷新（不占导航槽，共 1 次 navigate）", async () => {
    const { m, getNavCount, evals } = makeFreshManager();
    try {
      const r = await handleBrowserTool(m, "s1", "browser_navigate", {
        url: "http://example.com",
        fresh: true,
      });
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.fresh).toBe(true);
      expect(getNavCount()).toBe(1); // 只有一次真实导航，刷新走 reload（避免 pending 连锁）
      const clear = evals.find((s) => s.includes("localStorage.clear"));
      expect(clear).toBeDefined();
      expect(clear).toContain("sessionStorage");
      expect(clear).toContain("cookie");
      expect(clear).toContain("location.reload");
    } finally {
      m.dispose();
    }
  });

  test("不传 fresh → 单次导航、不清存储", async () => {
    const { m, getNavCount, evals } = makeFreshManager();
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
      expect(getNavCount()).toBe(1);
      expect(evals.find((s) => s.includes("localStorage.clear"))).toBeUndefined();
    } finally {
      m.dispose();
    }
  });
});

describe("browser_wait hash 条件（SPA 路由）", () => {
  function makeHashManager(probeResults: boolean[]) {
    let i = 0;
    return new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-hash-")),
      viewFactory: () =>
        makeFakeView({
          async evaluate(script: string) {
            if (script.includes("wa-wait-hash")) {
              return probeResults[Math.min(i++, probeResults.length - 1)];
            }
            return script;
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
  }

  test("hash 立即匹配 → ok", async () => {
    const m = makeHashManager([true]);
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      const r = await handleBrowserTool(m, "s1", "browser_wait", { hash: "goodsInventory" });
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.matched).toBe(true);
    } finally {
      m.dispose();
    }
  });

  test("hash 轮询后匹配（SPA 路由跳转延迟）→ ok", async () => {
    const m = makeHashManager([false, false, true]);
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      const r = await handleBrowserTool(m, "s1", "browser_wait", { hash: "goodsInventory", timeout: 3000 });
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.matched).toBe(true);
    } finally {
      m.dispose();
    }
  });

  test("hash 超时 → wait_timeout", async () => {
    const m = makeHashManager([false]);
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      const r = await handleBrowserTool(m, "s1", "browser_wait", { hash: "never", timeout: 600 });
      expect(JSON.stringify(r)).toContain("wait_timeout");
    } finally {
      m.dispose();
    }
  });
});

describe("fresh 二次加载与文本归一化", () => {
  test("fresh 清存储后用 location.reload 刷新（不占导航槽，避免 pending 连锁）", async () => {
    let navCount = 0;
    const evals: string[] = [];
    const m = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-fresh2-")),
      viewFactory: () =>
        makeFakeView({
          async navigate() {
            navCount++;
          },
          async evaluate(script: string) {
            evals.push(script);
            return script;
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", fresh: true });
      expect(navCount).toBe(1); // 只有一次真实导航，刷新走 reload
      expect(evals.find((s) => s.includes("location.reload"))).toBeDefined();
    } finally {
      m.dispose();
    }
  });
});

describe("navigate 同站 hash 路由跳转", () => {
  test("同 origin 且目标带 hash → eval 改 hash 秒回（不走 navigate 的 load 等待）", async () => {
    let navCount = 0;
    const evals: string[] = [];
    const m = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-hashnav-")),
      viewFactory: () =>
        makeFakeView({
          get url() {
            return "blob:https://hlk.meiguanjia.net/921d";
          },
          async navigate() {
            navCount++;
          },
          async evaluate(script: string) {
            evals.push(script);
            return script;
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    try {
      // 首次 getOrCreate：用一次普通导航建立会话（blob 页面上）
      const r = await handleBrowserTool(m, "s1", "browser_navigate", {
        url: "https://hlk.meiguanjia.net/#/stock/stockInventory/goodsInventory",
      });
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.hashNav).toBe(true);
      expect(evals.find((s) => s.includes("location.hash"))).toBeDefined();
      expect(navCount).toBe(0); // 全程不触发 WebView.navigate（避免 load 挂起）
    } finally {
      m.dispose();
    }
  });
});

describe("type selector 聚焦与原生 setter 兜底", () => {
  // fake：type 首次无效（值不变），模拟 SPA 内页键盘输入失效
  function makeTypeManager() {
    let typeAttempts = 0;
    let focused = "";
    const m = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-typesel-")),
      viewFactory: () =>
        makeFakeView({
          async click(selectorOrX: string | number) {
            focused = String(selectorOrX);
          },
          async type(text: string) {
            typeAttempts++;
            void text; // 首两次键入无效（SPA 重渲染吞焦点）
          },
          async evaluate(script: string) {
            if (script.includes("wa-typeset")) return "zz1234"; // 模拟原生 setter 设置成功后读回的值
            if (script.includes("wa-typecheck")) return focused ? "typed" : "";
            return script;
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    return { m, getAttempts: () => typeAttempts };
  }

  test("type+selector：聚焦→键入→验证未生效→自动原生 setter 兜底", async () => {
    const { m, getAttempts } = makeTypeManager();
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", {
        action: "type",
        selector: "input[type=password]",
        text: "zz1234",
      });
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.fallback).toBe(true); // 键入未生效走了原生 setter 兜底
      expect(getAttempts()).toBeGreaterThanOrEqual(1); // 确实尝试过 view.type
    } finally {
      m.dispose();
    }
  });

  test("type+selector：键入生效时不触发兜底", async () => {
    let attempts = 0;
    let value = "";
    const m = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-typesel-")),
      viewFactory: () =>
        makeFakeView({
          async click() {},
          async type(text: string) {
            attempts++;
            value = text; // 键入生效：值真实写入
          },
          async evaluate(script: string) {
            if (script.includes("wa-typecheck")) return value;
            if (script.includes("wa-typeset")) return "SET_OK";
            return script;
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", {
        action: "type",
        selector: "input[type=password]",
        text: "zz1234",
      });
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.fallback).toBeUndefined();
    } finally {
      m.dispose();
    }
  });
});

// =========================================================================
// type/press ref 聚焦（快照 [ref=N] 工作流补齐，2026-11-03）
// =========================================================================

describe("type/press ref 聚焦（locateRefTarget 接入）", () => {
  /** 登录页形态 AX 树：RootWebArea → heading/textbox/button（同 click ref 测试） */
  const AX_LOGIN_INPUT: unknown = {
    nodes: [
      { nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2", "3", "4"] },
      { nodeId: "2", role: { type: "role", value: "heading" }, name: { type: "computedString", value: "慧来客" }, backendDOMNodeId: 10 },
      { nodeId: "3", role: { type: "role", value: "textbox" }, name: { type: "computedString", value: "请输入手机号" }, backendDOMNodeId: 12 },
      { nodeId: "4", role: { type: "role", value: "button" }, name: { type: "computedString", value: "登 录" }, backendDOMNodeId: 15 },
    ],
  };

  /**
   * type/press ref fake：cdp 提供 AX 树与 getBoxModel（boxes 表驱动；未命中抛错模拟
   * 失效），click 记录聚焦坐标，type/press 记录派发，evaluate 提供遮挡探针与键入验证。
   */
  function makeRefInputManager(opts: {
    boxes?: Record<number, number[]>;
    axTree?: unknown;
    typeEffective?: boolean;
  } = {}) {
    const clicked: Array<[unknown, unknown]> = [];
    const typed: string[] = [];
    const pressed: string[] = [];
    let activeValue = "";
    const m = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-refinput-")),
      viewFactory: () =>
        makeFakeView({
          async evaluate(script: string) {
            if (script.includes("wa-occlusion")) return { occluded: false };
            if (script.includes("wa-typecheck")) return activeValue; // activeElement 值
            // 模拟原生 setter 设置成功后读回的值（与 makeTypeManager 模式对齐）
            if (script.includes("wa-typeset")) return "zz1234";
            return script;
          },
          async cdp(method: string, params?: Record<string, unknown>) {
            if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "u-1" } } };
            if (method === "Accessibility.getFullAXTree") return opts.axTree ?? AX_LOGIN_INPUT;
            if (method === "DOM.scrollIntoViewIfNeeded") return {};
            if (method === "DOM.getBoxModel") {
              const quad = opts.boxes?.[Number(params?.backendNodeId)];
              if (!quad) throw new Error("No node with id");
              return { model: { content: quad } };
            }
            return {};
          },
          async click(a?: unknown, b?: unknown) {
            clicked.push([a, b]);
          },
          async type(text: string) {
            typed.push(text);
            if (opts.typeEffective !== false) activeValue = text;
          },
          async press(key: string) {
            pressed.push(key);
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    return { m, clicked, typed, pressed };
  }

  async function seedSelectorMap(m: BrowserManager, map: Record<number, { role: string; name: string }>) {
    await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
    (m.get("s1") as { selectorMap?: unknown }).selectorMap = map;
  }

  test("type+ref：坐标聚焦（先 scrollIntoViewIfNeeded）后键入生效，返回 ok 与 ref", async () => {
    const { m, clicked, typed } = makeRefInputManager({
      boxes: { 12: [10, 20, 30, 20, 30, 40, 10, 40] },
    });
    try {
      await seedSelectorMap(m, { 12: { role: "textbox", name: "请输入手机号" } });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", {
        action: "type",
        ref: 12,
        text: "13800000000",
        snapshot: false,
      });
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.ref).toBe(12);
      expect(clicked[0]?.[0]).toBe(20); // quad 四点平均中心
      expect(clicked[0]?.[1]).toBe(30);
      expect(typed).toEqual(["13800000000"]);
    } finally {
      m.dispose();
    }
  });

  test("type+ref：键入未生效 → activeElement 原生 setter 兑底（fallback 标记）", async () => {
    const { m } = makeRefInputManager({
      boxes: { 12: [0, 0, 10, 0, 10, 10, 0, 10] },
      typeEffective: false,
    });
    try {
      await seedSelectorMap(m, { 12: { role: "textbox", name: "请输入手机号" } });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", {
        action: "type",
        ref: 12,
        text: "zz1234",
        snapshot: false,
      });
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.fallback).toBe(true);
      expect(parsed.ok).toBe(true); // 兑底读回值与 text 一致
    } finally {
      m.dispose();
    }
  });

  test("type+ref：原 ref 失效 → role+name 回查新 id 并更新 selectorMap", async () => {
    const { m, clicked } = makeRefInputManager({
      // AX 树中 textbox 的新 backendId=12；旧 id=99 无盒子抛错触发回查
      boxes: { 12: [0, 0, 20, 0, 20, 10, 0, 10] },
    });
    try {
      await seedSelectorMap(m, { 99: { role: "textbox", name: "请输入手机号" } });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", {
        action: "type",
        ref: 99,
        text: "abc",
        snapshot: false,
      });
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.recovered).toBe(true);
      expect(clicked[0]?.[0]).toBe(10);
      expect(m.get("s1")?.selectorMap?.[12]).toStrictEqual({ role: "textbox", name: "请输入手机号" });
    } finally {
      m.dispose();
    }
  });

  test("type+ref：selectorMap 无此 ref → invalid_ref 提示重新 snapshot", async () => {
    const { m } = makeRefInputManager({ boxes: { 12: [0, 0, 1, 0, 1, 1, 0, 1] } });
    try {
      await seedSelectorMap(m, { 12: { role: "textbox", name: "请输入手机号" } });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", {
        action: "type",
        ref: 99,
        text: "abc",
        snapshot: false,
      });
      expect(JSON.stringify(r)).toContain("invalid_ref");
    } finally {
      m.dispose();
    }
  });

  test("press+ref：坐标聚焦后按键派发（Enter 到达目标元素）", async () => {
    const { m, clicked, pressed } = makeRefInputManager({
      boxes: { 15: [10, 20, 30, 20, 30, 40, 10, 40] },
    });
    try {
      await seedSelectorMap(m, { 15: { role: "button", name: "登 录" } });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", {
        action: "press",
        ref: 15,
        key: "Enter",
        snapshot: false,
      });
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.ref).toBe(15);
      expect(clicked[0]?.[0]).toBe(20);
      expect(clicked[0]?.[1]).toBe(30);
      expect(pressed).toEqual(["Enter"]);
    } finally {
      m.dispose();
    }
  });

  test("press+ref：selectorMap 无此 ref → invalid_ref 且不派发按键", async () => {
    const { m, pressed } = makeRefInputManager({ boxes: { 15: [0, 0, 1, 0, 1, 1, 0, 1] } });
    try {
      await seedSelectorMap(m, { 15: { role: "button", name: "登 录" } });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", {
        action: "press",
        ref: 99,
        key: "Enter",
        snapshot: false,
      });
      expect(JSON.stringify(r)).toContain("invalid_ref");
      expect(pressed.length).toBe(0);
    } finally {
      m.dispose();
    }
  });
});

// =========================================================================
// 返回体 ref 提示（双保险：工具返回体动态引导 ref 工作流，2026-11-03）
// =========================================================================

describe("返回体 ref 提示（navigate/snapshot/screenshot/操作后快照）", () => {
  const AX_HINT_TREE: unknown = {
    nodes: [
      { nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] },
      { nodeId: "2", role: { type: "role", value: "button" }, name: { type: "computedString", value: "go" }, backendDOMNodeId: 5 },
    ],
  };

  function makeHintManager() {
    const m = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-hint-")),
      viewFactory: () =>
        makeFakeView({
          async evaluate(script: string) {
            if (script.includes("wa-occlusion")) return { occluded: false };
            if (script.includes("wa-annotate")) return { "@5": { label: "go", tag: "button", x: 1, y: 1 } };
            return script;
          },
          async cdp(method: string) {
            if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "u-1" } } };
            if (method === "Accessibility.getFullAXTree") return AX_HINT_TREE;
            if (method === "DOM.scrollIntoViewIfNeeded") return {};
            if (method === "DOM.getBoxModel") return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
            return {};
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    return m;
  }

  function parseHint(r: { content: { text: string }[] }): string | undefined {
    return (JSON.parse(r.content[0].text) as { hint?: string }).hint;
  }

  const HINT_PREFIX = "提示：操作元素优先用上方快照中的 [ref=";

  test("browser_navigate 返回体：快照文本首行拼 ref 提示；snapshot:false 时降级 hint 字段", async () => {
    const m = makeHintManager();
    try {
      const r = await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
      const parsed = JSON.parse(r.content[0].text) as { snapshot: string; hint?: string };
      // 默认自动附快照：提示拼在快照文本首行（模型读快照第一眼即见）
      expect(parsed.snapshot.startsWith(HINT_PREFIX)).toBe(true);
      expect(parsed.snapshot).toContain("CSS selector");
      expect(parsed.snapshot.split("\n").length).toBeGreaterThan(1); // 首行提示后仍有快照内容
      // 跳过自动快照：无快照文本 → 独立 hint 字段（等价形式）
      const r2 = await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      expect(parseHint(r2)).toContain("[ref=");
    } finally {
      m.dispose();
    }
  });

  test("browser_snapshot 返回体：快照文本首行拼 ref 提示", async () => {
    const m = makeHintManager();
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
      const r = await handleBrowserTool(m, "s1", "browser_snapshot", {});
      const parsed = JSON.parse(r.content[0].text) as { snapshot?: string };
      expect(parsed.snapshot?.startsWith(HINT_PREFIX)).toBe(true);
    } finally {
      m.dispose();
    }
  });

  test("browser_screenshot（含 annotate）返回体：无快照文本 → hint 字段", async () => {
    const m = makeHintManager();
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
      const r = await handleBrowserTool(m, "s1", "browser_screenshot", {});
      expect(parseHint(r)).toContain("[ref=");
      // annotate 模式（返回 refs 映射）同样带提示
      const r2 = await handleBrowserTool(m, "s1", "browser_screenshot", { annotate: true });
      const parsed = JSON.parse(r2.content[0].text) as { refs?: unknown; hint?: string };
      expect(parsed.hint).toContain("[ref=");
    } finally {
      m.dispose();
    }
  });

  test("操作后自动快照：有差值快照拼首行；无变化（snapshotUnchanged）降级 hint 字段", async () => {
    const m = makeHintManager();
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      // 首次 click：产生差值快照 → 提示拼首行
      const click = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "click", selector: "#go" });
      const parsed = JSON.parse(click.content[0].text) as { snapshot?: string; hint?: string };
      expect(parsed.snapshot?.startsWith(HINT_PREFIX)).toBe(true);
      // 二次 click：页面无变化 → snapshotUnchanged 无快照文本 → hint 字段
      const click2 = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "click", selector: "#go" });
      const parsed2 = JSON.parse(click2.content[0].text) as { snapshotUnchanged?: boolean; hint?: string };
      expect(parsed2.snapshotUnchanged).toBe(true);
      expect(parsed2.hint).toContain("[ref=");
      // press 同样走首行拼接
      const press = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "press", key: "Enter" });
      const parsedP = JSON.parse(press.content[0].text) as { snapshot?: string };
      // 二次 click 后基准已刷新，press 后页面可能仍无变化，两种形态都算合规
      const hasFirstLine = parsedP.snapshot?.startsWith(HINT_PREFIX);
      const hasField = parsedP.snapshot === undefined;
      expect(hasFirstLine || hasField).toBe(true);
    } finally {
      m.dispose();
    }
  });
});

describe("ref 参数容错（@N 格式与数字等价）", () => {
  function makeRefOkManager() {
    const clicked: Array<[unknown, unknown]> = [];
    const m = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-reftol-")),
      viewFactory: () =>
        makeFakeView({
          async evaluate(script: string) {
            if (script.includes("wa-occlusion")) return { occluded: false };
            return script;
          },
          async cdp(method: string, params?: Record<string, unknown>) {
            if (method === "DOM.scrollIntoViewIfNeeded") return {};
            if (method === "DOM.getBoxModel") {
              return { model: { content: [0, 0, 14, 0, 14, 8, 0, 8] } };
            }
            return {};
          },
          async click(a?: unknown, b?: unknown) {
            clicked.push([a, b]);
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    return { m, clicked };
  }

  test('ref 传 "@3"（快照显示格式）与 3 等价', async () => {
    const { m, clicked } = makeRefOkManager();
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      (m.get("s1") as { selectorMap?: unknown }).selectorMap = { 3: { role: "button", name: "go" } };
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", {
        action: "click",
        ref: "@3" as never,
      });
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.ref).toBe(3);
      expect(clicked[0]?.[0]).toBe(7); // quad 四点平均
      expect(clicked[0]?.[1]).toBe(4);
    } finally {
      m.dispose();
    }
  });

  test("ref 传纯数字字符串 \"3\" 同样等价", async () => {
    const { m, clicked } = makeRefOkManager();
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      (m.get("s1") as { selectorMap?: unknown }).selectorMap = { 3: { role: "button", name: "go" } };
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", {
        action: "click",
        ref: "3" as never,
      });
      expect(JSON.parse(r.content[0].text).ok).toBe(true);
      expect(clicked[0]?.[0]).toBe(7); // quad 中心坐标
    } finally {
      m.dispose();
    }
  });
});

describe("fresh 的 cookie 清理升级（CDP 清 HttpOnly）", () => {
  test("fresh:true → CDP clearBrowserCookies 被调用（含 HttpOnly 会话凭据）", async () => {
    const cdpCalls: Array<{ method: string; params?: unknown }> = [];
    let navCount = 0;
    const evals: string[] = [];
    const m = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-freshcdp-")),
      viewFactory: () =>
        makeFakeView({
          async navigate() {
            navCount++;
          },
          async evaluate(script: string) {
            evals.push(script);
            return script;
          },
          cdp: async (method: string, params?: unknown) => {
            cdpCalls.push({ method, params });
            return {};
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", fresh: true });
      expect(cdpCalls.some((c) => c.method === "Network.clearBrowserCookies")).toBe(true);
      expect(evals.find((s) => s.includes("localStorage.clear"))).toBeDefined();
    } finally {
      m.dispose();
    }
  });

  test("无 CDP 能力 → 降级 document.cookie 清理不报错", async () => {
    let navCount = 0;
    const evals: string[] = [];
    const m = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-freshcdp-")),
      viewFactory: () =>
        makeFakeView({
          async navigate() {
            navCount++;
          },
          async evaluate(script: string) {
            evals.push(script);
            return script;
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    try {
      const r = await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", fresh: true });
      expect(JSON.parse(r.content[0].text).fresh).toBe(true);
      expect(evals.find((s) => s.includes("expires=Thu, 01 Jan 1970"))).toBeDefined();
    } finally {
      m.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 原生 dialog 自动应答：Page.enable + 订阅 Page.javascriptDialogOpening，
// alert/confirm/beforeunload → accept，prompt → dismiss（对齐 browser-use
// popups_watchdog 语义）；操作返回体带 dismissedDialog 字段。
// ---------------------------------------------------------------------------

/** 带 cdp + addEventListener 的 fake view：捕获 dialog 事件监听器供手动触发 */
function makeDialogFakeManager() {
  const cdpCalls: Array<{ method: string; params?: unknown }> = [];
  let dialogListener: ((e: { data?: unknown }) => void) | null = null;
  const m = new BrowserManager({
    screenshotDir: mkdtempSync(join(tmpdir(), "browser-dialog-")),
    viewFactory: () =>
      makeFakeView({
        cdp: async (method: string, params?: unknown) => {
          cdpCalls.push({ method, params });
          return {};
        },
        addEventListener: (type: string, listener: (e: { data?: unknown }) => void) => {
          if (type === "Page.javascriptDialogOpening") dialogListener = listener;
        },
      }),
    idleTimeoutMs: 60_000,
    sweepIntervalMs: 60_000,
  });
  return {
    m,
    cdpCalls,
    fireDialog: (data: unknown) => dialogListener?.({ data }),
  };
}

describe("原生 dialog 自动应答", () => {
  test("navigate 后启用 Page.enable 并注册 javascriptDialogOpening 监听", async () => {
    const { m, cdpCalls } = makeDialogFakeManager();
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
      expect(cdpCalls.some((c) => c.method === "Page.enable")).toBe(true);
    } finally {
      m.dispose();
    }
  });

  test("alert 事件 → 自动 accept，后续 click 返回体带 dismissedDialog", async () => {
    const { m, cdpCalls, fireDialog } = makeDialogFakeManager();
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      fireDialog({ type: "alert", message: "登录已过期" });
      expect(cdpCalls.some((c) => c.method === "Page.handleJavaScriptDialog" && (c.params as { accept?: boolean }).accept === true)).toBe(true);
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "click", selector: "#btn", snapshot: false });
      const parsed = JSON.parse(r.content[0].text) as { ok: boolean; dismissedDialog?: { type: string; message: string } };
      expect(parsed.ok).toBe(true);
      expect(parsed.dismissedDialog).toEqual({ type: "alert", message: "登录已过期" });
    } finally {
      m.dispose();
    }
  });

  test("prompt 事件 → 自动 dismiss（accept:false）", async () => {
    const { m, cdpCalls, fireDialog } = makeDialogFakeManager();
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      fireDialog({ type: "prompt", message: "请输入年龄", defaultPrompt: "18" });
      const call = cdpCalls.find((c) => c.method === "Page.handleJavaScriptDialog");
      expect(call).toBeDefined();
      expect((call?.params as { accept?: boolean }).accept).toBe(false);
    } finally {
      m.dispose();
    }
  });

  test("confirm/beforeunload 事件 → 自动 accept", async () => {
    const { m, cdpCalls, fireDialog } = makeDialogFakeManager();
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      fireDialog({ type: "confirm", message: "确认删除？" });
      fireDialog({ type: "beforeunload", message: "" });
      const accepts = cdpCalls.filter((c) => c.method === "Page.handleJavaScriptDialog");
      expect(accepts.length).toBe(2);
      expect(accepts.every((c) => (c.params as { accept?: boolean }).accept === true)).toBe(true);
    } finally {
      m.dispose();
    }
  });

  test("dismissedDialog 取走即清空（不重复上报）", async () => {
    const { m, fireDialog } = makeDialogFakeManager();
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      fireDialog({ type: "alert", message: "once" });
      const r1 = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "click", selector: "#btn", snapshot: false });
      expect(JSON.parse(r1.content[0].text).dismissedDialog).toBeDefined();
      const r2 = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "click", selector: "#btn", snapshot: false });
      expect(JSON.parse(r2.content[0].text).dismissedDialog).toBeUndefined();
    } finally {
      m.dispose();
    }
  });

  test("无 dialog 时操作返回体不带 dismissedDialog 字段", async () => {
    const { m } = makeDialogFakeManager();
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "click", selector: "#btn", snapshot: false });
      expect(JSON.parse(r.content[0].text).dismissedDialog).toBeUndefined();
    } finally {
      m.dispose();
    }
  });

  test("应答调用失败不影响主流程（静默容错）", async () => {
    const m = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-dialog-")),
      viewFactory: () =>
        makeFakeView({
          cdp: async (method: string) => {
            if (method === "Page.handleJavaScriptDialog") throw new Error("cdp busy");
            return {};
          },
          addEventListener: (_type: string, listener: (e: { data?: unknown }) => void) => {
            (listener as { __store?: boolean }).__store = true;
            listeners.push(listener);
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    const listeners: Array<(e: { data?: unknown }) => void> = [];
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      listeners[0]?.({ data: { type: "alert", message: "x" } });
      await Bun.sleep(10); // 应答 promise 的 rejection 必须被内部 catch，不能冒泡为 unhandled rejection
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "click", selector: "#btn", snapshot: false });
      expect(JSON.parse(r.content[0].text).ok).toBe(true);
    } finally {
      m.dispose();
    }
  });

  test("旧引擎/fake 无 cdp 或 addEventListener → 静默跳过不报错", async () => {
    const m = makeManager();
    try {
      const r = await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com" });
      expect(r.content[0].text).toContain('"ok":true');
    } finally {
      m.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 点击前遮挡校验：click 的 text/selector/ref 定位路径在派发点击前，用目标中心点
// document.elementFromPoint 校验——命中非目标且非其祖先/语义关联 → 报 click_occluded
// 错误附遮挡元素摘要（tag/class/文本前 20 字），让模型自己决策（先 snapshot 看弹窗），
// 不自动旁路；x/y 直传坐标不校验（显式坐标的任务意图不同）。
// ---------------------------------------------------------------------------

/** 带 wa-occlusion 探针拦截的 fake view 管理器：探针返回预设结果并记录调用 */
function makeOcclusionManager(occlusionResult: unknown) {
  const clicked: Array<[unknown, unknown]> = [];
  const probes: string[] = [];
  const m = new BrowserManager({
    screenshotDir: mkdtempSync(join(tmpdir(), "browser-occlusion-")),
    viewFactory: () =>
      makeFakeView({
        async evaluate(script: string) {
          if (script.includes("wa-occlusion")) {
            probes.push(script);
            return occlusionResult;
          }
          if (script.includes("wa-click-text")) return { found: true, x: 111, y: 222, label: "目标按钮" };
          return script;
        },
        async cdp(method: string) {
          if (method === "DOM.scrollIntoViewIfNeeded") return {};
          if (method === "DOM.getBoxModel") {
            return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
          }
          return {};
        },
        async click(a?: unknown, b?: unknown) {
          clicked.push([a, b]);
        },
      }),
    idleTimeoutMs: 60_000,
    sweepIntervalMs: 60_000,
  });
  return { m, clicked, probes };
}

describe("点击前遮挡校验（click_occluded）", () => {
  const OCCLUDER = { occluded: true, occluder: { tag: "div", cls: "ant-modal-mask", text: "升级公告遮罩层内容" } };

  test("text 模式：探针报遮挡 → click_occluded 错误附遮挡摘要且不派发点击", async () => {
    const { m, clicked, probes } = makeOcclusionManager(OCCLUDER);
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "click", text: "目标按钮", snapshot: false });
      expect(JSON.stringify(r)).toContain("click_occluded");
      expect(r.content[0].text).toContain("div");
      expect(r.content[0].text).toContain("ant-modal-mask");
      expect(r.content[0].text).toContain("升级公告遮罩层内容");
      expect(r.content[0].text).toContain("browser_snapshot");
      expect(clicked.length).toBe(0); // 遮挡时不派发点击
      expect(probes.length).toBe(1); // 定位后跑了一次探针
      expect(probes[0]).toContain("elementFromPoint");
    } finally {
      m.dispose();
    }
  });

  test("text 模式：探针放行 → 正常点击", async () => {
    const { m, clicked } = makeOcclusionManager({ occluded: false });
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "click", text: "目标按钮", snapshot: false });
      const parsed = JSON.parse(r.content[0].text) as { ok: boolean };
      expect(parsed.ok).toBe(true);
      expect(clicked[0]?.[0]).toBe(111);
    } finally {
      m.dispose();
    }
  });

  test("selector 模式：探针报遮挡 → click_occluded 且不派发点击", async () => {
    const { m, clicked, probes } = makeOcclusionManager(OCCLUDER);
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "click", selector: "#btn", snapshot: false });
      expect(JSON.stringify(r)).toContain("click_occluded");
      expect(clicked.length).toBe(0);
      expect(probes.length).toBe(1);
    } finally {
      m.dispose();
    }
  });

  test("ref 模式（坐标+文本近似）：探针报遮挡 → click_occluded 且不派发点击", async () => {
    const { m, clicked } = makeOcclusionManager(OCCLUDER);
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      (m.get("s1") as { selectorMap?: unknown }).selectorMap = { 2: { role: "button", name: "l" } };
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "click", ref: 2, snapshot: false });
      expect(JSON.stringify(r)).toContain("click_occluded");
      expect(clicked.length).toBe(0);
    } finally {
      m.dispose();
    }
  });

  test("x/y 直传坐标不校验（探针不被调用）", async () => {
    const { m, clicked, probes } = makeOcclusionManager(OCCLUDER);
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "click", x: 10, y: 20, snapshot: false });
      const parsed = JSON.parse(r.content[0].text) as { ok: boolean };
      expect(parsed.ok).toBe(true);
      expect(clicked[0]?.[0]).toBe(10);
      expect(probes.length).toBe(0); // 显式坐标不走遮挡校验
    } finally {
      m.dispose();
    }
  });

  test("探针异常/返回形状不符 → 宁放行不错杀（不阻塞点击）", async () => {
    const { m, clicked } = makeOcclusionManager(null); // evaluate 抛错/返回 null 都按放行
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", { action: "click", text: "目标按钮", snapshot: false });
      const parsed = JSON.parse(r.content[0].text) as { ok: boolean };
      expect(parsed.ok).toBe(true);
      expect(clicked.length).toBe(1);
    } finally {
      m.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// type 清空语义：clear:true 时输入前先清空焦点元素（input/textarea 原生 setter
// + input/change 事件；contenteditable 清 textContent）再输入，默认 false 追加
// 语义不变。重填字段用 clear:true，省「全选删除再输入」的多次往返。
// ---------------------------------------------------------------------------

describe("type 的 clear 清空语义", () => {
  /** 记录 evaluate 脚本序列与 type 调用顺序的 fake view */
  function makeTypeOrderManager() {
    const evals: string[] = [];
    let typeCalled = 0;
    let lastTyped = "";
    const m = new BrowserManager({
      screenshotDir: mkdtempSync(join(tmpdir(), "browser-clear-")),
      viewFactory: () =>
        makeFakeView({
          async evaluate(script: string) {
            evals.push(script);
            if (script.includes("wa-typecheck")) return lastTyped; // 模拟键入生效
            if (script.includes("wa-clear")) return "CLEARED";
            if (script.includes("wa-typeset")) return lastTyped; // 模拟兑底生效
            return script;
          },
          async type(t: string) {
            typeCalled++;
            lastTyped = t;
          },
        }),
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    return { m, evals, typeCalled: () => typeCalled };
  }

  test("clear:true（无 selector）：type 前先执行清空焦点元素脚本", async () => {
    const { m, evals, typeCalled } = makeTypeOrderManager();
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", {
        action: "type",
        text: "新文本",
        clear: true,
        snapshot: false,
      });
      const parsed = JSON.parse(r.content[0].text) as { ok: boolean };
      expect(parsed.ok).toBe(true);
      const clearIdx = evals.findIndex((s) => s.includes("wa-clear"));
      expect(clearIdx).toBeGreaterThanOrEqual(0);
      // 清空必须发生在 type 之前（evals 里清空脚本是唯一的 evaluate，type 无脚本——
      // 用清空脚本存在 + type 被调用断言顺序契约）
      expect(typeCalled()).toBe(1);
      // 清空脚本覆盖三种焦点元素形态
      const clearScript = evals[clearIdx];
      expect(clearScript).toContain("activeElement");
      expect(clearScript).toContain("isContentEditable");
      expect(clearScript).toContain("textContent");
      expect(clearScript).toContain("HTMLTextAreaElement");
      expect(clearScript).toContain('new Event("input"');
      expect(clearScript).toContain('new Event("change"');
    } finally {
      m.dispose();
    }
  });

  test("缺省 clear（false）：不执行清空脚本，追加语义不变", async () => {
    const { m, evals } = makeTypeOrderManager();
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", {
        action: "type",
        text: "追加文本",
        snapshot: false,
      });
      const parsed = JSON.parse(r.content[0].text) as { ok: boolean };
      expect(parsed.ok).toBe(true);
      expect(evals.some((s) => s.includes("wa-clear"))).toBe(false);
    } finally {
      m.dispose();
    }
  });

  test("clear:true（selector 路径）：聚焦后 type 前执行清空脚本", async () => {
    const { m, evals } = makeTypeOrderManager();
    try {
      await handleBrowserTool(m, "s1", "browser_navigate", { url: "http://example.com", snapshot: false });
      const r = await handleBrowserTool(m, "s1", "browser_evaluate", {
        action: "type",
        text: "重填内容",
        selector: "#inp",
        clear: true,
        snapshot: false,
      });
      const parsed = JSON.parse(r.content[0].text) as { ok: boolean };
      expect(parsed.ok).toBe(true);
      const clearIdx = evals.findIndex((s) => s.includes("wa-clear"));
      expect(clearIdx).toBeGreaterThanOrEqual(0);
      // 清空发生在键入验证（wa-typecheck）之前
      const checkIdx = evals.findIndex((s) => s.includes("wa-typecheck"));
      expect(checkIdx).toBeGreaterThan(clearIdx);
    } finally {
      m.dispose();
    }
  });
});
