// fake-browser-manager.ts —— 测试共享的 noop BrowserManager 假实现。
//
// AgentManager 构造默认 `new BrowserManager()`（mkdirSync 截图目录 + 启动 60s sweep
// 定时器）。不关心 browser_* 工具的既有测试注入本 helper，消除构造副作用：任何路径
// 都不抛错、不产生 I/O、不启动定时器。需要记录调用轨迹的测试（如 browser-tools-
// bridge.test.ts）请用各自的 makeFakeBrowserManager，本文件不记录轨迹。
import type {
  BrowserManager,
  BrowserViewState,
  WebViewLike,
} from "../../src/browser-manager";

/** noop WebView：全部方法空实现，url/title/loading 取安全值，不抛错 */
function makeNoopView(): WebViewLike {
  return {
    url: "about:blank",
    title: "",
    loading: false,
    async navigate() {},
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
    close() {},
  };
}

/** noop BrowserManager：构造点注入用（鸭子类型 + double cast，同 fakeClientFactory 惯例）。
 *  不抛错、不产生 I/O、不启动定时器。 */
export const NOOP_BROWSER_MANAGER = {
  getScreenshotDir: () => "/tmp",
  get: () => undefined,
  async getOrCreate(sessionId: string): Promise<BrowserViewState> {
    return {
      view: makeNoopView(),
      sessionId,
      createdAt: 0,
      lastUsedAt: 0,
    };
  },
  closeSession() {},
  sweepIdle() {},
  dispose() {},
} as unknown as BrowserManager;
