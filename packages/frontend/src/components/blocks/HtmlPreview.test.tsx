import { test, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
import { HtmlPreview } from "./HtmlPreview";

test("渲染 iframe 且带 sandbox 与正确 src", () => {
	render(<HtmlPreview path="/a/b/index.html" />);
	const iframe = screen.getByTestId("html-preview-iframe") as HTMLIFrameElement;
	expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-modals");
	expect(iframe.getAttribute("src")).toBe(
		`/preview/${encodeURIComponent("/a/b")}/index.html`,
	);
});

test("refreshKey 变化重新挂载（key 不同）", () => {
	const { rerender } = render(
		<HtmlPreview path="/a/b/index.html" refreshKey={0} />,
	);
	const first = screen.getByTestId("html-preview-iframe") as HTMLIFrameElement;
	rerender(<HtmlPreview path="/a/b/index.html" refreshKey={1} />);
	const second = screen.getByTestId("html-preview-iframe") as HTMLIFrameElement;
	expect(second).not.toBe(first);
});

test("externalUrl 模式：src 原样 + sandbox 放开 allow-same-origin/allow-popups", () => {
	render(<HtmlPreview externalUrl="https://baidu.com" />);
	const iframe = screen.getByTestId("html-preview-iframe") as HTMLIFrameElement;
	expect(iframe.getAttribute("src")).toBe("https://baidu.com");
	expect(iframe.getAttribute("sandbox")).toBe(
		"allow-scripts allow-same-origin allow-popups allow-modals",
	);
});
