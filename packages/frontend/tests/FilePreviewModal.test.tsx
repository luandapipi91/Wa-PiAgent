// FilePreviewModal 组件测试：全局文件预览弹窗的开关行为。
// 核心回归：预览状态在 store，宿主组件卸载不关闭；只有用户手动关闭（✕/ESC）才消失。
// 点遮罩不关闭（防预览大文件时误触阴影丢窗口）。
import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { FilePreviewModal } from "../src/components/blocks/FilePreviewModal";
import { _setFsTransport } from "../src/fs-client";
import { useSessionStore } from "../src/store/session";
import { makeFakeFsTransport } from "./fs-transport";

const fake = makeFakeFsTransport();

beforeEach(() => {
  useSessionStore.setState({ filePreview: null });
  _setFsTransport(fake.transport);
  fake.calls.length = 0;
  fake.sent.length = 0;
  fake.responses.clear();
});

afterEach(() => cleanup());

test("无 filePreview 时渲染 null（不出现弹窗）", () => {
  const { container } = render(<FilePreviewModal />);
  expect(container.firstChild).toBeNull();
});

test("openFilePreview 后渲染 Modal + FileViewer 内容", async () => {
  fake.setResponse("fs:readFile", {
    content: btoa("preview-content-abc"),
    mimeType: "text/plain",
  });
  useSessionStore.getState().openFilePreview("/work/demo/src/index.ts", "s1");
  render(<FilePreviewModal />);
  await waitFor(() =>
    expect(screen.getByTestId("file-preview-modal").textContent).toContain(
      "preview-content-abc",
    ),
  );
  expect(fake.sent[0]).toMatchObject({
    type: "fs:readFile",
    path: "/work/demo/src/index.ts",
  });
});

test("openFilePreview 幂等：同文件重复打开不报错且状态不变", () => {
  useSessionStore.getState().openFilePreview("/a.ts", "s1");
  const first = useSessionStore.getState().filePreview;
  useSessionStore.getState().openFilePreview("/a.ts", "s1");
  // 引用同一性断言：若实现每次都新建对象、触发 zustand 状态变更，此断言会失败
  expect(useSessionStore.getState().filePreview).toBe(first);
});

test("openFilePreview 切换路径：后打开的文件覆盖前一个", () => {
  useSessionStore.getState().openFilePreview("/a.ts", "s1");
  useSessionStore.getState().openFilePreview("/b.ts", "s1");
  expect(useSessionStore.getState().filePreview?.path).toBe("/b.ts");
});

test("ESC 键关闭预览：modal 消失且 store 清空", async () => {
  fake.setResponse("fs:readFile", {
    content: btoa("x"),
    mimeType: "text/plain",
  });
  useSessionStore.getState().openFilePreview("/a.ts", "s1");
  render(<FilePreviewModal />);
  await waitFor(() =>
    expect(screen.getByTestId("file-preview-modal")).toBeTruthy(),
  );
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByTestId("file-preview-modal")).toBeNull(),
  );
  expect(useSessionStore.getState().filePreview).toBeNull();
});

test("遮罩点击不关闭预览（防误触）：modal 仍在且 store 保留", async () => {
  fake.setResponse("fs:readFile", {
    content: btoa("x"),
    mimeType: "text/plain",
  });
  useSessionStore.getState().openFilePreview("/a.ts", "s1");
  render(<FilePreviewModal />);
  await waitFor(() =>
    expect(screen.getByTestId("file-preview-modal")).toBeTruthy(),
  );
  fireEvent.click(screen.getByTestId("modal-overlay"));
  expect(screen.getByTestId("file-preview-modal")).toBeTruthy();
  expect(useSessionStore.getState().filePreview).not.toBeNull();
});

// 参考浮动预览窗（FloatWindow + localStorage floatRect）：拖右下角手柄改尺寸，
// mouseup 持久化，重开弹窗保持上次尺寸。
test("拖手柄调整大小：尺寸持久化，关闭重开保持上次尺寸", async () => {
  localStorage.removeItem("hiagent.filePreview.size");
  fake.setResponse("fs:readFile", {
    content: btoa("x"),
    mimeType: "text/plain",
  });
  useSessionStore.getState().openFilePreview("/a.ts", "s1");
  const { unmount } = render(<FilePreviewModal />);
  await waitFor(() =>
    expect(screen.getByTestId("file-preview-modal")).toBeTruthy(),
  );
  const card = screen.getByTestId("file-preview-modal") as HTMLElement;
  // happy-dom 无真实布局：覆写 getBoundingClientRect 模拟卡片位置尺寸（800×600 @ 96,54）
  card.getBoundingClientRect = () =>
    ({ left: 96, top: 54, width: 800, height: 600 }) as DOMRect;
  const handle = screen.getByTestId("modal-resize-handle");
  fireEvent.mouseDown(handle, { clientX: 896, clientY: 654 });
  fireEvent.mouseMove(window, { clientX: 996, clientY: 704 }); // +100/+50 → 900×650
  fireEvent.mouseUp(window);
  // 尺寸持久化到 localStorage
  expect(JSON.parse(localStorage.getItem("hiagent.filePreview.size")!)).toEqual(
    {
      width: 900,
      height: 650,
    },
  );
  // 关闭后重开：初始尺寸用持久化值（而非默认 80vw/80vh）
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByTestId("file-preview-modal")).toBeNull(),
  );
  // 先卸载第一棵渲染树（它还订阅着 store，不卸载会在重开时同时渲染出第二个 modal）
  unmount();
  useSessionStore.getState().openFilePreview("/a.ts", "s1");
  render(<FilePreviewModal />);
  await waitFor(() =>
    expect(screen.getByTestId("file-preview-modal")).toBeTruthy(),
  );
  expect(
    (screen.getByTestId("file-preview-modal") as HTMLElement).style.width,
  ).toBe("900px");
  expect(
    (screen.getByTestId("file-preview-modal") as HTMLElement).style.height,
  ).toBe("650px");
  unmount();
  localStorage.removeItem("hiagent.filePreview.size");
});

test("无持久化尺寸时用默认 80vw/80vh", async () => {
  localStorage.removeItem("hiagent.filePreview.size");
  fake.setResponse("fs:readFile", {
    content: btoa("x"),
    mimeType: "text/plain",
  });
  useSessionStore.getState().openFilePreview("/a.ts", "s1");
  render(<FilePreviewModal />);
  await waitFor(() =>
    expect(screen.getByTestId("file-preview-modal")).toBeTruthy(),
  );
  const card = screen.getByTestId("file-preview-modal") as HTMLElement;
  expect(card.style.width).toBe("80vw");
  expect(card.style.height).toBe("80vh");
});

// 本用例仅验证「卸载后重新挂载仍保持打开」（状态存于 store）。
// 真实宿主（FilePill 所在消息行/委派卡）随流式结束/折叠卸载的场景由 FilePill.test.tsx 的宿主卸载用例覆盖。
test("卸载后重新挂载仍保持打开（状态存于 store）", async () => {
  fake.setResponse("fs:readFile", {
    content: btoa("keep-open"),
    mimeType: "text/plain",
  });
  useSessionStore.getState().openFilePreview("/keep.ts", "s1");
  const { unmount } = render(<FilePreviewModal />);
  await waitFor(() =>
    expect(screen.getByTestId("file-preview-modal").textContent).toContain(
      "keep-open",
    ),
  );
  // 卸载再重挂（等价于宿主树重建）：store 状态仍在 → 预览窗重新出现
  unmount();
  render(<FilePreviewModal />);
  await waitFor(() =>
    expect(screen.getByTestId("file-preview-modal").textContent).toContain(
      "keep-open",
    ),
  );
});

test("closeFilePreview 在 filePreview 为 null 时调用：no-op 不触发状态变更", () => {
  const before = useSessionStore.getState().filePreview;
  useSessionStore.getState().closeFilePreview();
  const after = useSessionStore.getState().filePreview;
  expect(after).toBeNull();
  // 引用同一性：no-op 不新建对象、不触发重渲染
  expect(after).toBe(before);
});

test("clear() 后 filePreview 重置为 null", () => {
  useSessionStore.getState().openFilePreview("/a.ts", "s1");
  expect(useSessionStore.getState().filePreview).not.toBeNull();
  useSessionStore.getState().clear();
  expect(useSessionStore.getState().filePreview).toBeNull();
});

// 文件预览窗位置拖动：按住标题栏（顶部工具行）移动窗口，位置持久化到 localStorage，
// 关闭重开保持上次位置（与尺寸持久化同款范式）。
test("拖标题栏移动窗口：位置持久化，关闭重开保持上次位置", async () => {
  localStorage.removeItem("hiagent.filePreview.pos");
  fake.setResponse("fs:readFile", {
    content: btoa("pos"),
    mimeType: "text/plain",
  });
  useSessionStore.getState().openFilePreview("/pos.ts", "s1");
  const { unmount } = render(<FilePreviewModal />);
  // Modal 走 createPortal 渲染到 body，查询用 document；内容加载完才有标题栏把手
  await waitFor(() =>
    expect(screen.getByTestId("file-preview-modal").textContent).toContain(
      "pos",
    ),
  );
  const card = screen.getByTestId("file-preview-modal") as HTMLElement;
  // happy-dom 无真实布局：覆写 getBoundingClientRect 模拟卡片位置尺寸（800×600 @ 96,54）
  card.getBoundingClientRect = () =>
    ({ left: 96, top: 54, width: 800, height: 600 }) as DOMRect;
  const handle = document.querySelector(
    "[data-modal-drag-handle]",
  ) as HTMLElement;
  expect(handle).toBeTruthy(); // FileViewer 头部必须标出拖动把手
  fireEvent.mouseDown(handle, { clientX: 200, clientY: 100 });
  fireEvent.mouseMove(window, { clientX: 260, clientY: 140 });
  expect(card.style.left).toBe("156px");
  expect(card.style.top).toBe("94px");
  fireEvent.mouseUp(window);
  expect(JSON.parse(localStorage.getItem("hiagent.filePreview.pos")!)).toEqual({
    left: 156,
    top: 94,
  });

  // 卸载重挂（等价于关闭后重新打开）：按记录位置定位
  unmount();
  render(<FilePreviewModal />);
  const card2 = screen.getByTestId("file-preview-modal") as HTMLElement;
  expect(card2.style.position).toBe("fixed");
  expect(card2.style.left).toBe("156px");
  expect(card2.style.top).toBe("94px");
});

test("内容区按下拖动不移动窗口（仅标题栏可拖）", async () => {
  localStorage.removeItem("hiagent.filePreview.pos");
  fake.setResponse("fs:readFile", {
    content: btoa("body"),
    mimeType: "text/plain",
  });
  useSessionStore.getState().openFilePreview("/body.ts", "s1");
  render(<FilePreviewModal />);
  await waitFor(() =>
    expect(screen.getByTestId("file-preview-modal")).toBeTruthy(),
  );
  const card = screen.getByTestId("file-preview-modal") as HTMLElement;
  card.getBoundingClientRect = () =>
    ({ left: 96, top: 54, width: 800, height: 600 }) as DOMRect;
  fireEvent.mouseDown(screen.getByTestId("file-viewer"), {
    clientX: 200,
    clientY: 300,
  });
  fireEvent.mouseMove(window, { clientX: 260, clientY: 340 });
  expect(card.style.left).toBe("");
  expect(card.style.position).toBe("relative");
  expect(localStorage.getItem("hiagent.filePreview.pos")).toBeNull();
});

// 真实使用路径：FilePreviewModal 常驻挂载在 App 根（App.tsx:770），关闭预览只是
// 组件 return null（Modal 卸载），组件本身不重挂——尺寸/位置必须在每次打开时重新读取，
// 否则用户拖过的大小与位置在关闭重开后丢失。
test("常驻挂载（不重挂组件）：关闭重开保持上次尺寸与位置", async () => {
  localStorage.clear();
  fake.setResponse("fs:readFile", {
    content: btoa("keep-size-pos"),
    mimeType: "text/plain",
  });
  render(<FilePreviewModal />);
  useSessionStore.getState().openFilePreview("/keep-size-pos.ts", "s1");
  await waitFor(() =>
    expect(screen.getByTestId("file-preview-modal")).toBeTruthy(),
  );
  const card = screen.getByTestId("file-preview-modal") as HTMLElement;
  card.getBoundingClientRect = () =>
    ({ left: 100, top: 80, width: 400, height: 300 }) as DOMRect;

  // 1) 拖右下角手柄：400×300 → 500×400
  const resizeHandle = screen.getByTestId("modal-resize-handle");
  fireEvent.mouseDown(resizeHandle, { clientX: 500, clientY: 380 });
  fireEvent.mouseMove(window, { clientX: 600, clientY: 480 });
  fireEvent.mouseUp(window);
  expect(card.style.width).toBe("500px");
  expect(card.style.height).toBe("400px");

  // 2) 拖标题栏：位置 (100,80) → (150,110)（视口 1024×768，未触 clamp）
  card.getBoundingClientRect = () =>
    ({ left: 100, top: 80, width: 500, height: 400 }) as DOMRect;
  const dragHandle = document.querySelector(
    "[data-modal-drag-handle]",
  ) as HTMLElement;
  fireEvent.mouseDown(dragHandle, { clientX: 150, clientY: 100 });
  fireEvent.mouseMove(window, { clientX: 200, clientY: 130 });
  fireEvent.mouseUp(window);

  // 3) 关闭（组件仍在树上，只是 return null）→ 重开
  useSessionStore.getState().closeFilePreview();
  await waitFor(() =>
    expect(screen.queryByTestId("file-preview-modal")).toBeNull(),
  );
  useSessionStore.getState().openFilePreview("/keep-size-pos.ts", "s1");
  await waitFor(() =>
    expect(screen.getByTestId("file-preview-modal")).toBeTruthy(),
  );

  const reopened = screen.getByTestId("file-preview-modal") as HTMLElement;
  expect(reopened.style.width).toBe("500px");
  expect(reopened.style.height).toBe("400px");
  expect(reopened.style.left).toBe("150px");
  expect(reopened.style.top).toBe("110px");
});
