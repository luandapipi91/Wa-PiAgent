// FilePicker 组件测试：通过 fs-client 传输 seam 注入伪 WS 响应，
// 验证 defaultPath 定位展开到项目目录、未传时回退主目录、盘符大小写无关匹配。
// 不 mock.module("../src/fs-client")：跨文件缓存会污染 fs-client.test.ts（见该文件说明）。
import { test, expect, mock, beforeEach, afterAll } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
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
    default: return [];
  }
}

const sendMock = mock((e: any) => {
  sendCalls.push(e);
  switch (e.type) {
    case "fs:home": emit({ type: "fs:home", home: HOME }); break;
    case "fs:roots": emit({ type: "fs:roots", roots: ["C:\\", "D:\\"] }); break;
    case "fs:listDir": emit({ type: "fs:listDir", path: e.path, entries: entriesFor(e.path) }); break;
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
