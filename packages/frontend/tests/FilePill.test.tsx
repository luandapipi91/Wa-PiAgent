// FilePill 组件测试：形似文件路径的行内 code 渲染为胶囊，点击弹只读预览。
// mock 范式复用 FilePicker.test.tsx 的 _setFsTransport 传输 seam
// （FsTransport 为 { send, onMessage } 对象形状，send 内同步回放 fs:readFile 响应）。
import { test, expect, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { FilePill } from "../src/components/blocks/FilePill";
import { _setFsTransport } from "../src/fs-client";
import { useProjectsStore } from "../src/store/projects";
import { useToastStore } from "../src/store/toast";

const handlers = new Set<(e: any) => void>();
const emit = (e: any) => handlers.forEach(h => h(e));

beforeEach(() => {
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "demo", cwd: "/work/demo" } as any],
    sessions: [{ id: "s1", projectId: "p1" } as any],
  });
  useToastStore.setState({ toasts: [] });
  _setFsTransport(null);
  handlers.clear();
});

afterEach(() => cleanup());

test("渲染胶囊（basename + 行号），点击弹预览并 readFile 解析到项目 cwd", async () => {
  let requested = "";
  _setFsTransport({
    send: (e: any) => {
      if (e.type === "fs:readFile") {
        requested = e.path;
        emit({ type: "fs:readFile", path: e.path, content: "file-content-123" });
      }
    },
    onMessage: (h: (e: any) => void) => { handlers.add(h); return () => handlers.delete(h); },
  });
  render(<FilePill rawText="src/index.ts:12" sessionId="s1" />);
  const pill = screen.getByTestId("file-pill");
  expect(pill.textContent).toContain("index.ts");
  expect(pill.textContent).toContain(":12");
  fireEvent.click(pill);
  await waitFor(() => expect(screen.getByTestId("file-preview-modal").textContent).toContain("file-content-123"));
  expect(requested).toBe("/work/demo/src/index.ts");
});

test("非路径文本回退为普通 code", () => {
  render(<FilePill rawText="hello" sessionId="s1" />);
  expect(screen.queryByTestId("file-pill")).toBeNull();
});
