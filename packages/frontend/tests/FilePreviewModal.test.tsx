// FilePreviewModal 组件测试：全局文件预览弹窗的开关行为。
// 核心回归：预览状态在 store，宿主组件卸载不关闭；只有用户手动关闭（✕/ESC/遮罩）才消失。
import { test, expect, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
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
  fake.setResponse("fs:readFile", { content: btoa("preview-content-abc"), mimeType: "text/plain" });
  useSessionStore.getState().openFilePreview("/work/demo/src/index.ts", "s1");
  render(<FilePreviewModal />);
  await waitFor(() =>
    expect(screen.getByTestId("file-preview-modal").textContent).toContain("preview-content-abc"),
  );
  expect(fake.sent[0]).toMatchObject({ type: "fs:readFile", path: "/work/demo/src/index.ts" });
});

test("openFilePreview 幂等：同文件重复打开不报错且状态不变", () => {
  useSessionStore.getState().openFilePreview("/a.ts", "s1");
  const first = useSessionStore.getState().filePreview;
  useSessionStore.getState().openFilePreview("/a.ts", "s1");
  expect(useSessionStore.getState().filePreview).toEqual(first);
});

test("openFilePreview 切换路径：后打开的文件覆盖前一个", () => {
  useSessionStore.getState().openFilePreview("/a.ts", "s1");
  useSessionStore.getState().openFilePreview("/b.ts", "s1");
  expect(useSessionStore.getState().filePreview?.path).toBe("/b.ts");
});

test("ESC 键关闭预览：modal 消失且 store 清空", async () => {
  fake.setResponse("fs:readFile", { content: btoa("x"), mimeType: "text/plain" });
  useSessionStore.getState().openFilePreview("/a.ts", "s1");
  render(<FilePreviewModal />);
  await waitFor(() => expect(screen.getByTestId("file-preview-modal")).toBeTruthy());
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(screen.queryByTestId("file-preview-modal")).toBeNull());
  expect(useSessionStore.getState().filePreview).toBeNull();
});

test("遮罩点击关闭预览：modal 消失且 store 清空", async () => {
  fake.setResponse("fs:readFile", { content: btoa("x"), mimeType: "text/plain" });
  useSessionStore.getState().openFilePreview("/a.ts", "s1");
  render(<FilePreviewModal />);
  await waitFor(() => expect(screen.getByTestId("file-preview-modal")).toBeTruthy());
  fireEvent.click(screen.getByTestId("modal-overlay"));
  await waitFor(() => expect(screen.queryByTestId("file-preview-modal")).toBeNull());
  expect(useSessionStore.getState().filePreview).toBeNull();
});

test("宿主组件卸载（模拟流式结束/折叠）后预览窗保持打开——核心回归", async () => {
  fake.setResponse("fs:readFile", { content: btoa("keep-open"), mimeType: "text/plain" });
  useSessionStore.getState().openFilePreview("/keep.ts", "s1");
  const { unmount } = render(<FilePreviewModal />);
  await waitFor(() => expect(screen.getByTestId("file-preview-modal").textContent).toContain("keep-open"));
  // 卸载再重挂（等价于宿主树重建）：store 状态仍在 → 预览窗重新出现
  unmount();
  cleanup();
  render(<FilePreviewModal />);
  await waitFor(() => expect(screen.getByTestId("file-preview-modal").textContent).toContain("keep-open"));
});
