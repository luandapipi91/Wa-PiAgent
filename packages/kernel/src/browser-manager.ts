// browser-manager.ts —— 会话级 Bun.WebView 实例池。
//
// 每个 wa-pi 会话（sessionId）一个 WebView 实例（不同会话互不共享，Chrome
// 后端下各自独立 tab）。首次 browser_navigate 隐式创建，之后 evaluate/
// screenshot 复用同一实例。销毁三层：闲置超时 sweep、会话结束 closeSession、
// 显式 browser_close。视图工厂可注入，便于测试用 fake。
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { WA_PI_DIR } from "@wa-pi/shared";

/** 抽象 WebView 接口（隔离 Bun.WebView 类型，测试注入 fake） */
export interface WebViewLike {
  url: string;
  title: string;
  loading: boolean;
  navigate(url: string): Promise<void>;
  evaluate(script: string): Promise<unknown>;
  // 兼容两种调用形式：click(selector, opts?) 与 click(x, y, opts?)（真实 Bun.WebView 均支持）
  click(
    selectorOrX: string | number,
    yOrOpts?: unknown,
    opts?: unknown,
  ): Promise<void>;
  type(text: string): Promise<void>;
  press(key: string, opts?: unknown): Promise<void>;
  scroll(dx: number, dy: number): Promise<void>;
  scrollTo(selector: string, opts?: unknown): Promise<void>;
  /**
   * 发送原始 CDP 命令（仅 Chrome 后端支持，需先 navigate 建立会话）。
   * fake/旧引擎可省略——省略时依赖 CDP 的增强（如桌面 UA 伪装）自动跳过。
   */
  cdp?(method: string, params?: Record<string, unknown>): Promise<unknown>;
  screenshot(opts?: {
    format?: string;
    quality?: number;
    encoding?: string;
  }): Promise<Blob | Buffer | string>;
  close(): void;
}

export interface BrowserViewState {
  view: WebViewLike;
  sessionId: string;
  createdAt: number;
  lastUsedAt: number;
  /** 桌面 UA 伪装（幂等）的进行中 Promise；undefined 表示尚未开始 */
  userAgentReady?: Promise<void>;
}

export interface BrowserManagerOptions {
  /** 闲置多少毫秒后销毁（默认 10 分钟） */
  idleTimeoutMs?: number;
  /** sweep 定时器间隔（默认 60 秒） */
  sweepIntervalMs?: number;
  /** 视图工厂（默认 new Bun.WebView；测试注入 fake） */
  viewFactory?: (opts: { width: number; height: number }) => WebViewLike;
  /** 截图输出目录（默认 ${WA_PI_DIR}/tmp/browser-screenshots） */
  screenshotDir?: string;
}

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/**
 * 把引擎真实 UA 里的 HeadlessChrome 换成 Chrome —— 平台段、版本号等其余部分
 * 原样保留，因此伪装后的 UA 与运行机器的真实桌面 Chrome 一致（不硬编码）。
 */
export function toDesktopUserAgent(ua: string): string {
  return ua.replace(/HeadlessChrome/g, "Chrome");
}

/**
 * 默认视图工厂：真实 Bun.WebView，Chrome 后端。
 * 关键：argv 带 --mute-audio（页面媒体不自动出声——Chrome 后端默认允许
 * `<audio>`/`<video autoplay>` 播放，agent 自动化抓取页面时不应打扰用户）。
 * 构造器可注入（测试捕获参数/避免拉起真实 Chrome），默认 Bun.WebView。
 * backend 必须用 chrome 对象形式（非字符串）：argv 只能经对象形式传入。
 */
export function makeDefaultViewFactory(
  WebViewCtor: new (
    opts: Record<string, unknown>,
  ) => unknown = Bun.WebView as never,
): (opts: { width: number; height: number }) => WebViewLike {
  // SAFETY: 真实 Bun.WebView 与 WebViewLike 的方法签名同构（Layer 3 真实引擎
  // 集成测试验证 navigate/evaluate/click/type/press/scroll/scrollTo/screenshot/close
  // 与 url/title/loading 属性）；接口仅用于隔离类型，运行时无额外约束。
  return (o) =>
    new WebViewCtor({
      ...o,
      backend: { type: "chrome", argv: ["--mute-audio"] },
    }) as unknown as WebViewLike;
}

export class BrowserManager {
  private readonly views = new Map<string, BrowserViewState>();
  private readonly idleTimeoutMs: number;
  private readonly sweepIntervalMs: number;
  private readonly screenshotDir: string;
  private readonly viewFactory: (opts: {
    width: number;
    height: number;
  }) => WebViewLike;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: BrowserManagerOptions = {}) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.screenshotDir =
      opts.screenshotDir ?? join(WA_PI_DIR, "tmp", "browser-screenshots");
    // SAFETY: Bun.WebView 与 WebViewLike 的方法签名同构（Layer 3 真实引擎集成测试验证）。
    // 必须用 Chrome 后端：Bun.WebView 默认 backend 是 "webkit"（仅 macOS 可用），
    // 非 macOS 平台不传会直接构造抛错。makeDefaultViewFactory 注入 --mute-audio
    // 静音（页面媒体不自动出声），并允许测试注入假构造器捕获参数。
    this.viewFactory = opts.viewFactory ?? makeDefaultViewFactory();
    mkdirSync(this.screenshotDir, { recursive: true });
    this.sweepTimer = setInterval(() => this.sweepIdle(), this.sweepIntervalMs);
    // 定时器不阻止进程退出
    (this.sweepTimer as { unref?: () => void }).unref?.();
  }

  getScreenshotDir(): string {
    return this.screenshotDir;
  }

  /** 获取会话视图；未创建返回 undefined（并刷新 lastUsedAt） */
  get(sessionId: string): BrowserViewState | undefined {
    const state = this.views.get(sessionId);
    if (state) state.lastUsedAt = Date.now();
    return state;
  }

  /** 获取或创建视图（首次 navigate 自动创建）。已存在则复用。 */
  async getOrCreate(
    sessionId: string,
    opts: { width?: number; height?: number } = {},
  ): Promise<BrowserViewState> {
    const existing = this.views.get(sessionId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    const view = this.viewFactory({
      width: opts.width ?? 800,
      height: opts.height ?? 600,
    });
    const state: BrowserViewState = {
      view,
      sessionId,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    this.views.set(sessionId, state);
    return state;
  }

  /**
   * 首次导航前把 headless UA 伪装成同机桌面 Chrome。
   *
   * Chrome 后端 headless 模式下引擎 UA 带 `HeadlessChrome/…`（实测即使
   * `--headless=new` 也不去除），站点会据此识别为机器人。做法：先 about:blank
   * 建立 CDP 会话，读出引擎自己报的 UA，去掉 HeadlessChrome 后经
   * `Emulation.setUserAgentOverride` 应用 —— 平台段/版本号随运行机器，无硬编码；
   * 覆盖对该标签页后续导航（含请求头）持续生效。
   *
   * 幂等（同视图只做一次，并发共享同一次），引擎不支持 cdp 或应用失败时静默
   * 跳过：伪装是增强，不阻断导航。
   */
  async prepareUserAgent(state: BrowserViewState): Promise<void> {
    if (!state.userAgentReady) {
      state.userAgentReady = this.applyDesktopUserAgent(state).catch(() => {});
    }
    await state.userAgentReady;
  }

  private async applyDesktopUserAgent(state: BrowserViewState): Promise<void> {
    const { view } = state;
    if (typeof view.cdp !== "function") return;
    await view.navigate("about:blank"); // cdp 需先有导航建立会话
    const ua = await view.evaluate("navigator.userAgent");
    if (typeof ua !== "string" || !ua.includes("HeadlessChrome")) return;
    await view.cdp("Emulation.setUserAgentOverride", {
      userAgent: toDesktopUserAgent(ua),
    });
  }

  /** 销毁会话视图（幂等） */
  closeSession(sessionId: string): void {
    const state = this.views.get(sessionId);
    if (!state) return;
    try {
      state.view.close();
    } catch {
      // close 幂等，忽略
    }
    this.views.delete(sessionId);
  }

  /** 清理闲置超时的视图 */
  sweepIdle(): void {
    const now = Date.now();
    for (const [sessionId, state] of this.views) {
      if (now - state.lastUsedAt > this.idleTimeoutMs) {
        this.closeSession(sessionId);
      }
    }
  }

  /** 销毁全部视图并停掉 sweep 定时器（进程关停） */
  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const sessionId of [...this.views.keys()]) {
      this.closeSession(sessionId);
    }
  }
}
