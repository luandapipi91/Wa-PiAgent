import { test, expect } from "bun:test";
import { setupRecordingHandlers } from "../src/util/recording-handlers.cjs";

function makeFakeSession() {
  const calls: string[] = [];
  return {
    calls,
    session: {
      setDisplayMediaRequestHandler(fn: any) { calls.push("setDisplayMediaRequestHandler"); this._dmh = fn; },
      setPermissionRequestHandler(fn: any) { calls.push("setPermissionRequestHandler"); this._prh = fn; },
      setPermissionCheckHandler(fn: any) { calls.push("setPermissionCheckHandler"); this._pch = fn; },
      _dmh: null as any, _prh: null as any, _pch: null as any,
    },
  };
}

test("注册三个 handler", () => {
  const { session, calls } = makeFakeSession();
  const desktopCapturer = { getSources: async () => [{ id: "s1", name: "Screen" }] };
  setupRecordingHandlers(session as any, desktopCapturer as any);
  expect(calls).toEqual([
    "setDisplayMediaRequestHandler",
    "setPermissionRequestHandler",
    "setPermissionCheckHandler",
  ]);
});

test("getDisplayMedia handler 返回 loopback 音频且不抛", async () => {
  const { session } = makeFakeSession();
  const desktopCapturer = { getSources: async () => [{ id: "s1", name: "Screen" }] };
  setupRecordingHandlers(session as any, desktopCapturer as any);
  let result: any = null;
  await session._dmh({}, (cb: any) => { result = cb; });
  expect(result.audio).toBe("loopback");
});

test("permission handler 仅放行媒体/录音相关权限", () => {
  const { session } = makeFakeSession();
  setupRecordingHandlers(session as any, { getSources: async () => [] } as any);

  let granted = false;
  session._prh(null, "media", (v: boolean) => { granted = v; });
  expect(granted).toBe(true);

  session._prh(null, "notifications", (v: boolean) => { granted = v; });
  expect(granted).toBe(false);

  expect(session._pch(null, "media")).toBe(true);
  expect(session._pch(null, "display-capture")).toBe(true);
  expect(session._pch(null, "notifications")).toBe(false);
  expect(session._pch(null, "geolocation")).toBe(false);
});

test("permission handler 放行 clipboard-read / clipboard-write，保证打包后复制功能正常", () => {
  const { session } = makeFakeSession();
  setupRecordingHandlers(session as any, { getSources: async () => [] } as any);

  expect(session._pch(null, "clipboard-read")).toBe(true);
  expect(session._pch(null, "clipboard-write")).toBe(true);

  let cbRead = false, cbWrite = false;
  session._prh(null, "clipboard-read", (v: boolean) => { cbRead = v; });
  session._prh(null, "clipboard-write", (v: boolean) => { cbWrite = v; });
  expect(cbRead).toBe(true);
  expect(cbWrite).toBe(true);
});
