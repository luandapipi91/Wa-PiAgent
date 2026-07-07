// vitest 全局 setup：给 happy-dom 补 WebSocket polyfill
// 组件测试里 ws-instance 的 getWs() 会 new WebSocket，happy-dom 无原生实现导致白屏报错
// 真实浏览器（E2E）有自己的 WebSocket，此 polyfill 只在 vitest 生效

class MockWebSocket {
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

// @ts-expect-error happy-dom 全局缺 WebSocket
globalThis.WebSocket = MockWebSocket;
