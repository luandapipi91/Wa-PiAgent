// DirTreePicker 组件测试：mock fs-client，验证渲染根、取消回调、选中触发 onPick、搜索过滤。
import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// mock fs-client：getRoots 返回虚拟盘符，listDir 按路径返回测试目录结构
const listDirMock = mock((path: string, showHidden?: boolean) => {
  if (path === "C:\\") return Promise.resolve([
    { name: "Users", isDir: true },
    { name: "Windows", isDir: true },
    { name: "Program Files", isDir: true },
    { name: "pagefile.sys", isDir: false },
    { name: "README.txt", isDir: false },
    ...(showHidden ? [{ name: ".hidden-root", isDir: true }, { name: ".hidden-file", isDir: false }] : []),
  ]);
  if (path === "C:\\Users") return Promise.resolve([
    { name: "test", isDir: true },
    { name: "Public", isDir: true },
    { name: "package.json", isDir: false },
    ...(showHidden ? [{ name: ".hidden-users", isDir: true }] : []),
  ]);
  if (path === "C:\\Windows") return Promise.resolve([
    { name: "System32", isDir: true },
    { name: "notepad.exe", isDir: false },
  ]);
  if (path === "D:\\") return Promise.resolve([
    { name: "Projects", isDir: true },
    { name: "Downloads", isDir: true },
  ]);
  return Promise.resolve([]);
});

mock.module("../src/fs-client", () => ({
  getHome: () => Promise.resolve("C:\\Users\\test"),
  getRoots: () => Promise.resolve(["C:\\", "D:\\"]),
  listDir: listDirMock,
  searchFilesStream: (_query: string, opts: any, handlers: any) => {
    const matches: any[] = [];
    const roots = opts.roots.length > 0 ? opts.roots : ["C:\\"];
    const lowerQuery = _query.toLowerCase();
    for (const root of roots) {
      const dirs = root === "C:\\" ? ["Users", "Windows", "Program Files"] : ["Projects", "Downloads"];
      for (const name of dirs) {
        if (name.toLowerCase().includes(lowerQuery)) {
          matches.push({ name, isDir: true, path: `${root}${name}` });
        }
      }
    }
    const timer = setTimeout(() => {
      if (matches.length) handlers.onProgress(matches);
      handlers.onDone({ durationMs: 0, truncated: false });
    }, 10);
    return () => clearTimeout(timer);
  },
}));

const { DirTreePicker } = await import("../src/components/DirTreePicker");

beforeEach(() => { document.body.innerHTML = ""; listDirMock.mockClear(); });

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
  expect(onCancel).toHaveBeenCalledTimes(1);
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
    expect(input.placeholder).toBe("搜索文件名…");
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

test("默认不显示文件节点，只显示目录", async () => {
  render(<DirTreePicker onPick={() => {}} onCancel={() => {}} />);

  await waitFor(() => {
    expect(screen.getByText(/📁\s*Users/)).toBeTruthy();
  }, { timeout: 3000 });

  expect(screen.queryByText(/pagefile\.sys/)).toBeNull();
  expect(screen.queryByText(/package\.json/)).toBeNull();
});

test("showFiles=true 时显示文件节点", async () => {
  render(<DirTreePicker onPick={() => {}} onCancel={() => {}} showFiles />);

  await waitFor(() => {
    expect(screen.getByText(/📄\s*pagefile\.sys/)).toBeTruthy();
  }, { timeout: 3000 });
  expect(screen.getByText(/📄\s*README\.txt/)).toBeTruthy();
  expect(screen.getByText(/📄\s*package\.json/)).toBeTruthy();
});

test("showFiles=false 时输入文件名过滤会定位到包含该文件的目录，但不显示文件", async () => {
  render(<DirTreePicker onPick={() => {}} onCancel={() => {}} />);

  await waitFor(() => {
    expect(screen.getByText(/📁\s*Users/)).toBeTruthy();
  }, { timeout: 3000 });

  const searchInput = screen.getByTestId("dir-search") as HTMLInputElement;
  fireEvent.change(searchInput, { target: { value: "package" } });

  // C:\Users 因包含 package.json 而被保留
  await waitFor(() => {
    expect(screen.getByText(/📁\s*Users/)).toBeTruthy();
  }, { timeout: 3000 });
  expect(screen.getByText(/📁\s*C:\\/)).toBeTruthy();

  // 文件节点本身不显示
  expect(screen.queryByText(/package\.json/)).toBeNull();
  // 不相关目录被过滤掉
  expect(screen.queryByText(/📁\s*Windows/)).toBeNull();
});

test("showFiles=true 时输入文件名过滤会显示匹配文件及其父目录链", async () => {
  render(<DirTreePicker onPick={() => {}} onCancel={() => {}} showFiles />);

  await waitFor(() => {
    expect(screen.getByText(/📄\s*pagefile\.sys/)).toBeTruthy();
  }, { timeout: 3000 });

  const searchInput = screen.getByTestId("dir-search") as HTMLInputElement;
  fireEvent.change(searchInput, { target: { value: "package" } });

  // package.json 文件及其父级 C:\Users、C:\ 应保留
  await waitFor(() => {
    expect(screen.getByText(/package\.json/)).toBeTruthy();
  }, { timeout: 3000 });
  expect(screen.getByText(/📁\s*Users/)).toBeTruthy();
  expect(screen.getByText(/📁\s*C:\\/)).toBeTruthy();

  // 不相关目录被过滤掉
  expect(screen.queryByText(/📁\s*Windows/)).toBeNull();
  expect(screen.queryByText(/📄\s*pagefile\.sys/)).toBeNull();
});

test("showFiles=true 时点击文件节点选中其父目录", async () => {
  const onPick = mock();
  render(<DirTreePicker onPick={onPick} onCancel={() => {}} showFiles />);

  await waitFor(() => {
    expect(screen.getByText(/📄\s*package\.json/)).toBeTruthy();
  }, { timeout: 3000 });

  fireEvent.click(screen.getByText(/📄\s*package\.json/));

  // 顶部路径应显示文件所在目录
  await waitFor(() => {
    const headerEl = document.querySelector('.text-blue.font-mono');
    expect(headerEl?.textContent).toBe("C:\\Users");
  }, { timeout: 3000 });

  fireEvent.click(screen.getByTestId("dir-pick"));
  expect(onPick).toHaveBeenCalledWith("C:\\Users");
});

// ── 显示隐藏目录测试 ──

test("默认不显示隐藏目录，开启开关后显示隐藏目录", async () => {
  render(<DirTreePicker onPick={() => {}} onCancel={() => {}} />);

  // 等待 C:\ 子目录加载完成
  await waitFor(() => {
    expect(screen.getByText(/📁\s*Users/)).toBeTruthy();
  }, { timeout: 3000 });

  // 默认不显示隐藏目录
  expect(screen.queryByText(/📁\s*\.hidden-root/)).toBeNull();

  // 点击显示隐藏目录开关
  const toggle = screen.getByText("显示隐藏目录");
  fireEvent.click(toggle);

  // 隐藏目录应该出现
  await waitFor(() => {
    expect(screen.getByText(/📁\s*\.hidden-root/)).toBeTruthy();
  }, { timeout: 3000 });
});

test("默认目录模式下可展开用户子目录（懒加载）", async () => {
  render(<DirTreePicker onPick={() => {}} onCancel={() => {}} />);

  await waitFor(() => {
    expect(screen.getByText(/📁\s*Windows/)).toBeTruthy();
  }, { timeout: 3000 });

  // 找到 Windows 目录项的展开箭头并点击
  const windowsText = screen.getByText(/📁\s*Windows/);
  const titleContainer = windowsText.closest(".rct-tree-item-title-container");
  const arrow = titleContainer?.querySelector(".rct-tree-item-arrow");
  expect(arrow).toBeTruthy();
  fireEvent.click(arrow!);

  // 应触发 listDir 懒加载 C:\Windows
  await waitFor(() => {
    expect(listDirMock).toHaveBeenCalledWith("C:\\Windows", false);
  }, { timeout: 3000 });

  // System32 子目录应出现
  await waitFor(() => {
    expect(screen.getByText(/📁\s*System32/)).toBeTruthy();
  }, { timeout: 3000 });
});

test("搜索过滤后目录仍保留懒加载占位符可展开", async () => {
  render(<DirTreePicker onPick={() => {}} onCancel={() => {}} />);

  await waitFor(() => {
    expect(screen.getByText(/📁\s*Windows/)).toBeTruthy();
  }, { timeout: 3000 });

  const searchInput = screen.getByTestId("dir-search") as HTMLInputElement;
  fireEvent.change(searchInput, { target: { value: "Windows" } });

  // Windows 目录被保留
  await waitFor(() => {
    expect(screen.getByText(/📁\s*Windows/)).toBeTruthy();
  }, { timeout: 3000 });

  // 展开 Windows
  const windowsText = screen.getByText(/📁\s*Windows/);
  const titleContainer = windowsText.closest(".rct-tree-item-title-container");
  const arrow = titleContainer?.querySelector(".rct-tree-item-arrow");
  fireEvent.click(arrow!);

  // 懒加载应被触发
  await waitFor(() => {
    expect(listDirMock).toHaveBeenCalledWith("C:\\Windows", false);
  }, { timeout: 3000 });
});

test("开启显示隐藏目录后，隐藏目录可被选择", async () => {
  const onPick = mock();
  render(<DirTreePicker onPick={onPick} onCancel={() => {}} />);

  await waitFor(() => {
    expect(screen.getByText(/📁\s*Users/)).toBeTruthy();
  }, { timeout: 3000 });

  // 开启显示隐藏目录
  fireEvent.click(screen.getByText("显示隐藏目录"));

  // 等待隐藏目录出现并点击
  await waitFor(() => {
    expect(screen.getByText(/📁\s*\.hidden-root/)).toBeTruthy();
  }, { timeout: 3000 });
  fireEvent.click(screen.getByText(/📁\s*\.hidden-root/));

  // 选择按钮应可用并触发 onPick
  await waitFor(() => {
    const headerEl = document.querySelector('.text-blue.font-mono');
    expect(headerEl?.textContent).toBe("C:\\.hidden-root");
  }, { timeout: 3000 });

  fireEvent.click(screen.getByTestId("dir-pick"));
  expect(onPick).toHaveBeenCalledWith("C:\\.hidden-root");
});
