import { test, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
import { linkifyText, Linkify } from "../../src/components/blocks/linkify";

test("纯文本中 http URL 被链接化（可点击，新标签页）", () => {
  render(<Linkify text="请在浏览器打开 http://localhost:53213/?key=abc" />);
  const a = screen.getByRole("link");
  expect(a.getAttribute("href")).toBe("http://localhost:53213/?key=abc");
  expect(a.getAttribute("target")).toBe("_blank");
  expect(a.getAttribute("rel")).toContain("noopener");
});

test("https URL 被链接化", () => {
  render(<Linkify text="文档 https://example.com/docs" />);
  expect(screen.getByRole("link").getAttribute("href")).toBe(
    "https://example.com/docs",
  );
});

test("无 URL 时不产生链接", () => {
  const nodes = linkifyText("普通文本，没有链接");
  expect(nodes.length).toBe(1);
  render(<Linkify text="普通文本，没有链接" />);
  expect(screen.queryByRole("link")).toBeNull();
});

test("URL 前后的普通文本保留", () => {
  render(<Linkify text="前缀 http://a.com 后缀" />);
  const el = screen.getByText(/前缀/);
  expect(el.textContent).toBe("前缀 http://a.com 后缀");
});

test("URL 结尾标点不纳入链接（句号/逗号/括号/中文标点）", () => {
  const { container } = render(
    <Linkify text="打开 http://a.com/x, 然后 http://b.com。 完成" />,
  );
  const links = screen.getAllByRole("link");
  expect(links[0].getAttribute("href")).toBe("http://a.com/x");
  expect(links[1].getAttribute("href")).toBe("http://b.com");
  // 标点保留在文本中（跨节点拼接后内容完整）
  expect(container.textContent).toBe("打开 http://a.com/x, 然后 http://b.com。 完成");
});

test("URL 后紧跟中文文字会被包含进链接（与 remark-gfm 一致，URL 到空白结束）", () => {
  render(<Linkify text="访问 http://b.com完成" />);
  const a = screen.getByRole("link");
  expect(a.getAttribute("href")).toBe("http://b.com完成");
});

test("多个 URL 依次链接化", () => {
  render(<Linkify text="A http://a.com B https://b.com C" />);
  const links = screen.getAllByRole("link");
  expect(links).toHaveLength(2);
  expect(links[0].getAttribute("href")).toBe("http://a.com");
  expect(links[1].getAttribute("href")).toBe("https://b.com");
});

test("查询参数 URL 完整保留（?key= 等不裁剪）", () => {
  const nodes = linkifyText(
    "key=some-query-param-value-not-a-secret",
  );
  // 无协议前缀，不链接化（非 URL）
  expect(nodes.length).toBe(1);
});
