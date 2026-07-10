// DirTreePicker 组件测试：mock fs-client，验证渲染根、取消回调、选中触发 onPick、搜索过滤。
import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// mock fs-client：getRoots 返回虚拟盘符，listDir 按路径返回测试目录结构
mock.module("../src/fs-client", () => ({
  getHome: () => Promise.resolve("C:\\Users\\test"),
  getRoots: () => Promise.resolve(["C:\\", "D:\\"]),
  listDir: (path: string) => {
    if (path === "C:\\") return Promise.resolve([
      { name: "Users", isDir: true },
      { name: "Windows", isDir: true },
      { name: "Program Files", isDir: true },
    ]);
    if (path === "C:\\Users") return Promise.resolve([
      { name: "test", isDir: true },
      { name: "Public", isDir: true },
    ]);
    if (path === "D:\\") return Promise.resolve([
      { name: "Projects", isDir: true },
      { name: "Downloads", isDir: true },
    ]);
    return Promise.resolve([]);
  },
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

// ── 搜索过滤测试 ──

test("搜索框渲染", async () => {
  render(<DirTreePicker onPick={() => {}} onCancel={() => {}} />);
  await waitFor(() => {
    const input = screen.getByTestId("dir-search") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.placeholder).toBe("搜索目录…");
  }, { timeout: 3000 });
});

test("输入关键字过滤可见目录，仅显示匹配项及其父级链", async () => {
  render(<DirTreePicker onPick={() => {}} onCancel={() => {}} />);

  // 等待 C:\ 预展开完成，子目录加载
  await waitFor(() => {
    expect(screen.getByText(/📁\s*Windows/)).toBeTruthy();
  }, { timeout: 3000 });
  // 确认 Users 和 Program Files 也都可见
  expect(screen.getByText(/📁\s*Users/)).toBeTruthy();
  expect(screen.getByText(/📁\s*Program Files/)).toBeTruthy();

  // 输入关键字 "Win"
  const searchInput = screen.getByTestId("dir-search") as HTMLInputElement;
  fireEvent.change(searchInput, { target: { value: "Win" } });

  // Windows 仍然可见（匹配关键字）
  await waitFor(() => {
    expect(screen.getByText(/📁\s*Windows/)).toBeTruthy();
  }, { timeout: 3000 });
  // C:\ 作为父级链保留
  expect(screen.getByText(/📁\s*C:\\/)).toBeTruthy();

  // Users 和 Program Files 不可见（不匹配）
  expect(screen.queryByText(/📁\s*Users/)).toBeNull();
  expect(screen.queryByText(/📁\s*Program Files/)).toBeNull();
});

test("清空搜索恢复全部可见目录", async () => {
  render(<DirTreePicker onPick={() => {}} onCancel={() => {}} />);

  await waitFor(() => {
    expect(screen.getByText(/📁\s*Windows/)).toBeTruthy();
  }, { timeout: 3000 });

  // 输入关键字
  const searchInput = screen.getByTestId("dir-search") as HTMLInputElement;
  fireEvent.change(searchInput, { target: { value: "Win" } });

  // 确认过滤生效
  await waitFor(() => {
    expect(screen.queryByText(/📁\s*Users/)).toBeNull();
  }, { timeout: 3000 });

  // 清空搜索
  fireEvent.change(searchInput, { target: { value: "" } });

  // Users 恢复可见
  await waitFor(() => {
    expect(screen.getByText(/📁\s*Users/)).toBeTruthy();
  }, { timeout: 3000 });
  // Program Files 也恢复
  expect(screen.getByText(/📁\s*Program Files/)).toBeTruthy();
});

test("无匹配目录时显示空状态提示", async () => {
  render(<DirTreePicker onPick={() => {}} onCancel={() => {}} />);

  await waitFor(() => {
    expect(screen.getByText(/📁\s*C:\\/)).toBeTruthy();
  }, { timeout: 3000 });

  const searchInput = screen.getByTestId("dir-search") as HTMLInputElement;
  fireEvent.change(searchInput, { target: { value: "xyz-nonexistent-12345" } });

  await waitFor(() => {
    expect(screen.getByText(/无匹配/)).toBeTruthy();
  }, { timeout: 3000 });
});

test("搜索时仍可选择匹配的目录", async () => {
  const onPick = mock();
  render(<DirTreePicker onPick={onPick} onCancel={() => {}} />);

  await waitFor(() => {
    expect(screen.getByText(/📁\s*Windows/)).toBeTruthy();
  }, { timeout: 3000 });

  // 输入关键字
  const searchInput = screen.getByTestId("dir-search") as HTMLInputElement;
  fireEvent.change(searchInput, { target: { value: "Win" } });

  // 点击匹配的 Windows 目录
  await waitFor(() => {
    expect(screen.getByText(/📁\s*Windows/)).toBeTruthy();
  }, { timeout: 3000 });
  fireEvent.click(screen.getByText(/📁\s*Windows/));

  // 点击选择按钮
  fireEvent.click(screen.getByTestId("dir-pick"));
  expect(onPick).toHaveBeenCalledWith("C:\\Windows");
});
