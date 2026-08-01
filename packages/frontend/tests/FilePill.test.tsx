// FilePill 组件测试：形似文件路径的行内 code 渲染为胶囊，点击弹只读预览。
// 通过 fs-client 的传输 seam 注入伪 REST 响应。
import { test, expect, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { FilePill, resolveAbsolutePath } from "../src/components/blocks/FilePill";
import { _setFsTransport } from "../src/fs-client";
import { useProjectsStore } from "../src/store/projects";
import { useToastStore } from "../src/store/toast";
import { makeFakeFsTransport } from "./fs-transport";

const fake = makeFakeFsTransport();

beforeEach(() => {
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "demo", cwd: "/work/demo" } as any],
    sessions: [{ id: "s1", projectId: "p1" } as any],
  });
  useToastStore.setState({ toasts: [] });
  _setFsTransport(fake.transport);
  fake.calls.length = 0;
  fake.sent.length = 0;
  fake.responses.clear();
});

afterEach(() => cleanup());

test("渲染胶囊（basename + 行号），点击弹预览并 readFile 解析到项目 cwd", async () => {
  fake.setResponse("fs:stat", { exists: true });
  fake.setResponse("fs:readFile", { content: btoa("file-content-123"), mimeType: "text/plain" });
  render(<FilePill rawText="src/index.ts:12" sessionId="s1" />);

  // statFile 异步校验文件存在后显示胶囊
  await waitFor(() => expect(screen.getByTestId("file-pill").textContent).toContain("index.ts"));

  fireEvent.click(screen.getByTestId("file-pill"));
  await waitFor(() => expect(screen.getByTestId("file-preview-modal").textContent).toContain("file-content-123"));
  expect(fake.sent[1]).toMatchObject({ type: "fs:readFile", path: "/work/demo/src/index.ts" });
});

test("resolveAbsolutePath Windows cwd 拼接相对路径时统一为正斜杠", () => {
  useProjectsStore.setState({
    projects: [{ id: "p2", name: "winproj", cwd: "H:\\workspace\\wa-pi" } as any],
    sessions: [{ id: "s2", projectId: "p2" } as any],
  });
  const result = resolveAbsolutePath("routes/fs.ts", "s2");
  expect(result).not.toMatch(/\\[^\\]+\//);
  expect(result).toBe("H:/workspace/wa-pi/routes/fs.ts");
});

test("statFile 返回不存在时回退为纯文本 code", async () => {
  fake.setResponse("fs:stat", { exists: false });
  render(<FilePill rawText="src/missing.ts" sessionId="s1" />);

  await waitFor(() => expect(screen.queryByTestId("file-pill")).toBeNull());
  expect(screen.getByText("src/missing.ts").tagName).toBe("CODE");
});

test("非路径文本回退为普通 code", () => {
  render(<FilePill rawText="hello" sessionId="s1" />);
  expect(screen.queryByTestId("file-pill")).toBeNull();
});

test("预览 Modal 通过 portal 渲染到 document.body（脱离父容器 opacity 上下文）", async () => {
  fake.setResponse("fs:stat", { exists: true });
  fake.setResponse("fs:readFile", { content: btoa("file-content-123"), mimeType: "text/plain" });
  render(<FilePill rawText="src/index.ts:12" sessionId="s1" />);

  await waitFor(() => expect(screen.getByTestId("file-pill").textContent).toContain("index.ts"));
  fireEvent.click(screen.getByTestId("file-pill"));
  await waitFor(() => expect(screen.getByTestId("file-preview-modal")).toBeTruthy());

  // Modal 必须渲染在 body 直接子节点，而不是嵌在 FilePill 所在的 opacity 容器内
  const overlay = screen.getByTestId("modal-overlay");
  expect(overlay.parentElement).toBe(document.body);
});
