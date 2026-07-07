// DirTreePicker 组件测试：mock fs-client，验证渲染根、取消回调、选中触发 onPick。
import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// mock fs-client：getRoots 返回虚拟盘符，listDir 返回空（懒加载根节点）
mock.module("../src/fs-client", () => ({
  getHome: () => Promise.resolve("C:\\Users\\test"),
  getRoots: () => Promise.resolve(["C:\\", "D:\\"]),
  listDir: () => Promise.resolve([]),
}));

const { DirTreePicker } = await import("../src/components/DirTreePicker");

beforeEach(() => { document.body.innerHTML = ""; });

test("打开显示盘符根节点", async () => {
  render(<DirTreePicker onPick={() => {}} onCancel={() => {}} />);
  // 遮罩 + 选择按钮存在
  expect(screen.getByTestId("dir-picker")).toBeTruthy();
  expect(screen.getByTestId("dir-pick")).toBeTruthy();
  // react-complex-tree 的 rootItem 是虚拟根（不渲染行），仅渲染其子节点（盘符）。
  // DataProvider 异步管线在 happy-dom 下较慢，放宽超时。
  await waitFor(() => {
    expect(screen.getByText(/C:\\/)).toBeTruthy();
  }, { timeout: 3000 });
  await waitFor(() => {
    expect(screen.getByText(/D:\\/)).toBeTruthy();
  }, { timeout: 3000 });
});

test("未选中目录时「选择」按钮禁用", async () => {
  render(<DirTreePicker onPick={() => {}} onCancel={() => {}} />);
  const pickBtn = screen.getByTestId("dir-pick") as HTMLButtonElement;
  expect(pickBtn.disabled).toBe(true);
});

test("点击取消触发 onCancel", () => {
  const onCancel = mock();
  render(<DirTreePicker onPick={() => {}} onCancel={onCancel} />);
  fireEvent.click(screen.getByTestId("dir-cancel"));
  expect(onCancel).toHaveBeenCalledOnce();
});

test("点击盘符选中后「选择」可点且触发 onPick", async () => {
  const onPick = mock();
  render(<DirTreePicker onPick={onPick} onCancel={() => {}} />);
  await waitFor(() => {
    expect(screen.getByText(/C:\\/)).toBeTruthy();
  }, { timeout: 3000 });
  // 点选盘符节点 → selectedPath 置位 → 选择按钮启用
  fireEvent.click(screen.getByText(/C:\\/));
  const pickBtn = screen.getByTestId("dir-pick") as HTMLButtonElement;
  await waitFor(() => {
    expect(pickBtn.disabled).toBe(false);
  });
  fireEvent.click(pickBtn);
  expect(onPick).toHaveBeenCalledWith("C:\\");
});
