import { test, expect } from "bun:test";
import { render, screen, act } from "@testing-library/react";
import { StreamingOutput } from "../../src/components/blocks/StreamingOutput";

test("流式进行中渲染纯文本预览（markdown 源文原样显示，不解析）", () => {
  render(<StreamingOutput text={"**粗体** 正文"} sessionId="s1" streaming idleMs={10_000} />);
  const plain = screen.getByTestId("streaming-output-plain");
  expect(plain.textContent).toBe("**粗体** 正文");
  expect(plain.querySelector("strong")).toBeNull();
});

test("流式预览中的裸 URL 可点击（轻量链接化，不解析 markdown）", () => {
  render(
    <StreamingOutput
      text={"打开 http://localhost:53213/?key=abc"}
      sessionId="s1"
      streaming
      idleMs={10_000}
    />,
  );
  const plain = screen.getByTestId("streaming-output-plain");
  const a = plain.querySelector("a");
  expect(a?.getAttribute("href")).toBe("http://localhost:53213/?key=abc");
  expect(a?.getAttribute("target")).toBe("_blank");
  // markdown 语法仍不解析
  expect(plain.textContent).toBe("打开 http://localhost:53213/?key=abc");
});

test("停顿 idleMs 后切换为 markdown 渲染", async () => {
  render(<StreamingOutput text={"**粗体**"} sessionId="s1" streaming idleMs={20} />);
  expect(screen.getByTestId("streaming-output-plain")).toBeTruthy();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
  const md = screen.getByTestId("streaming-output-md");
  expect(md.querySelector("strong")?.textContent).toBe("粗体");
});

test("非流式（子代理已完成）直接 markdown 渲染", () => {
  render(<StreamingOutput text={"**粗体**"} sessionId="s1" streaming={false} />);
  expect(screen.queryByTestId("streaming-output-plain")).toBeNull();
  expect(screen.getByTestId("streaming-output-md").querySelector("strong")).toBeTruthy();
});
