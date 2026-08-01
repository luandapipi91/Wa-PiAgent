// FileViewer 组件测试：文本高亮渲染、图片 data URI、unsupported、loading、error 态、关闭回调。
import { test, expect, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { FileViewer } from "../src/components/blocks/FileViewer";
import { _setFsTransport } from "../src/fs-client";
import { makeFakeFsTransport } from "./fs-transport";

const fake = makeFakeFsTransport();

beforeEach(() => {
  _setFsTransport(fake.transport);
  fake.calls.length = 0;
  fake.sent.length = 0;
  fake.responses.clear();
});
afterEach(() => cleanup());

test("文本文件：加载后渲染 base64 解码内容 + 文件名", async () => {
  fake.setResponse("fs:readFile", { content: btoa("hello world"), mimeType: "text/plain" });
  const onClose = () => {};
  render(<FileViewer path="/work/demo/index.ts" onClose={onClose} />);

  await waitFor(() => expect(screen.getByTestId("file-viewer").textContent).toContain("hello world"));
  expect(screen.getByTestId("file-viewer").textContent).toContain("index.ts");
  // 非 md 路径必须走 Prism 行号分支：行号容器存在（防止未来误把非 md 也切到 md 分支）
  expect(screen.getByTestId("file-viewer").querySelector("[data-line]")).not.toBeNull();
});

test("图片文件：拼成 data URI 渲染到 <img>", async () => {
  const b64 = "iVBORw0KGgo="; // 任意合法 base64 片段
  fake.setResponse("fs:readFile", { content: b64, mimeType: "image/png" });
  render(<FileViewer path="/work/demo/logo.png" onClose={() => {}} />);

  await waitFor(() => expect(screen.getByTestId("image-viewer")).toBeTruthy());
  const img = screen.getByAltText("logo.png") as HTMLImageElement;
  expect(img.src).toBe(`data:image/png;base64,${b64}`);
});

test("unsupported 文件：显示不支持占位", async () => {
  // fs-client.readFile 依赖 type === "fs:unsupported" 分支判定，必须带 type 字段
  fake.setResponse("fs:readFile", { type: "fs:unsupported", reason: "不支持的文件类型: application/zip" });
  render(<FileViewer path="/work/demo/a.zip" onClose={() => {}} />);

  await waitFor(() => expect(screen.getByTestId("fv-unsupported").textContent).toContain("不支持预览该文件"));
});

test("读取失败：显示错误态 + 关闭按钮", async () => {
  // 让 readFile 抛错：transport.post 返回空对象 → readFile 因 !res.content throw
  fake.setResponse("fs:readFile", {});
  render(<FileViewer path="/work/demo/x.txt" onClose={() => {}} />);

  await waitFor(() => expect(screen.getByTestId("fv-error").textContent).toContain("无法读取文件"));
});

test("点击关闭按钮触发 onClose", async () => {
  fake.setResponse("fs:readFile", { content: btoa("x"), mimeType: "text/plain" });
  let closed = false;
  render(<FileViewer path="/work/demo/a.txt" onClose={() => { closed = true; }} />);

  await waitFor(() => expect(screen.getByTestId("file-viewer")).toBeTruthy());
  fireEvent.click(screen.getByTitle("关闭"));
  expect(closed).toBe(true);
});

// ===== md 预览渲染 =====

const MD_SAMPLE = `# Preview Title

| ColA | ColB |
|------|------|
| 1    | 2    |

\`\`\`ts
const x = 1;
\`\`\`

\`\`\`mermaid
graph TD
  A[Start] --> B[End]
\`\`\`
`;

test("md 文件：渲染为 markdown（h1/table/pre），不出现 Prism 行号容器", async () => {
  fake.setResponse("fs:readFile", { content: btoa(MD_SAMPLE), mimeType: "text/markdown" });
  render(<FileViewer path="/work/demo/README.md" onClose={() => {}} />);

  await waitFor(() => expect(screen.getByTestId("text-block")).toBeTruthy());
  const textBlock = screen.getByTestId("text-block");
  expect(textBlock.querySelector("h1")?.textContent).toBe("Preview Title");
  expect(textBlock.querySelector("table")).toBeTruthy();
  expect(textBlock.querySelector("pre")).toBeTruthy();
  // md 渲染不走 FileViewer 的 Prism 分支：不出现行号容器
  expect(screen.getByTestId("file-viewer").querySelector("[data-line]")).toBeNull();
  // mermaid 代码块走 MermaidBlock 渲染（异步 debounce → mermaid.render）
  // 实测 happy-dom 下 mermaid.render 的 promise 既不 resolve 也不 reject，组件停留在
  // mermaid-loading 态（渲染链路本身正常，是测试环境限制）。故断言任一 mermaid 容器
  // （loading/svg/error）出现，证明该代码块走了 MermaidBlock 分支即可。
  await waitFor(() => {
    const fv = screen.getByTestId("file-viewer");
    const mermaidEl = fv.querySelector(
      "[data-testid='mermaid-loading'], [data-testid='mermaid-svg'], [data-testid='mermaid-error']",
    );
    expect(mermaidEl).not.toBeNull();
  }, { timeout: 5000 });
});

test("md 文件：内联路径复用聊天区渲染为文件胶囊", async () => {
  fake.setResponse("fs:readFile", { content: btoa("# T\n\n`docs/a.md`\n"), mimeType: "text/markdown" });
  fake.setResponse("fs:stat", { exists: true });
  render(<FileViewer path="/work/demo/README.md" onClose={() => {}} sessionId="s1" />);

  await waitFor(() => expect(screen.getByTestId("file-pill")).toBeTruthy());
});
