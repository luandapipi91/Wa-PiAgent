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
  fake.setResponse("fs:readFile", { content: btoa("file-content-123"), mimeType: "text/plain" });
  render(<FilePill rawText="src/index.ts:12" sessionId="s1" />);
  
  // 异步校验文件存在后应显示胶囊
  await waitFor(() => expect(screen.getByTestId("file-pill").textContent).toContain("index.ts"));
  
  fireEvent.click(screen.getByTestId("file-pill"));
  await waitFor(() => expect(screen.getByTestId("file-preview-modal").textContent).toContain("file-content-123"));
  expect(fake.sent[1]).toMatchObject({ type: "fs:readFile", path: "/work/demo/src/index.ts" });
});

test("resolveAbsolutePath Windows cwd 拼接相对路径时统一为正斜杠", () => {
  useProjectsStore.setState({
    projects: [{ id: "p2", name: "winproj", cwd: "H:\\workspace\\hiagent" } as any],
    sessions: [{ id: "s2", projectId: "p2" } as any],
  });
  const result = resolveAbsolutePath("routes/fs.ts", "s2");
  // 不应出现混用 \\ 和 / 的分隔符
  expect(result).not.toMatch(/\\[^\\]+\//);
  // 应统一为正向斜杠
  expect(result).toBe("H:/workspace/hiagent/routes/fs.ts");
});

test("文件不存在时回退为纯文本 code", async () => {
  // readFile 返回 ENOENT → 不显示胶囊，回退为 <code>
  fake.setResponse("fs:readFile", { reason: "ENOENT: no such file or directory" });
  render(<FilePill rawText="src/missing.ts" sessionId="s1" />);
  
  // 应显示纯文本而非胶囊
  await waitFor(() => {
    expect(screen.queryByTestId("file-pill")).toBeNull();
  });
  // 应有纯文本 code 元素
  expect(screen.getByText("src/missing.ts").tagName).toBe("CODE");
});

test("非路径文本回退为普通 code", () => {
  render(<FilePill rawText="hello" sessionId="s1" />);
  expect(screen.queryByTestId("file-pill")).toBeNull();
});
