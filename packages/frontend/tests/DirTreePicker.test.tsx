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
  expect(screen.getByTestId("dir-picker")).toBeTruthy();
  expect(screen.getByTestId("dir-pick")).toBeTruthy();
  await waitFor(() => {
    expect(screen.getByText(/📁\s*C:\\/)).toBeTruthy();
  }, { timeout: 3000 });
  await waitFor(() => {
    expect(screen.getByText(/📁\s*D:\\/)).toBeTruthy();
  }, { timeout: 3000 });
});

test("打开时默认选中主目录，选择按钮可用", async () => {
  render(<DirTreePicker onPick={() => {}} onCancel={() => {}} />);
  const pickBtn = screen.getByTestId("dir-pick") as HTMLButtonElement;
  await waitFor(() => {
    expect(pickBtn.disabled).toBe(false);
  }, { timeout: 3000 });
});

test("默认主目录可直接选择", async () => {
  const onPick = mock();
  render(<DirTreePicker onPick={onPick} onCancel={() => {}} />);
  const pickBtn = screen.getByTestId("dir-pick") as HTMLButtonElement;
  await waitFor(() => {
    expect(pickBtn.disabled).toBe(false);
  }, { timeout: 3000 });
  fireEvent.click(pickBtn);
  expect(onPick).toHaveBeenCalledWith("C:\\Users\\test");
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
    expect(screen.getByText(/📁\s*D:\\/)).toBeTruthy();
  }, { timeout: 3000 });
  // 点击非自动聚焦的盘符节点，触发选中切换
  fireEvent.click(screen.getByText(/📁\s*D:\\/));
  // 等待 selectedPath 更新为 D:\
  await waitFor(() => {
    const headerEl = document.querySelector('.text-blue.font-mono');
    expect(headerEl?.textContent).toBe("D:\\");
  }, { timeout: 3000 });
  fireEvent.click(screen.getByTestId("dir-pick"));
  expect(onPick).toHaveBeenCalledWith("D:\\");
});
