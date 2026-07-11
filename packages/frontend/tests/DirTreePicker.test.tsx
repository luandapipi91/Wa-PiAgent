// DirTreePicker 组件测试：让组件使用真实 fs-client，通过传输 seam 注入伪 WS 响应，
// 验证渲染根、取消回调、选中触发 onPick、搜索过滤。
// 不再 mock.module("../src/fs-client")：bun 的 mock.module 跨文件缓存会泄漏给
// fs-client.test.ts（后者拿到伪造 listDir 而全挂）且无法按文件注销。
import { test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { _setFsTransport, type FsTransport } from "../src/fs-client";

// 伪 WS 传输：按 fs:* 请求类型回放响应（数据与原 mock 完全一致）。
const handlers = new Set<(e: any) => void>();
const emit = (e: any) => handlers.forEach(h => h(e));
const sendCalls: any[] = [];

function entriesFor(path: string, showHidden?: boolean): any[] {
  if (path === "C:\\") return [
    { name: "Users", isDir: true },
    { name: "Windows", isDir: true },
    { name: "Program Files", isDir: true },
    { name: "pagefile.sys", isDir: false },
    { name: "README.txt", isDir: false },
    ...(showHidden ? [{ name: ".hidden-root", isDir: true }, { name: ".hidden-file", isDir: false }] : []),
  ];
  if (path === "C:\\Users") return [
    { name: "test", isDir: true },
    { name: "Public", isDir: true },
    { name: "package.json", isDir: false },
    ...(showHidden ? [{ name: ".hidden-users", isDir: true }] : []),
  ];
  if (path === "C:\\Windows") return [
    { name: "System32", isDir: true },
    { name: "notepad.exe", isDir: false },
  ];
  if (path === "D:\\") return [
    { name: "Projects", isDir: true },
    { name: "Downloads", isDir: true },
  ];
  return [];
}

function searchMatches(root: string | undefined, query: string): any[] {
  const r = root && root.length > 0 ? root : "C:\\";
  const dirs = r === "C:\\" ? ["Users", "Windows", "Program Files"] : ["Projects", "Downloads"];
  const q = query.toLowerCase();
  return dirs
    .filter(n => n.toLowerCase().includes(q))
    .map(n => ({ name: n, isDir: true, path: `${r}${n}` }));
}

const sendMock = mock((e: any) => {
  sendCalls.push(e);
  switch (e.type) {
    case "fs:home": emit({ type: "fs:home", home: "C:\\Users\\test" }); break;
    case "fs:roots": emit({ type: "fs:roots", roots: ["C:\\", "D:\\"] }); break;
    case "fs:listDir": emit({ type: "fs:listDir", path: e.path, entries: entriesFor(e.path, e.showHidden) }); break;
    case "fs:search": {
      // 流式：有匹配先 progress，再 done，模拟 kernel 搜索事件流（real fs-client 聚合后回调）
      const matches = searchMatches(e.root, e.query);
      setTimeout(() => {
        if (matches.length) emit({ type: "fs:search:progress", requestId: e.requestId, query: e.query, matches });
        emit({ type: "fs:search", requestId: e.requestId, query: e.query, matches, durationMs: 0, truncated: false });
      }, 10);
      break;
    }
    default: break;
  }
});

const transport: FsTransport = {
  send: sendMock,
  onMessage: (h: (e: any) => void) => { handlers.add(h); return () => handlers.delete(h); },
};

_setFsTransport(transport);
const { DirTreePicker } = await import("../src/components/DirTreePicker");

afterAll(() => _setFsTransport(null));

beforeEach(() => { document.body.innerHTML = ""; handlers.clear(); sendCalls.length = 0; sendMock.mockClear(); });
// 卸载上一用例未清理的组件：DirTreePicker 的搜索 effect 有 300ms debounce timer，
// 不 unmount 会泄漏到下一用例，污染 sendCalls（表现为全量跑时 fs:search root 错乱）。
afterEach(() => cleanup());

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
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ type: "fs:listDir", path: "C:\\Windows", showHidden: false }));
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
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ type: "fs:listDir", path: "C:\\Windows", showHidden: false }));
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

// ── 搜索范围与折叠态保持 ──

test("搜索限定到当前选中文件夹的子树，而非所有盘符根", async () => {
  render(<DirTreePicker onPick={() => {}} onCancel={() => {}} />);
  await waitFor(() => {
    expect(screen.getByText(/📁\s*Windows/)).toBeTruthy();
  }, { timeout: 3000 });

  // 选中 D:\ 作为当前文件夹
  fireEvent.click(screen.getByText(/📁\s*D:\\/));
  await waitFor(() => {
    expect(document.querySelector(".text-blue.font-mono")?.textContent).toBe("D:\\");
  }, { timeout: 3000 });

  // 只观察搜索请求
  sendCalls.length = 0;
  fireEvent.change(screen.getByTestId("dir-search"), { target: { value: "Proj" } });

  await waitFor(() => {
    expect(sendCalls.some((e: any) => e.type === "fs:search")).toBe(true);
  }, { timeout: 3000 });

  const searchReqs = sendCalls.filter((e: any) => e.type === "fs:search");
  expect(searchReqs.length).toBeGreaterThan(0);
  // 每个搜索请求的 root 都应是当前选中文件夹 D:\，而非 C:\ 或所有盘符
  for (const r of searchReqs) {
    expect(r.root).toBe("D:\\");
  }
});

test("搜索增量结果更新时，用户已折叠的节点保持折叠", async () => {
  // 独立 transport：fs:search 不自动回放，由测试手动 emit 流式进度，
  // 以便控制「第一批展开 → 折叠 → 第二批增量」的时序（共享 sendMock 10ms 后自动 done 会关闭流）。
  const hSet = new Set<(e: any) => void>();
  const hEmit = (e: any) => hSet.forEach(h => h(e));
  const tSend = mock((e: any) => {
    sendCalls.push(e);
    switch (e.type) {
      case "fs:home": hEmit({ type: "fs:home", home: "C:\\Users\\test" }); break;
      case "fs:roots": hEmit({ type: "fs:roots", roots: ["C:\\", "D:\\"] }); break;
      case "fs:listDir": hEmit({ type: "fs:listDir", path: e.path, entries: entriesFor(e.path, e.showHidden) }); break;
      case "fs:search": break; // 不自动响应，测试手动控制
      default: break;
    }
  });
  _setFsTransport({ send: tSend, onMessage: (h: (e: any) => void) => { hSet.add(h); return () => hSet.delete(h); } });

  try {
    render(<DirTreePicker onPick={() => {}} onCancel={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText(/📁\s*Windows/)).toBeTruthy();
    }, { timeout: 3000 });
    // selectedPath 默认 = home = C:\Users\test
    expect(document.querySelector(".text-blue.font-mono")?.textContent).toBe("C:\\Users\\test");

    fireEvent.change(screen.getByTestId("dir-search"), { target: { value: "sub" } });

    // 抓 fs:search 请求（选中 C:\Users\test 后只发一个，root = C:\Users\test）
    let req: any;
    await waitFor(() => {
      req = sendCalls.find((e: any) => e.type === "fs:search");
      expect(req).toBeTruthy();
    }, { timeout: 3000 });

    // 第一批：subdir 匹配 → 搜索树 root→C:\Users\test→subdir，C:\Users\test 自动展开
    const mkMatch = () => ({ name: "subdir", isDir: true, path: "C:\\Users\\test\\subdir" });
    hEmit({ type: "fs:search:progress", requestId: req.requestId, query: "sub", matches: [mkMatch()] });
    await waitFor(() => {
      expect(screen.getByText(/📁\s*subdir/)).toBeTruthy();
    }, { timeout: 3000 });

    // 折叠搜索根 C:\Users\test → subdir 消失
    const root0 = screen.getByText(/📁\s*C:\\Users\\test/);
    const arrow = root0.closest(".rct-tree-item-title-container")?.querySelector(".rct-tree-item-arrow");
    expect(arrow).toBeTruthy();
    fireEvent.click(arrow!);
    await waitFor(() => {
      expect(screen.queryByText(/📁\s*subdir/)).toBeNull();
    }, { timeout: 3000 });

    // 第二批增量（内容相同但 searchTreeItems 引用变化）→ 当前 bug 会重展开 C:\Users\test
    hEmit({ type: "fs:search:progress", requestId: req.requestId, query: "sub", matches: [mkMatch()] });
    await new Promise((r) => setTimeout(r, 200));

    // 折叠应保持：subdir 不应重新出现
    expect(screen.queryByText(/📁\s*subdir/)).toBeNull();
  } finally {
    _setFsTransport(transport); // 恢复共享 transport
  }
});
