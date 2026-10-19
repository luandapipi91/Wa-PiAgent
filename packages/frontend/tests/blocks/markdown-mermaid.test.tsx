import { test, expect, mock } from "bun:test";
import { render, screen } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import { createMarkdownComponents } from "../../src/components/blocks/markdown-components";

// mock mermaid
mock.module("mermaid", () => ({
  default: {
    initialize: () => {},
    render: (_id: string, code: string) => {
      if (!code || code.includes("INVALID")) {
        return Promise.reject(new Error("Parse error"));
      }
      return Promise.resolve({
        svg: `<svg width="100" height="100"><text>${code}</text></svg>`,
      });
    },
  },
}));

test("mermaid 代码块渲染为 MermaidBlock（SVG）", async () => {
  const components = createMarkdownComponents("s1");
  render(
    <ReactMarkdown components={components}>
      {"```mermaid\ngraph TD\nA-->B\n```"}
    </ReactMarkdown>,
  );

  const svg = await screen.findByTestId("mermaid-svg", {}, { timeout: 3000 });
  expect(svg).toBeTruthy();
});

test("非 mermaid 代码块仍然渲染为 CodeBlockCard", () => {
  const components = createMarkdownComponents("s1");
  render(
    <ReactMarkdown components={components}>
      {"```typescript\nconst x = 1;\n```"}
    </ReactMarkdown>,
  );

  expect(screen.getByTestId("code-block-card")).toBeTruthy();
});

test("无语言标注的代码块渲染为 CodeBlockCard", () => {
  const components = createMarkdownComponents("s1");
  render(
    <ReactMarkdown components={components}>
      {"```\nplain text\n```"}
    </ReactMarkdown>,
  );

  expect(screen.getByTestId("code-block-card")).toBeTruthy();
});

test("mermaid 代码块无效语法渲染错误", async () => {
  const components = createMarkdownComponents("s1");
  render(
    <ReactMarkdown components={components}>
      {"```mermaid\nINVALID\n```"}
    </ReactMarkdown>,
  );

  const err = await screen.findByTestId("mermaid-error", {}, { timeout: 3000 });
  expect(err).toBeTruthy();
});
