// 测试全局 setup：给 happy-dom 补 WebSocket polyfill
// 组件测试里 ws-instance 的 getWs() 会 new WebSocket。happy-dom 无原生实现；
// 而 bun:test 自带原生 WebSocket（会真连 ws://127.0.0.1 抛 ErrorEvent 杀死测试运行）。
// 真实浏览器（E2E）有自己的 WebSocket，此 polyfill 只在单元测试生效。
//
// 注意（bun:test）：globalThis.WebSocket 是 bun 内置，普通 `= MockWebSocket` 赋值不生效；
// 必须用 Object.defineProperty。且必须在 happy-dom GlobalRegistrator.register() 之后调用
// （见 happydom-setup.ts），否则 register 会重置 globalThis 导致覆盖丢失。

export class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 1;  // 直接 OPEN，让 send() 走 fast path
  addEventListener() {}
  removeEventListener() {}
  send() {}
  close() {}
  set onmessage(_: any) {}
  set onopen(_: any) {}
  set onerror(_: any) {}
  set onclose(_: any) {}
}

// 用 defineProperty 强制替换全局 WebSocket（bun:test 下普通赋值静默失败）。
// @ts-expect-error 全局 WebSocket 类型与本 mock 不完全一致
export function installWebSocketMock() {
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: MockWebSocket,
  });
}
