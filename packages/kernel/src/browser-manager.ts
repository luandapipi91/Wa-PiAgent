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
  click(selectorOrX: string | number, yOrOpts?: unknown, opts?: unknown): Promise<void>;
  type(text: string): Promise<void>;
  press(key: string, opts?: unknown): Promise<void>;
  scroll(dx: number, dy: number): Promise<void>;
  scrollTo(selector: string, opts?: unknown): Promise<void>;
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

export class BrowserManager {
  private readonly views = new Map<string, BrowserViewState>();
  private readonly idleTimeoutMs: number;
  private readonly sweepIntervalMs: number;
  private readonly screenshotDir: string;
  private readonly viewFactory: (opts: { width: number; height: number }) => WebViewLike;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: BrowserManagerOptions = {}) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.screenshotDir = opts.screenshotDir ?? join(WA_PI_DIR, "tmp", "browser-screenshots");
    // SAFETY: Bun.WebView 与 WebViewLike 的方法签名同构（Layer 3 真实引擎集成测试验证）。
    // 必须显式传 backend: "chrome"：Bun.WebView 默认 backend 是 "webkit"（仅 macOS 可用），
    // 非 macOS 平台不传会直接构造抛错。"chrome" 自动探测本机 Chrome/Chromium/Edge。
    this.viewFactory =
      opts.viewFactory ?? ((o) => new Bun.WebView({ ...o, backend: "chrome" }) as unknown as WebViewLike);
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
