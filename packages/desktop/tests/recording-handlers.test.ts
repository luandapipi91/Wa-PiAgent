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

test("permission handler 一律放行（免弹窗）", () => {
  const { session } = makeFakeSession();
  setupRecordingHandlers(session as any, { getSources: async () => [] } as any);
  let granted = false;
  session._prh({}, "media", (v: boolean) => { granted = v; });
  expect(granted).toBe(true);
  expect(session._pch()).toBe(true);
});
