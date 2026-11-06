// browser-real-baidu.test.ts —— Layer 3 真实引擎百度场景（ref 工作流端到端验收）。
//
// 独立文件的原因（2026-11-07）：Chrome 进程级 argv 由进程内第一个 WebView 决定，
// 与引擎本体测试同进程时，probeEngineAvailable 的默认工厂先启动 Chrome（无
// --no-proxy-server），百度用例的直连工厂追加参数无效——Windows 系统代理上游
// 失效时（代理活但 CONNECT 被关）百度 net::ERR_CONNECTION_CLOSED 永红。
// 独立进程内直连工厂是第一个 WebView，argv 生效，百度导航与系统代理状态解耦。
//
// 「模型不走 ref」行为修复的端到端验收：快照 [ref=N] → type/press 全部用 ref 定位，
// 全程零 CSS selector。
//
// 引擎不可用（BUN_CHROME_PATH 未指向可执行文件等）时整个 suite 跳过（与 engine 探测同源）；
// 百度直连不可达（断网/系统代理环境下的直连探测失败）时百度用例跳过并打印原因。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserManager, type WebViewLike } from "../src/browser-manager";
import { handleBrowserTool } from "../src/browser-tools";

// 剥离 shell 继承的代理变量（直连意图）：宿主 dev 环境会把 http_proxy/https_proxy 指到
// kernel proxy-relay（127.0.0.1:<随机端口>），测试进程继承后外网导航（百度）走会话代理
// 快速失败——2026-11-07 实测同 shell 直连 000 / --noproxy 200。对 127.0.0.1 本机通信无影响
//（bun fetch 对回环不走代理，其余测试零感知）。
for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) {
  delete process.env[k];
}


// 直连工厂（模块级）：必须由它构造本进程第一个 WebView——Chrome 进程级 argv 只在
// 首次启动时生效，若让默认工厂先跑（无 --no-proxy-server），后面百度用例再传直连
// 工厂也不生效（这正是拆独立文件的原因，见文件头注释）。probe 用同一工厂保持一致。
// 生产 argv 基础上追加 --no-proxy-server：Chrome 走 Windows 系统代理（注册表 ProxyServer，
// 非 env），系统代理活但上游失效时百度 net::ERR_CONNECTION_CLOSED；本文件目标只有百度，
// 直连与系统代理状态解耦。生产工厂不带此参数（桌面端用户可能依赖系统代理出网）。
const WebViewCtor = Bun.WebView as unknown as new (
	opts: Record<string, unknown>,
) => unknown;
const directViewFactory = (o: { width: number; height: number }) =>
  new WebViewCtor({
    ...o,
    backend: {
      type: "chrome",
      argv: ["--mute-audio", "--disable-blink-features=AutomationControlled", "--no-proxy-server"],
    },
  }) as unknown as WebViewLike;

// 真实引擎可用性探测：不可用则全部跳过（不算失败，spec §6）。用直连工厂保证 argv 首启动。
async function probeEngineAvailable(): Promise<boolean> {
  try {
    const view = directViewFactory({ width: 160, height: 120 });
    try {
      await view.navigate("about:blank");
      return (await view.evaluate(`1 + 1`)) === 2;
    } finally {
      view.close();
    }
  } catch {
    return false;
  }
}
const engineAvailable = await probeEngineAvailable();
const testReal = engineAvailable ? test : test.skip;

// 百度直连可达性门：百度用例的价值在 ref 工作流验收而非网络诊断，但 Chrome 尊重
// Windows 系统代理（ProxyServer 注册表，而非 env）——系统代理活但上游失效时
//（2026-11-07 实测：127.0.0.1:7890 监听中但 CONNECT 被直接关闭 → net::ERR_CONNECTION_CLOSED）
// 百度不可达且与代码无关，永红会淹没真实回归信号；直连不可达时 skip 并打印原因。
// 注：上面的 env 代理剥离使这个 fetch 是真直连，能代表 Chrome 在无系统代理下的可达性。
const baiduReachable = await fetch("https://www.baidu.com", { signal: AbortSignal.timeout(5_000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!baiduReachable) {
  console.log(
    "[Layer 3] 百度直连不可达，跳过百度场景（可能是系统代理上游失效/网络隔离，与代码无关）：",
    "请检查 Windows 系统代理（Internet 选项）或代理软件上游",
  );
}
const testBaidu = baiduReachable ? test : test.skip;

function sessionId(tag: string): string {
  return `test-session-${tag}`;
}

describe("Layer 3 真实引擎 ref 工作流（百度场景，2026-11-03）", () => {
  // 「模型不走 ref」行为修复的端到端验收：快照 [ref=N] → type/press 全部用 ref 定位，
  // 全程零 CSS selector。依赖外网可达 baidu.com；不可达时 wait/导航超时算失败，
  // 由 CI/本地环境自行取舍（与引擎不可用跳过不同源，不混用 skipIf）。
  testBaidu("navigate → snapshot → type{ref} → press{ref, Enter} → 搜索结果页（wd=wa-pi）", async () => {
    const screenshotDir = mkdtempSync(join(tmpdir(), "browser-real-baidu-"));
    const manager = new BrowserManager({
      screenshotDir,
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
      viewFactory: directViewFactory,
    });
    const sid = sessionId("baidu");
    try {
      // 1) 导航百度：返回体快照首行带 ref 提示（动态提示双保险）
      const nav = await handleBrowserTool(manager, sid, "browser_navigate", {
        url: "https://www.baidu.com",
        timeout: 60_000,
      });
      const navP = JSON.parse(nav.content[0].text) as { ok: boolean; snapshot?: string };
      expect(navP.ok).toBe(true);
      expect(navP.snapshot?.startsWith("提示：元素定位优先级 ref > text > selector > x/y")).toBe(true);

      // 2) snapshot 拿输入框 ref（模拟模型标准工作流，不猜 selector）
      const snap = await handleBrowserTool(manager, sid, "browser_snapshot", {});
      const snapP = JSON.parse(snap.content[0].text) as {
        ok: boolean;
        snapshot: string;
      };
      expect(snapP.ok).toBe(true);
      expect(snapP.snapshot.startsWith("提示：元素定位优先级 ref > text > selector > x/y")).toBe(true);
      const lines = snapP.snapshot.split("\n");
      const refOf = (line: string | undefined) => line?.match(/\[ref=(\d+)\]/)?.[1];
      const inputLine = lines.find((l) => /- (textbox|searchbox|combobox)/.test(l));
      const inputRefStr = refOf(inputLine);
      expect(inputRefStr).toBeDefined(); // 百度首页必有输入框
      const inputRef = Number(inputRefStr);

      // 3) type{ref} 键入（clear:true 防残留；返回体带 ref 回显）
      const type = await handleBrowserTool(manager, sid, "browser_evaluate", {
        action: "type",
        ref: inputRef,
        text: "wa-pi",
        clear: true,
        timeout: 30_000,
      });
      const typeP = JSON.parse(type.content[0].text) as { ok: boolean; ref: number };
      expect(typeP.ok).toBe(true);
      expect(typeP.ref).toBe(inputRef);

      // 4) press{ref, Enter}：输入框内发起检索（百度新版 textarea 需聚焦时回车）
      const press = await handleBrowserTool(manager, sid, "browser_evaluate", {
        action: "press",
        ref: inputRef,
        key: "Enter",
        timeout: 30_000,
      });
      const pressP = JSON.parse(press.content[0].text) as { ok: boolean; ref: number };
      expect(pressP.ok).toBe(true);
      expect(pressP.ref).toBe(inputRef);

      // 5) 断言搜索结果页出现（URL 进 /s?wd=wa-pi）
      await handleBrowserTool(manager, sid, "browser_wait", { text: "wa-pi", timeout: 20_000 });
      const final = await handleBrowserTool(manager, sid, "browser_evaluate", {
        action: "eval",
        script: "location.href + ' | ' + document.title",
      });
      const finalText = String((JSON.parse(final.content[0].text) as { result: string }).result);
      expect(finalText).toMatch(/baidu\.com\/s\?/);
      expect(finalText).toContain("wd=wa-pi");
    } finally {
      manager.dispose();
      rmSync(screenshotDir, { recursive: true, force: true });
    }
  }, 240_000);

  testReal("wait{text} 命中返回体快照已含新出现元素（省一次 snapshot 往返实证）", async () => {
    // 页面：点击后 600ms 才插入 late-marker 元素 → wait 命中时新元素已在页面
    const html = `<h1>延迟页</h1><button id="go" onclick="setTimeout(function(){document.body.insertAdjacentHTML('beforeend','<div id=late>late-marker</div>')},600)">触发</button>`;
    const url = "data:text/html;charset=utf-8," + encodeURIComponent(html);
    const screenshotDir = mkdtempSync(join(tmpdir(), "browser-real-waitsnap-"));
    const manager = new BrowserManager({
      screenshotDir,
      idleTimeoutMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    const sid = sessionId("waitsnap");
    try {
      await handleBrowserTool(manager, sid, "browser_navigate", { url });
      const snap = await handleBrowserTool(manager, sid, "browser_snapshot", {});
      const snapP = JSON.parse(snap.content[0].text) as { snapshot: string };
      const goRef = Number(snapP.snapshot.match(/- button[^\n]*\[ref=(\d+)\]/)?.[1]);
      expect(goRef).toBeGreaterThan(0);
      await handleBrowserTool(manager, sid, "browser_evaluate", { action: "click", ref: goRef, snapshot: false });
      // wait 命中即附快照：返回体应已包含 wait 前不存在、wait 后才出现的新元素 ref 行
      const wt = await handleBrowserTool(manager, sid, "browser_wait", { text: "late-marker", timeout: 8000 });
      const wtP = JSON.parse(wt.content[0].text) as {
        ok?: boolean; matched?: boolean; snapshot?: string; refCount?: number; hint?: string;
      };
      expect(wtP.ok).toBe(true);
      expect(wtP.matched).toBe(true);
      expect(wtP.snapshot).toBeDefined(); // 命中附快照（差值含新元素）
      expect(wtP.snapshot).toContain("late-marker");
      expect(wtP.snapshot).toMatch(/\[ref=\d+\]/); // 新元素已带 ref，后续可直接用
      expect((wtP.refCount ?? 0)).toBeGreaterThan(0);
    } finally {
      manager.dispose();
      rmSync(screenshotDir, { recursive: true, force: true });
    }
  }, 60_000);
});
