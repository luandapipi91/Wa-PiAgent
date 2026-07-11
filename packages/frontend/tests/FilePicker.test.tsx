// FilePicker 组件测试：通过 fs-client 传输 seam 注入伪 WS 响应，
// 验证 defaultPath 定位展开到项目目录、未传时回退主目录、盘符大小写无关匹配。
// 不 mock.module("../src/fs-client")：跨文件缓存会污染 fs-client.test.ts（见该文件说明）。
import { test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { _setFsTransport, type FsTransport } from "../src/fs-client";

const handlers = new Set<(e: any) => void>();
const emit = (e: any) => handlers.forEach(h => h(e));
const sendCalls: any[] = [];

const HOME = "C:\\Users\\test";
const PROJECT = "C:\\Users\\test\\projects\\demo";

function entriesFor(path: string): any[] {
  switch (path) {
    case "C:\\": return [{ name: "Users", isDir: true }, { name: "Windows", isDir: true }];
    case "C:\\Users": return [{ name: "test", isDir: true }, { name: "Public", isDir: true }];
    case "C:\\Users\\test": return [{ name: "projects", isDir: true }, { name: "Documents", isDir: true }];
    case "C:\\Users\\test\\projects": return [{ name: "demo", isDir: true }, { name: "other", isDir: true }];
    case "C:\\Users\\test\\projects\\demo": return [{ name: "src", isDir: true }, { name: "README.md", isDir: false }];
    case "C:\\Users\\Public": return [{ name: "Downloads", isDir: true }, { name: "Music", isDir: true }];
    default: return [];
  }
}

// 模拟 fs:search 流式回放：在 root 子树下查找名称含 query 的目录
function searchMatches(root: string | undefined, query: string): any[] {
  const r = root && root.length > 0 ? root : HOME;
  const q = query.toLowerCase();
  const results: { name: string; path: string }[] = [];
  // demo 目录含 src 子目录
  if (`${r}\\demo`.toLowerCase().includes(q) || "demo".includes(q)) {
    results.push({ name: "demo", path: `${r}\\demo` });
  }
  if (`${r}\\other`.toLowerCase().includes(q) || "other".includes(q)) {
    results.push({ name: "other", path: `${r}\\other` });
  }
  return results.map(m => ({ ...m, isDir: true }));
}

const sendMock = mock((e: any) => {
  sendCalls.push(e);
  switch (e.type) {
    case "fs:home": emit({ type: "fs:home", home: HOME }); break;
    case "fs:roots": emit({ type: "fs:roots", roots: ["C:\\", "D:\\"] }); break;
    case "fs:listDir": emit({ type: "fs:listDir", path: e.path, entries: entriesFor(e.path) }); break;
    case "fs:search": {
      // 流式：先 progress 再 done，模拟 kernel 搜索事件流
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
const { FilePicker } = await import("../src/components/ui/FilePicker");

afterAll(() => _setFsTransport(null));

beforeEach(() => { document.body.innerHTML = ""; handlers.clear(); sendCalls.length = 0; sendMock.mockClear(); });
// 卸载上一用例未清理的组件：FilePicker 的搜索 effect 有 300ms debounce timer，
// 不 unmount 会泄漏到下一用例，污染 sendCalls。
afterEach(() => cleanup());

test("defaultPath 定位展开到项目目录：逐级 listDir、显示 demo 节点并默认聚焦", async () => {
  render(<FilePicker onPick={() => {}} onCancel={() => {}} defaultPath={PROJECT} />);

  // demo 节点可见 = 已逐级展开到项目目录
  await waitFor(() => {
    expect(screen.getByText(/📁\s*demo/)).toBeTruthy();
  }, { timeout: 3000 });

  // 逐级 listDir 覆盖项目目录的各级父目录
  const listedPaths = sendCalls.filter(e => e.type === "fs:listDir").map(e => e.path);
  expect(listedPaths).toContain("C:\\Users\\test\\projects");

  // 默认聚焦落在 demo 节点（data-rct-item-focus 由 viewState.focusedItem 驱动）
  await waitFor(() => {
    const focused = document.querySelector('[data-rct-item-focus="true"]');
    expect(focused?.textContent).toMatch(/demo/);
  }, { timeout: 3000 });
});

test("未传 defaultPath 时回退展开到主目录，项目深层节点不可见", async () => {
  render(<FilePicker onPick={() => {}} onCancel={() => {}} />);

  // 主目录 test 的子目录 projects 可见（test 被展开后懒载入子项）
  await waitFor(() => {
    expect(screen.getByText(/📁\s*projects/)).toBeTruthy();
  }, { timeout: 3000 });

  // demo 在 projects 之下，projects 未展开故不可见
  expect(screen.queryByText(/📁\s*demo/)).toBeNull();
});

test("defaultPath 盘符大小写与根不一致仍能定位（Windows 大小写无关）", async () => {
  // 根返回大写 C:\，项目路径用小写 c:\ 前缀
  render(<FilePicker onPick={() => {}} onCancel={() => {}} defaultPath={"c:\\Users\\test\\projects\\demo"} />);

  await waitFor(() => {
    expect(screen.getByText(/📁\s*demo/)).toBeTruthy();
  }, { timeout: 3000 });
});

test("defaultPath 指向不存在的路径时回退到主目录", async () => {
  render(<FilePicker onPick={() => {}} onCancel={() => {}} defaultPath={"C:\\does\\not\\exist"} />);

  // 回退到主目录后 projects 可见
  await waitFor(() => {
    expect(screen.getByText(/📁\s*projects/)).toBeTruthy();
  }, { timeout: 3000 });
});

// ── 手风琴展开：同级文件夹互斥 ──

test("手风琴：展开兄弟文件夹时，已展开的兄弟被折叠", async () => {
  render(<FilePicker onPick={() => {}} onCancel={() => {}} />);

  // 主目录 test 被展开（未传 defaultPath 时回退到主目录）
  await waitFor(() => {
    expect(screen.getByText(/📁\s*projects/)).toBeTruthy();
  }, { timeout: 3000 });

  // 展开 Public（test 的兄弟）→ test 应被折叠，其子项 projects 不再可见
  const publicText = screen.getByText(/📁\s*Public/);
  const publicTitle = publicText.closest(".rct-tree-item-title-container");
  const publicArrow = publicTitle?.querySelector(".rct-tree-item-arrow");
  expect(publicArrow).toBeTruthy();
  fireEvent.click(publicArrow!);

  await waitFor(() => {
    expect(screen.queryByText(/📁\s*projects/)).toBeNull();
  }, { timeout: 3000 });

  // Public 展开后子项可见
  await waitFor(() => {
    expect(screen.getByText(/📁\s*Downloads/)).toBeTruthy();
  }, { timeout: 3000 });
});

// ── 搜索范围限定到用户选择的文件夹 ──

test("搜索根跟随用户聚焦的目录", async () => {
  render(<FilePicker onPick={() => {}} onCancel={() => {}} defaultPath={PROJECT} />);

  await waitFor(() => {
    expect(screen.getByText(/📁\s*demo/)).toBeTruthy();
  }, { timeout: 3000 });

  // 点击 projects 目录节点 → 设为活动目录
  fireEvent.click(screen.getByText(/📁\s*projects/));

  // 清空观察记录，只看搜索请求
  sendCalls.length = 0;
  fireEvent.change(screen.getByTestId("file-picker-search"), { target: { value: "dem" } });

  await waitFor(() => {
    expect(sendCalls.some((e: any) => e.type === "fs:search")).toBe(true);
  }, { timeout: 3000 });

  const searchReqs = sendCalls.filter((e: any) => e.type === "fs:search");
  expect(searchReqs.length).toBeGreaterThan(0);
  // 每个搜索请求的 root 都应是聚焦的 projects 目录
  for (const r of searchReqs) {
    expect(r.root).toBe("C:\\Users\\test\\projects");
  }
});

test("未聚焦目录时搜索根回退到 defaultPath", async () => {
  render(<FilePicker onPick={() => {}} onCancel={() => {}} defaultPath={PROJECT} />);

  await waitFor(() => {
    expect(screen.getByText(/📁\s*demo/)).toBeTruthy();
  }, { timeout: 3000 });

  // 不点击任何节点，直接搜索
  sendCalls.length = 0;
  fireEvent.change(screen.getByTestId("file-picker-search"), { target: { value: "dem" } });

  await waitFor(() => {
    expect(sendCalls.some((e: any) => e.type === "fs:search")).toBe(true);
  }, { timeout: 3000 });

  const searchReqs = sendCalls.filter((e: any) => e.type === "fs:search");
  expect(searchReqs.length).toBeGreaterThan(0);
  // 展开链最深目录 = demo（defaultPath 定位展开到此），故 root 应为 demo 路径
  for (const r of searchReqs) {
    expect(r.root).toBe("C:\\Users\\test\\projects\\demo");
  }
});

// ── 增量结果不重展开已折叠节点 ──

test("搜索增量结果到达时，用户已折叠的节点保持折叠", async () => {
  // 独立 transport：fs:search 不自动回放，由测试手动 emit 流式进度
  const hSet = new Set<(e: any) => void>();
  const hEmit = (e: any) => hSet.forEach(h => h(e));
  const tSend = mock((e: any) => {
    sendCalls.push(e);
    switch (e.type) {
      case "fs:home": hEmit({ type: "fs:home", home: HOME }); break;
      case "fs:roots": hEmit({ type: "fs:roots", roots: ["C:\\", "D:\\"] }); break;
      case "fs:listDir": hEmit({ type: "fs:listDir", path: e.path, entries: entriesFor(e.path) }); break;
      case "fs:search": break; // 不自动响应，测试手动控制
      default: break;
    }
  });
  _setFsTransport({ send: tSend, onMessage: (h: (e: any) => void) => { hSet.add(h); return () => hSet.delete(h); } });

  try {
    render(<FilePicker onPick={() => {}} onCancel={() => {}} defaultPath={PROJECT} />);
    await waitFor(() => {
      expect(screen.getByText(/📁\s*demo/)).toBeTruthy();
    }, { timeout: 3000 });

    // 搜索 demo 子树
    fireEvent.change(screen.getByTestId("file-picker-search"), { target: { value: "src" } });

    // 抓 fs:search 请求
    let req: any;
    await waitFor(() => {
      req = sendCalls.find((e: any) => e.type === "fs:search");
      expect(req).toBeTruthy();
    }, { timeout: 3000 });

    // 第一批：src 匹配 → 搜索树展开
    const mkMatch = () => ({ name: "src", isDir: true, path: "C:\\Users\\test\\projects\\demo\\src" });
    hEmit({ type: "fs:search:progress", requestId: req.requestId, query: "src", matches: [mkMatch()] });
    await waitFor(() => {
      expect(screen.getByText(/📁\s*src/)).toBeTruthy();
    }, { timeout: 3000 });

    // 折叠搜索根 demo → src 消失
    const demoRoot = screen.getByText(/📁\s*C:\\Users\\test\\projects\\demo/);
    const arrow = demoRoot.closest(".rct-tree-item-title-container")?.querySelector(".rct-tree-item-arrow");
    expect(arrow).toBeTruthy();
    fireEvent.click(arrow!);
    await waitFor(() => {
      expect(screen.queryByText(/📁\s*src/)).toBeNull();
    }, { timeout: 3000 });

    // 第二批增量（内容相同但 searchTreeItems 引用变化）：
    // autoExpandedRef 已记录搜索根，故增量结果不会重新展开它 → src 保持折叠
    hEmit({ type: "fs:search:progress", requestId: req.requestId, query: "src", matches: [mkMatch()] });
    await new Promise((r) => setTimeout(r, 300));

    expect(screen.queryByText(/📁\s*src/)).toBeNull();
  } finally {
    _setFsTransport(transport); // 恢复共享 transport
  }
});
