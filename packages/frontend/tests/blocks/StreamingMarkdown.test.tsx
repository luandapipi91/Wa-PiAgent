import { test, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
import { StreamingMarkdown } from "../../src/components/blocks/StreamingMarkdown";

test("未闭合代码块渲染纯 <pre>，不出 CodeBlockCard（流式期间跳过 Prism）", () => {
  render(<StreamingMarkdown text={"说明\n\n```js\nconst x = 1;"} sessionId="s1" />);
  expect(screen.getByTestId("streaming-code-plain").textContent).toContain("const x = 1;");
  expect(screen.queryByTestId("code-block-card")).toBeNull();
});

test("闭合代码块渲染 CodeBlockCard，前文 markdown 正常解析", () => {
  render(
    <StreamingMarkdown
      text={"前文 **加粗**\n\n```js\nconst x = 1;\n```\n\n"}
      sessionId="s1"
    />,
  );
  expect(screen.getByTestId("code-block-card")).toBeTruthy();
  expect(screen.getByTestId("text-block").querySelector("strong")?.textContent).toBe("加粗");
});

test("闭合 mermaid 块渲染 MermaidBlock（loading 占位）", () => {
  render(
    <StreamingMarkdown
      text={"```mermaid\ngraph TD;\nA-->B;\n```\n\n"}
      sessionId="s1"
    />,
  );
  expect(screen.getByTestId("mermaid-loading")).toBeTruthy();
  expect(screen.queryByTestId("code-block-card")).toBeNull();
});

test("纯文本（无代码块）整体走 markdown fallback", () => {
  render(<StreamingMarkdown text={"只有 **加粗** 文本\n\n"} sessionId="s1" />);
  expect(screen.getByTestId("text-block").querySelector("strong")?.textContent).toBe("加粗");
  expect(screen.queryByTestId("streaming-code-plain")).toBeNull();
});
