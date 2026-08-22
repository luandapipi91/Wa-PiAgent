// browser-real-engine.test.ts —— Layer 3 真实 Bun.WebView 引擎集成测试。
//
// 用真实 Bun.WebView（backend:"chrome"）走 handleBrowserTool 完整工具路径
// （browser_navigate → browser_evaluate eval/click → browser_screenshot(path)
// → browser_close），直接验证 WebViewLike 假设签名与真实 Bun.WebView 匹配
// （browser-manager.ts 默认工厂 new Bun.WebView({ ...o, backend: "chrome" })）。
//
// 引擎不可用（非 macOS 且本机无 Chrome/Edge，或 BUN_CHROME_PATH 未指向可执行文件）
// 时整个 suite 跳过并 console.log 标注——不算失败（spec §6 明确）。
//
// 清理：截图目录用 mkdtemp 临时目录，finally 中 dispose + rmSync 删除，
// 测试产生的临时文件不落盘保留。
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserManager } from "../src/browser-manager";
import { handleBrowserTool } from "../src/browser-tools";

// 本地静态页：data: URL（避免端口冲突）。点击 #btn 会改 document.title。
const TEST_HTML = `<h1>hello</h1><button id="btn" onclick="document.title='clicked'">go</button>`;
const TEST_URL = "data:text/html," + encodeURIComponent(TEST_HTML);

/** 探测真实引擎可用性：构造 + 导航 + evaluate + 关闭，任何一步失败即不可用 */
async function probeEngineAvailable(): Promise<boolean> {
  try {
    const view = new Bun.WebView({ width: 160, height: 120, backend: "chrome" });
    try {
      await view.navigate(TEST_URL);
      const h1 = await view.evaluate(`document.querySelector("h1")?.textContent`);
      return h1 === "hello";
    } finally {
      // 构造成功后才进入此 try：navigate/evaluate 抛错（如 Chrome 启动成功但页面加载异常）
      // 也关闭 WebView，避免底层浏览器进程残留；构造本身抛错时 view 未赋值，无泄漏
      view.close();
    }
  } catch (err) {
    console.log(
      `[Layer 3] 真实引擎不可用，跳过：${err instanceof Error ? err.message : String(err)}（非 macOS 平台需要已安装 Chrome/Chromium/Edge/Brave，或设置 BUN_CHROME_PATH）`,
    );
    return false;
  }
}

// 顶层 await 探测（Bun 原生支持），模块加载期确定引擎可用性
const engineAvailable = await probeEngineAvailable();
// 引擎不可用时所有真实链路测试直接跳过（skipIf 的别名写法）
const testReal = engineAvailable ? test : test.skip;

function sessionId(tag: string): string {
  return `test-session-${tag}`;
}

describe("Layer 3 真实 Bun.WebView 引擎集成测试", () => {
  testReal("真实引擎全链路：navigate → evaluate eval → evaluate click → screenshot(path) → close", async () => {
    const screenshotDir = mkdtempSync(join(tmpdir(), "browser-real-engine-"));
    // 不注入 viewFactory → 使用修复后的默认工厂（new Bun.WebView({ ...o, backend: "chrome" })），
    // 这正是 WebViewLike 假设与真实 Bun.WebView 的对接点
    const manager = new BrowserManager({
      screenshotDir,
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    try {
      // 1) browser_navigate：data: URL 本地静态页
      const nav = await handleBrowserTool(manager, sessionId("link"), "browser_navigate", { url: TEST_URL });
      const navResult = JSON.parse(nav.content[0].text) as {
        ok: boolean;
        url: string;
        title: string;
        loading: boolean;
      };
      expect(navResult.ok).toBe(true);
      expect(navResult.url).toContain("data:text/html");
      expect(navResult.loading).toBe(false);
      expect(typeof navResult.title).toBe("string");

      // 2) browser_evaluate eval：DOM 文本查询（表达式脚本）
      const evalRes = await handleBrowserTool(manager, sessionId("link"), "browser_evaluate", {
        action: "eval",
        script: `document.querySelector("h1").textContent`,
      });
      const evalParsed = JSON.parse(evalRes.content[0].text) as { ok: boolean; result: unknown };
      expect(evalParsed.ok).toBe(true);
      expect(evalParsed.result).toBe("hello");

      // 3) browser_evaluate click：点击 #btn（selector 模式）→ 改 document.title
      const clickRes = await handleBrowserTool(manager, sessionId("link"), "browser_evaluate", {
        action: "click",
        selector: "#btn",
      });
      const clickParsed = JSON.parse(clickRes.content[0].text) as { ok: boolean };
      expect(clickParsed.ok).toBe(true);
      const titleRes = await handleBrowserTool(manager, sessionId("link"), "browser_evaluate", {
        action: "eval",
        script: `document.title`,
      });
      const titleParsed = JSON.parse(titleRes.content[0].text) as { ok: boolean; result: unknown };
      expect(titleParsed.ok).toBe(true);
      expect(titleParsed.result).toBe("clicked");

      // 4) browser_screenshot path 模式：落盘文件存在且非空
      const shotRes = await handleBrowserTool(manager, sessionId("link"), "browser_screenshot", {});
      const shotParsed = JSON.parse(shotRes.content[0].text) as {
        ok: boolean;
        path: string;
        sizeBytes: number;
      };
      expect(shotParsed.ok).toBe(true);
      expect(typeof shotParsed.path).toBe("string");
      expect(shotParsed.sizeBytes).toBeGreaterThan(0);
      expect(existsSync(shotParsed.path)).toBe(true);
      expect(statSync(shotParsed.path).size).toBe(shotParsed.sizeBytes);
      expect(readFileSync(shotParsed.path).length).toBeGreaterThan(0);

      // 5) browser_close：销毁视图
      const closeRes = await handleBrowserTool(manager, sessionId("link"), "browser_close", {});
      const closeParsed = JSON.parse(closeRes.content[0].text) as { ok: boolean; closed: boolean };
      expect(closeParsed.ok).toBe(true);
      expect(closeParsed.closed).toBe(true);
      expect(manager.get(sessionId("link"))).toBeUndefined();
    } finally {
      manager.dispose();
      rmSync(screenshotDir, { recursive: true, force: true });
    }
  });

  testReal("真实引擎：evaluate 对象返回值 JSON 序列化（WebViewLike 返回值形状假设）", async () => {
    const screenshotDir = mkdtempSync(join(tmpdir(), "browser-real-engine-"));
    const manager = new BrowserManager({
      screenshotDir,
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    try {
      await handleBrowserTool(manager, sessionId("obj"), "browser_navigate", { url: TEST_URL });
      const r = await handleBrowserTool(manager, sessionId("obj"), "browser_evaluate", {
        action: "eval",
        script: `(() => ({ h1: document.querySelector("h1").textContent, n: 42 }))()`,
      });
      const parsed = JSON.parse(r.content[0].text) as { ok: boolean; result: { h1: string; n: number } };
      expect(parsed.ok).toBe(true);
      expect(parsed.result).toEqual({ h1: "hello", n: 42 });
    } finally {
      manager.dispose();
      rmSync(screenshotDir, { recursive: true, force: true });
    }
  });
});
