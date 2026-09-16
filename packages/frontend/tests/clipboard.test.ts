import { test, expect, mock } from "bun:test";

// copyToClipboard / copyImageToClipboard 的跨平台逻辑单元测试
// 核心行为：Electron 用 waPiClipboard，浏览器回退 navigator.clipboard

function mkWin(electron: boolean) {
  if (electron) {
    return { waPiClipboard: { writeText: mock(() => {}), writeImage: mock(() => {}) } };
  }
  return {} as any;
}

test("Electron 环境：优先用 waPiClipboard.writeText", async () => {
  const win = mkWin(true);
  (globalThis as any).window = win;

  const { copyToClipboard } = await import("../src/util/clipboard");
  await copyToClipboard("hello");

  expect(win.waPiClipboard!.writeText).toHaveBeenCalledWith("hello");
});

test("浏览器环境：回退 navigator.clipboard.writeText", async () => {
  (globalThis as any).window = mkWin(false);
  const writeText = mock(() => Promise.resolve());
  // 通过 Object.defineProperty 绕过只读 navigator
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText, write: mock(() => Promise.resolve()) } },
    writable: true,
    configurable: true,
  });

  const { copyToClipboard } = await import("../src/util/clipboard");
  await copyToClipboard("hello");

  expect(writeText).toHaveBeenCalledWith("hello");
});

test("Electron 环境：优先用 waPiClipboard.writeImage", async () => {
  const win = mkWin(true);
  (globalThis as any).window = win;

  const { copyImageToClipboard } = await import("../src/util/clipboard");
  const blob = new Blob(["fake-png-data"], { type: "image/png" });
  await copyImageToClipboard(blob);

  expect(win.waPiClipboard!.writeImage).toHaveBeenCalled();
});

test("浏览器环境：回退 navigator.clipboard.write (图片)", async () => {
  (globalThis as any).window = mkWin(false);
  const write = mock(() => Promise.resolve());
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: mock(() => Promise.resolve()), write } },
    writable: true,
    configurable: true,
  });

  const { copyImageToClipboard } = await import("../src/util/clipboard");
  const blob = new Blob(["fake-png-data"], { type: "image/png" });
  await copyImageToClipboard(blob);

  expect(write).toHaveBeenCalled();
  const arg = (write as any).mock.calls[0][0];
  expect(arg[0]).toBeInstanceOf(ClipboardItem);
});
