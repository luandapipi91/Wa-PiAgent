// FilePicker 组件测试：通过 fs-client 传输 seam 注入伪 WS 响应，
// 验证 defaultPath 定位展开到项目目录、未传时回退主目录、盘符大小写无关匹配。
// 不 mock.module("../src/fs-client")：跨文件缓存会污染 fs-client.test.ts（见该文件说明）。
import { test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { _setFsTransport } from "../src/fs-client";
import { emitEventForTesting } from "../src/events";
import { adaptLegacyTransport, type LegacyFsTransport } from "./fs-transport-adapter";
import type { FilePickerSelection } from "../src/components/ui/FilePicker";

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
    case "C:\\Users\\test\\projects\\demo": return [
      // 刻意文件与文件夹交错、文件在前，用于验证「先文件夹后文件」的显示顺序
      { name: "z-note.txt", isDir: false },
      { name: "alpha", isDir: true },
      { name: "m-doc.md", isDir: false },
      { name: "bravo", isDir: true },
    ];
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
      // 流式：先 progress 再 done，通过真实 SSE 总线事件模拟 kernel 搜索事件流
      const matches = searchMatches(e.root, e.query);
      setTimeout(() => {
        if (matches.length) emitEventForTesting({ type: "fs:search:progress", requestId: e.requestId, query: e.query, matches } as any);
        emitEventForTesting({ type: "fs:search", requestId: e.requestId, query: e.query, matches, durationMs: 0, truncated: false } as any);
      }, 10);
      break;
    }
    default: break;
  }
});

const legacyTransport: LegacyFsTransport = {
  send: sendMock,
  onMessage: (h: (e: any) => void) => { handlers.add(h); return () => handlers.delete(h); },
};
const fsTransport = adaptLegacyTransport(legacyTransport);

_setFsTransport(fsTransport);
const { FilePicker } = await import("../src/components/ui/FilePicker");

afterAll(() => _setFsTransport(null));

beforeEach(() => { document.body.innerHTML = ""; handlers.clear(); sendCalls.length = 0; sendMock.mockClear(); });
// 卸载上一用例未清理的组件：FilePicker 的搜索 effect 有 300ms debounce timer，
// 不 unmount 会泄漏到下一用例，污染 sendCalls。
afterEach(() => cleanup());

// react-complex-tree 的 treeitem <li> 里目录名与 svg 图标同层，导致 testing-library
// 的 getByText 因「文本被多元素分割」匹配不到（且 emoji 图标改 svg 后不再贡献文本）。
// 这里直接定位 [data-rct-item-interactive]（= .rct-tree-item-button）：
// 它是文本载体（textContent 含目录名）、点击选中目标、且 .closest 能命中的
// title-container 内（展开箭头为其兄弟元素）——与渲染层图标实现（emoji / svg）解耦，最稳。
function treeItem(text: string): Element {
  const items = Array.from(document.querySelectorAll('[data-rct-item-interactive]'));
  const found = items.find((el) => (el.textContent ?? "").trim() === text || (el.textContent ?? "").includes(text));
  if (!found) throw new Error(`找不到含 "${text}" 的 treeitem`);
  return found;
}
function queryTreeItem(text: string): Element | null {
  const items = Array.from(document.querySelectorAll('[data-rct-item-interactive]'));
  return items.find((el) => (el.textContent ?? "").trim() === text || (el.textContent ?? "").includes(text)) ?? null;
}

test("defaultPath 定位展开到项目目录：逐级 listDir、显示 demo 节点并默认聚焦", async () => {
  render(<FilePicker onPick={() => {}} onCancel={() => {}} defaultPath={PROJECT} />);

  // demo 节点可见 = 已逐级展开到项目目录
  await waitFor(() => {
    expect(treeItem("demo")).toBeTruthy();
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
    expect(treeItem("projects")).toBeTruthy();
  }, { timeout: 3000 });

  // demo 在 projects 之下，projects 未展开故不可见
  expect(queryTreeItem("demo")).toBeNull();
});

test("defaultPath 盘符大小写与根不一致仍能定位（Windows 大小写无关）", async () => {
  // 根返回大写 C:\，项目路径用小写 c:\ 前缀
  render(<FilePicker onPick={() => {}} onCancel={() => {}} defaultPath={"c:\\Users\\test\\projects\\demo"} />);

  await waitFor(() => {
    expect(treeItem("demo")).toBeTruthy();
  }, { timeout: 3000 });
});

test("defaultPath 指向不存在的路径时回退到主目录", async () => {
  render(<FilePicker onPick={() => {}} onCancel={() => {}} defaultPath={"C:\\does\\not\\exist"} />);

  // 回退到主目录后 projects 可见
  await waitFor(() => {
    expect(treeItem("projects")).toBeTruthy();
  }, { timeout: 3000 });
});

// ── 手风琴展开：同级文件夹互斥 ──

test("手风琴：展开兄弟文件夹时，已展开的兄弟被折叠", async () => {
  render(<FilePicker onPick={() => {}} onCancel={() => {}} />);

  // 主目录 test 被展开（未传 defaultPath 时回退到主目录）
  await waitFor(() => {
    expect(treeItem("projects")).toBeTruthy();
  }, { timeout: 3000 });

  // 展开 Public（test 的兄弟）→ test 应被折叠，其子项 projects 不再可见
  const publicText = treeItem("Public");
  const publicTitle = publicText.closest(".rct-tree-item-title-container");
  const publicArrow = publicTitle?.querySelector(".rct-tree-item-arrow");
  expect(publicArrow).toBeTruthy();
  fireEvent.click(publicArrow!);

  await waitFor(() => {
    expect(queryTreeItem("projects")).toBeNull();
  }, { timeout: 3000 });

  // Public 展开后子项可见
  await waitFor(() => {
    expect(treeItem("Downloads")).toBeTruthy();
  }, { timeout: 3000 });
});

// ── 搜索范围限定到用户选择的文件夹 ──

test("搜索结果中的目录可继续展开，懒加载真实子目录", async () => {
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
  _setFsTransport(adaptLegacyTransport({ send: tSend, onMessage: (h: (e: any) => void) => { hSet.add(h); return () => hSet.delete(h); } }));

  try {
    render(<FilePicker onPick={() => {}} onCancel={() => {}} />);
    await waitFor(() => {
      expect(treeItem("projects")).toBeTruthy();
    }, { timeout: 3000 });

    fireEvent.change(screen.getByTestId("file-picker-search"), { target: { value: "demo" } });
    let req: any;
    await waitFor(() => {
      req = sendCalls.find((e: any) => e.type === "fs:search");
      expect(req).toBeTruthy();
    }, { timeout: 3000 });

    // 搜索命中叶子目录 demo（无匹配子项）→ 出现在结果中
    emitEventForTesting({ type: "fs:search:progress", requestId: req.requestId, query: "demo", matches: [{ name: "demo", isDir: true, path: "C:\\Users\\test\\projects\\demo" }] } as any);
    await waitFor(() => {
      expect(treeItem("demo")).toBeTruthy();
    }, { timeout: 3000 });

    // 展开搜索结果里的 demo → 应懒加载其真实子目录
    const demoText = treeItem("demo");
    const arrow = demoText.closest(".rct-tree-item-title-container")?.querySelector(".rct-tree-item-arrow");
    expect(arrow).toBeTruthy();
    fireEvent.click(arrow!);

    await waitFor(() => {
      expect(sendCalls.some((e: any) => e.type === "fs:listDir" && e.path === "C:\\Users\\test\\projects\\demo")).toBe(true);
    }, { timeout: 3000 });
    // 真实子项（文件夹 + 文件）都应显示
    await waitFor(() => {
      expect(treeItem("alpha")).toBeTruthy();
      expect(treeItem("bravo")).toBeTruthy();
      expect(treeItem("z-note.txt")).toBeTruthy();
    }, { timeout: 3000 });
  } finally {
    _setFsTransport(fsTransport); // 恢复共享 transport
  }
});

test("搜索根跟随用户聚焦的目录", async () => {
  render(<FilePicker onPick={() => {}} onCancel={() => {}} defaultPath={PROJECT} />);

  await waitFor(() => {
    expect(treeItem("demo")).toBeTruthy();
  }, { timeout: 3000 });

  // 点击 projects 目录节点 → 设为活动目录
  fireEvent.click(treeItem("projects"));

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
    expect(treeItem("demo")).toBeTruthy();
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
  _setFsTransport(adaptLegacyTransport({ send: tSend, onMessage: (h: (e: any) => void) => { hSet.add(h); return () => hSet.delete(h); } }));

  try {
    render(<FilePicker onPick={() => {}} onCancel={() => {}} defaultPath={PROJECT} />);
    await waitFor(() => {
      expect(treeItem("demo")).toBeTruthy();
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
    emitEventForTesting({ type: "fs:search:progress", requestId: req.requestId, query: "src", matches: [mkMatch()] } as any);
    await waitFor(() => {
      expect(treeItem("src")).toBeTruthy();
    }, { timeout: 3000 });

    // 折叠搜索根 demo → src 消失
    const demoRoot = treeItem("C:\\Users\\test\\projects\\demo");
    const arrow = demoRoot.closest(".rct-tree-item-title-container")?.querySelector(".rct-tree-item-arrow");
    expect(arrow).toBeTruthy();
    fireEvent.click(arrow!);
    await waitFor(() => {
      expect(queryTreeItem("src")).toBeNull();
    }, { timeout: 3000 });

    // 第二批增量（内容相同但 searchTreeItems 引用变化）：
    // autoExpandedRef 已记录搜索根，故增量结果不会重新展开它 → src 保持折叠
    emitEventForTesting({ type: "fs:search:progress", requestId: req.requestId, query: "src", matches: [mkMatch()] } as any);
    await new Promise((r) => setTimeout(r, 300));

    expect(queryTreeItem("src")).toBeNull();
  } finally {
    _setFsTransport(fsTransport); // 恢复共享 transport
  }
});

// ── 显示顺序：先文件夹后文件 ──

test("附件选择器：同一目录下先显示文件夹，后显示文件", async () => {
  render(<FilePicker onPick={() => {}} onCancel={() => {}} defaultPath={PROJECT} />);

  // demo 被默认展开并懒载入其子项（fixtures 中文件在前、文件夹在后交错）
  await waitFor(() => {
    expect(treeItem("alpha")).toBeTruthy();
  }, { timeout: 3000 });

  // 取 demo 节点直接子项，按 DOM 渲染顺序收集文本（svg 图标不贡献文本，只剩名称）
  const demoLi = treeItem("demo").closest(".rct-tree-item-li");
  expect(demoLi).toBeTruthy();
  const group = demoLi!.querySelector("ul.rct-tree-items-container");
  expect(group).toBeTruthy();
  const childTexts = Array.from(group!.children).map((li) => (li.textContent ?? "").trim());

  // demo fixture：文件夹 alpha/bravo，文件 z-note.txt/m-doc.md。
  // 按名称集合区分类型，断言所有文件夹都排在第一个文件之前
  const folderNames = new Set(["alpha", "bravo"]);
  const fileNames = new Set(["z-note.txt", "m-doc.md"]);
  const firstFileIdx = childTexts.findIndex((t) => fileNames.has(t));
  const folderIdxs = childTexts
    .map((t, i) => (folderNames.has(t) ? i : -1))
    .filter((i) => i >= 0);
  expect(firstFileIdx).toBeGreaterThan(-1);
  expect(folderIdxs.length).toBeGreaterThan(0);
  for (const i of folderIdxs) {
    expect(i).toBeLessThan(firstFileIdx);
  }
});

// ── “搜索范围”提示显示在标题下方 ──

test("搜索范围提示显示在“选择文件或文件夹”标题下方", async () => {
  render(<FilePicker onPick={() => {}} onCancel={() => {}} defaultPath={PROJECT} />);

  await waitFor(() => {
    expect(treeItem("demo")).toBeTruthy();
  }, { timeout: 3000 });

  const title = screen.getByText(/选择文件或文件夹/);
  const hint = await screen.findByTestId("search-scope-hint");
  const searchInput = screen.getByTestId("file-picker-search");

  // 文档顺序：标题 → 搜索范围提示 → 搜索输入框
  // 即提示位于标题正下方（左侧栏），而非搜索框所在的右侧栏
  expect(
    title.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    hint.compareDocumentPosition(searchInput) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test("输入搜索内容后“搜索范围”提示仍然显示在标题下方", async () => {
  render(<FilePicker onPick={() => {}} onCancel={() => {}} defaultPath={PROJECT} />);

  // 初始：提示可见
  await waitFor(() => {
    expect(treeItem("demo")).toBeTruthy();
  }, { timeout: 3000 });
  await screen.findByTestId("search-scope-hint");

  // 输入搜索内容并等待搜索请求发出
  fireEvent.change(screen.getByTestId("file-picker-search"), { target: { value: "dem" } });
  await waitFor(() => {
    expect(sendCalls.some((e: any) => e.type === "fs:search")).toBe(true);
  }, { timeout: 3000 });

  // 搜索进行中，提示仍应可见（不被 isSearching 隐藏）
  await waitFor(() => {
    expect(screen.getByTestId("search-scope-hint")).toBeTruthy();
  }, { timeout: 3000 });
});

test("搜索内容变更后清空上一次的搜索结果（新查询无匹配时显示“无匹配结果”）", async () => {
  render(<FilePicker onPick={() => {}} onCancel={() => {}} defaultPath={PROJECT} />);

  await waitFor(() => {
    expect(treeItem("demo")).toBeTruthy();
  }, { timeout: 3000 });

  // 第一次搜索：有匹配，建立搜索结果树（等待 onDone 落定）
  fireEvent.change(screen.getByTestId("file-picker-search"), { target: { value: "dem" } });
  await waitFor(() => {
    expect(screen.getByTestId("search-duration")).toBeTruthy();
  }, { timeout: 3000 });

  // 改为无匹配的查询
  fireEvent.change(screen.getByTestId("file-picker-search"), { target: { value: "zzz" } });

  // 旧结果应被清空：新查询无匹配 → 显示“无匹配结果”，而非残留上一次的结果
  await waitFor(() => {
    expect(screen.getByText("无匹配结果")).toBeTruthy();
  }, { timeout: 3000 });
});

// ── 搜索态切换“显示隐藏目录”不应抛错 ──
// 回归：搜索时 displayItems 是搜索树（path 作 id）；切换 showHidden 会重跑浏览
// mount effect（依赖 [showHidden, defaultPath]），把浏览树定位 id 写入 focusTargetRef，
// 随后的 focus effect 拿这个浏览 id 去 focusItem——但环境 items 仍是搜索树，
// 找不到该 id → onFocusItem(undefined) → handleFocusItem 读 item.index 抛错。

test("搜索态下切换“显示隐藏目录”不应抛错，搜索结果仍可见", async () => {
  const errors: string[] = [];
  const onError = (e: any) => errors.push(String(e?.error?.message ?? e?.message ?? e));
  window.addEventListener("error", onError);

  try {
    render(<FilePicker onPick={() => {}} onCancel={() => {}} defaultPath={PROJECT} />);

    await waitFor(() => {
      expect(treeItem("demo")).toBeTruthy();
    }, { timeout: 3000 });

    // 搜索：建立搜索结果树（path-based id 命名空间）
    fireEvent.change(screen.getByTestId("file-picker-search"), { target: { value: "dem" } });
    await waitFor(() => {
      expect(screen.getByTestId("search-duration")).toBeTruthy();
    }, { timeout: 3000 });

    // 切换显示隐藏目录：浏览 mount effect 重跑并重设浏览树聚焦目标，
    // 但展示数据源仍是搜索树 → focusItem(浏览 id) 不应抛错
    const hiddenToggle = screen.getByTestId("show-hidden-toggle");
    fireEvent.click(hiddenToggle);

    // 让异步 mount effect 链（walkToTarget → setTreeItems → focus effect）落定
    await new Promise((r) => setTimeout(r, 300));

    // 未抛出运行时错误，且搜索结果（demo 节点）仍可见
    expect(errors).toEqual([]);
    expect(treeItem("demo")).toBeTruthy();
  } finally {
    window.removeEventListener("error", onError);
  }
});

// ── 搜索过程中切换“显示隐藏目录”应重新触发搜索 ──
// 搜索 effect 依赖 [searchQuery]，切换 showHidden 不重跑 → 仍按旧的 showHidden 搜索。
// 期望：切换后以新的 showHidden 重新发起 fs:search。

test("搜索过程中切换“显示隐藏目录”会以新的 showHidden 重新触发搜索", async () => {
  render(<FilePicker onPick={() => {}} onCancel={() => {}} defaultPath={PROJECT} />);

  await waitFor(() => {
    expect(treeItem("demo")).toBeTruthy();
  }, { timeout: 3000 });

  // 搜索：发出首轮 fs:search（showHidden=false）
  fireEvent.change(screen.getByTestId("file-picker-search"), { target: { value: "dem" } });
  await waitFor(() => {
    expect(screen.getByTestId("search-duration")).toBeTruthy();
  }, { timeout: 3000 });
  const before = sendCalls.filter((e: any) => e.type === "fs:search").length;
  expect(before).toBeGreaterThan(0);

  // 切换显示隐藏目录 → 应重新发起搜索，且 showHidden=true
  const hiddenToggle = screen.getByTestId("show-hidden-toggle");
  fireEvent.click(hiddenToggle);

  await waitFor(() => {
    const reqs = sendCalls.filter((e: any) => e.type === "fs:search");
    expect(reqs.length).toBeGreaterThan(before);
    expect(reqs[reqs.length - 1].showHidden).toBe(true);
  }, { timeout: 3000 });
});

// 嵌套搜索结果（2 层）用于验证：切换隐藏目录重搜时，搜索树的中间目录不应被
// 浏览 mount effect 的 setExpandedItems 折叠（其结果节点 path 作 id，与浏览 id 不同）。
test("搜索过程中切换“显示隐藏目录”后，嵌套搜索结果保持展开可见", async () => {
  const NESTED = `${PROJECT}\\mid\\leaf`;
  const hSet = new Set<(e: any) => void>();
  const hEmit = (e: any) => hSet.forEach(h => h(e));
  const tSend = mock((e: any) => {
    sendCalls.push(e);
    switch (e.type) {
      case "fs:home": hEmit({ type: "fs:home", home: HOME }); break;
      case "fs:roots": hEmit({ type: "fs:roots", roots: ["C:\\", "D:\\"] }); break;
      case "fs:listDir": hEmit({ type: "fs:listDir", path: e.path, entries: entriesFor(e.path) }); break;
      case "fs:search": {
        const matches = [{ name: "leaf", isDir: false, path: NESTED }];
        setTimeout(() => {
          emitEventForTesting({ type: "fs:search:progress", requestId: e.requestId, query: e.query, matches } as any);
          emitEventForTesting({ type: "fs:search", requestId: e.requestId, query: e.query, matches, durationMs: 0, truncated: false } as any);
        }, 10);
        break;
      }
      default: break;
    }
  });
  _setFsTransport(adaptLegacyTransport({ send: tSend, onMessage: (h: (e: any) => void) => { hSet.add(h); return () => hSet.delete(h); } }));

  try {
    render(<FilePicker onPick={() => {}} onCancel={() => {}} defaultPath={PROJECT} />);
    await waitFor(() => expect(treeItem("demo")).toBeTruthy(), { timeout: 3000 });

    // 搜索 leaf → 嵌套结果 mid/leaf（中间目录 mid 展开后 leaf 可见）
    fireEvent.change(screen.getByTestId("file-picker-search"), { target: { value: "leaf" } });
    await waitFor(() => expect(treeItem("leaf")).toBeTruthy(), { timeout: 3000 });
    const before = sendCalls.filter((e: any) => e.type === "fs:search").length;

    // 切换显示隐藏目录 → 重新搜索
    const hiddenToggle = screen.getByTestId("show-hidden-toggle");
    fireEvent.click(hiddenToggle);

    // 等重新搜索真正发出（此时 mount effect 的 setExpandedItems 早已执行完毕），
    // 避免 waitFor 在折叠发生前就因旧结果可见而提前通过
    await waitFor(() => {
      expect(sendCalls.filter((e: any) => e.type === "fs:search").length).toBeGreaterThan(before);
    }, { timeout: 3000 });

    // 重新搜索落定后，中间目录 mid 应保持展开、leaf 仍可见
    await waitFor(() => expect(treeItem("leaf")).toBeTruthy(), { timeout: 1500 });
  } finally {
    _setFsTransport(fsTransport); // 恢复共享 transport
  }
});

// ── 复选框选择：点击标题不选中，点击复选框才选中 ──

test("点击文件/文件夹标题不会自动选中，添加按钮不显示数量", async () => {
  render(<FilePicker onPick={() => {}} onCancel={() => {}} defaultPath={PROJECT} />);

  await waitFor(() => {
    expect(treeItem("demo")).toBeTruthy();
  }, { timeout: 3000 });

  // 等待 demo 子项懒加载完成
  await waitFor(() => {
    expect(treeItem("z-note")).toBeTruthy();
  }, { timeout: 3000 });

  // 点击文件标题文本（非复选框），应只聚焦不选中
  const fileTitle = treeItem("z-note");
  fireEvent.click(fileTitle);

  // 添加按钮不应包含选中数量
  await waitFor(() => {
    const addBtn = screen.getByTestId("file-picker-ok");
    expect(addBtn.textContent).toBe("添加 ");
  });

  // 也没有 "已选 N 项" 提示
  expect(screen.queryByText(/已选 \d+ 项/)).toBeNull();
});

test("点击复选框可选中文件，添加按钮显示正确数量", async () => {
  render(<FilePicker onPick={() => {}} onCancel={() => {}} defaultPath={PROJECT} />);

  await waitFor(() => {
    expect(treeItem("demo")).toBeTruthy();
  }, { timeout: 3000 });

  // 找到所有复选框并点击第一个
  const checkboxes = screen.getAllByTestId("file-picker-checkbox");
  expect(checkboxes.length).toBeGreaterThan(0);
  fireEvent.click(checkboxes[0]);

  // 添加按钮应显示 (1)
  await waitFor(() => {
    const addBtn = screen.getByTestId("file-picker-ok");
    expect(addBtn.textContent).toBe("添加 (1)");
  });

  // 应有 "已选 1 项" 提示
  expect(screen.getByText(/已选 1 项/)).toBeTruthy();
});

test("可多选多个文件/文件夹，添加按钮显示累计数量", async () => {
  render(<FilePicker onPick={() => {}} onCancel={() => {}} defaultPath={PROJECT} />);

  await waitFor(() => {
    expect(treeItem("demo")).toBeTruthy();
  }, { timeout: 3000 });

  const checkboxes = screen.getAllByTestId("file-picker-checkbox");
  expect(checkboxes.length).toBeGreaterThan(1);

  // 选中两个
  fireEvent.click(checkboxes[0]);
  fireEvent.click(checkboxes[1]);

  await waitFor(() => {
    const addBtn = screen.getByTestId("file-picker-ok");
    expect(addBtn.textContent).toBe("添加 (2)");
  });

  expect(screen.getByText(/已选 2 项/)).toBeTruthy();
});

test("再次点击已选中的复选框可取消选中", async () => {
  render(<FilePicker onPick={() => {}} onCancel={() => {}} defaultPath={PROJECT} />);

  await waitFor(() => {
    expect(treeItem("demo")).toBeTruthy();
  }, { timeout: 3000 });

  const checkboxes = screen.getAllByTestId("file-picker-checkbox");

  // 选中第一个
  fireEvent.click(checkboxes[0]);
  await waitFor(() => {
    const addBtn = screen.getByTestId("file-picker-ok");
    expect(addBtn.textContent).toBe("添加 (1)");
  });

  // 再次点击取消选中
  fireEvent.click(checkboxes[0]);

  await waitFor(() => {
    const addBtn = screen.getByTestId("file-picker-ok");
    expect(addBtn.textContent).toBe("添加 ");
  });

  expect(screen.queryByText(/已选 \d+ 项/)).toBeNull();
});

test("点击添加按钮时 onPick 收到正确选中的文件/文件夹列表", async () => {
  const picks: FilePickerSelection[][] = [];
  render(<FilePicker onPick={(s) => { picks.push(s); }} onCancel={() => {}} defaultPath={PROJECT} />);

  await waitFor(() => {
    expect(treeItem("demo")).toBeTruthy();
  }, { timeout: 3000 });

  const checkboxes = screen.getAllByTestId("file-picker-checkbox");

  // 选中第一个
  fireEvent.click(checkboxes[0]);

  await waitFor(() => {
    const addBtn = screen.getByTestId("file-picker-ok");
    expect(addBtn.textContent).toContain("(1)");
  });

  // 点击添加按钮
  fireEvent.click(screen.getByTestId("file-picker-ok"));

  expect(picks.length).toBe(1);
  expect(picks[0].length).toBe(1);
  // 选中的项应包含 path 和 name
  expect(picks[0][0].path).toBeTruthy();
  expect(picks[0][0].name).toBeTruthy();
});

// ── 搜索范围锁定：搜索过程中点击目录不改变搜索根 ──

test("搜索过程中聚焦目录不改变搜索范围，新搜索仍用原根", async () => {
  render(<FilePicker onPick={() => {}} onCancel={() => {}} defaultPath={PROJECT} />);

  await waitFor(() => {
    expect(treeItem("demo")).toBeTruthy();
  }, { timeout: 3000 });

  // 搜索前先点击 projects 目录 → 设活动目录为 projects
  fireEvent.click(treeItem("projects"));

  // 开始搜索：搜索根应为 projects
  sendCalls.length = 0;
  fireEvent.change(screen.getByTestId("file-picker-search"), { target: { value: "dem" } });
  await waitFor(() => {
    expect(sendCalls.some((e: any) => e.type === "fs:search")).toBe(true);
  }, { timeout: 3000 });

  const firstReqs = sendCalls.filter((e: any) => e.type === "fs:search");
  expect(firstReqs.length).toBeGreaterThan(0);
  for (const r of firstReqs) {
    expect(r.root).toBe("C:\\Users\\test\\projects");
  }

  // 搜索过程中点击 demo 目录（在搜索结果中可见）→ 不应更新搜索根
  // 先等搜索结果渲染出 demo 目录（fs:search 只代表请求已发出，结果是异步到达的，直接点会偶发找不到）
  await waitFor(() => {
    expect(treeItem("demo")).toBeTruthy();
  }, { timeout: 3000 });
  fireEvent.click(treeItem("demo"));

  // 改变搜索词以触发新一轮搜索
  sendCalls.length = 0;
  fireEvent.change(screen.getByTestId("file-picker-search"), { target: { value: "demo" } });
  await waitFor(() => {
    expect(sendCalls.some((e: any) => e.type === "fs:search")).toBe(true);
  }, { timeout: 3000 });

  // 新一轮搜索的根应仍为 projects（未被 demo 点击覆盖）
  const secondReqs = sendCalls.filter((e: any) => e.type === "fs:search");
  expect(secondReqs.length).toBeGreaterThan(0);
  for (const r of secondReqs) {
    expect(r.root).toBe("C:\\Users\\test\\projects");
  }
});
