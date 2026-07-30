// ExplorerPanel 组件测试：目录展开/折叠、文件双击预览、右键菜单。
import { test, expect, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { ExplorerPanel } from "../src/components/ExplorerPanel";
import { _setFsTransport } from "../src/fs-client";
import { makeFakeFsTransport } from "./fs-transport";
import { useToastStore } from "../src/store/toast";

const fake = makeFakeFsTransport();

beforeEach(() => {
  _setFsTransport(fake.transport);
  useToastStore.setState({ toasts: [] });
  fake.calls.length = 0;
  fake.sent.length = 0;
  fake.responses.clear();
});
afterEach(() => cleanup());

// listDir 返回 DirEntry{name,isDir}；fs-transport 把 POST /api/fs/list-dir 映射为 fs:listDir
test("初始加载根目录，点击目录展开子项，再点折叠", async () => {
  fake.setResponse("fs:listDir", { entries: [
    { name: "src", isDir: true },
    { name: "readme.md", isDir: false },
  ] });
  const { rerender } = render(<ExplorerPanel workspaceDir="/work/demo" onOpenFile={() => {}} />);

  // 根目录加载
  await waitFor(() => expect(screen.getByText("src")).toBeTruthy());
  expect(screen.getByText("readme.md")).toBeTruthy();

  // 展开 src：第二次 listDir 返回子项
  fake.setResponse("fs:listDir", { entries: [{ name: "index.ts", isDir: false }] });
  fireEvent.click(screen.getByText("src"));
  await waitFor(() => expect(screen.getByText("index.ts")).toBeTruthy());

  // 再次点击 src 折叠（用 text "src" 定位节点）
  fireEvent.click(screen.getByText("src"));
  await waitFor(() => expect(screen.queryByText("index.ts")).toBeNull());
});

test("双击文件触发 onOpenFile（绝对路径）", async () => {
  fake.setResponse("fs:listDir", { entries: [{ name: "a.ts", isDir: false }] });
  const ref = { opened: null as string | null };
  render(<ExplorerPanel workspaceDir="/work/demo" onOpenFile={(p) => { ref.opened = p; }} />);

  await waitFor(() => expect(screen.getByText("a.ts")).toBeTruthy());
  fireEvent.doubleClick(screen.getByText("a.ts"));
  expect(ref.opened).toBe("/work/demo/a.ts");
});

test("右键文件弹出菜单，含复制路径项", async () => {
  fake.setResponse("fs:listDir", { entries: [{ name: "b.ts", isDir: false }] });
  render(<ExplorerPanel workspaceDir="/work/demo" onOpenFile={() => {}} />);

  const node = await waitFor(() => screen.getByText("b.ts"));
  fireEvent.contextMenu(node);
  await waitFor(() => expect(screen.getByText("复制路径")).toBeTruthy());
  expect(screen.getByText("在访达中显示")).toBeTruthy();
});

test("未设置 workspaceDir 显示占位", () => {
  render(<ExplorerPanel workspaceDir="" onOpenFile={() => {}} />);
  expect(screen.getByText("未设置工作目录")).toBeTruthy();
});
