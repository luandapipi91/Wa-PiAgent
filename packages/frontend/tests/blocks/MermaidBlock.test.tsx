import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { MermaidBlock } from "../../src/components/blocks/MermaidBlock";

// mock mermaid：happy-dom 无法完成 SVG 布局，mock 后测试组件状态逻辑
mock.module("mermaid", () => {
  return {
    default: {
      initialize: () => {},
      render: (_id: string, code: string) => {
        if (!code || code.includes("invalid")) {
          return Promise.reject(new Error("Parse error: invalid mermaid syntax"));
        }
        return Promise.resolve({
          svg: `<svg width="100" height="100"><text>${code}</text></svg>`,
        });
      },
    },
  };
});

beforeEach(() => {
  document.body.innerHTML = "";
});

test("渲染简单流程图并生成 SVG", async () => {
  render(<MermaidBlock code="graph TD\nA-->B" />);
  const svg = await screen.findByTestId("mermaid-svg", {}, { timeout: 3000 });
  expect(svg).toBeTruthy();
});

test("图表 SVG 包含渲染后的内容", async () => {
  render(<MermaidBlock code="graph LR\n开始-->结束" />);
  const svg = await screen.findByTestId("mermaid-svg", {}, { timeout: 3000 });
  expect(svg.innerHTML).toContain("开始");
  expect(svg.innerHTML).toContain("结束");
});

test("无效语法显示错误提示", async () => {
  render(<MermaidBlock code="this is invalid" />);
  const err = await screen.findByTestId("mermaid-error", {}, { timeout: 3000 });
  expect(err).toBeTruthy();
  expect(err.textContent).toContain("Mermaid");
});

test("渲染过程中显示加载状态", () => {
  render(<MermaidBlock code="graph TD\nA-->B" />);
  const loading = screen.getByTestId("mermaid-loading");
  expect(loading).toBeTruthy();
  expect(loading.textContent).toContain("渲染中");
});

test("SVG 渲染完成后显示放大按钮", async () => {
  render(<MermaidBlock code="graph TD\nA-->B" />);
  await screen.findByTestId("mermaid-svg", {}, { timeout: 3000 });
  const btn = screen.getByTestId("mermaid-zoom-btn");
  expect(btn).toBeTruthy();
});

test("点击放大按钮打开弹窗，显示放大图表", async () => {
  render(<MermaidBlock code="graph TD\nA-->B" />);
  await screen.findByTestId("mermaid-svg", {}, { timeout: 3000 });

  fireEvent.click(screen.getByTestId("mermaid-zoom-btn"));

  // 弹窗出现
  const modal = screen.getByTestId("mermaid-modal");
  expect(modal).toBeTruthy();
  // 弹窗内包含 SVG
  expect(modal.querySelector("svg")).toBeTruthy();
});

test("弹窗右上角关闭按钮点击后关闭弹窗", async () => {
  render(<MermaidBlock code="graph TD\nA-->B" />);
  await screen.findByTestId("mermaid-svg", {}, { timeout: 3000 });

  fireEvent.click(screen.getByTestId("mermaid-zoom-btn"));
  expect(screen.getByTestId("mermaid-modal")).toBeTruthy();

  fireEvent.click(screen.getByTestId("mermaid-modal-close"));
  // 弹窗关闭
  expect(screen.queryByTestId("mermaid-modal")).toBeNull();
});

test("弹窗内图表容器可滚动（overflow-auto class）", async () => {
  render(<MermaidBlock code="graph TD\nA-->B" />);
  await screen.findByTestId("mermaid-svg", {}, { timeout: 3000 });
  fireEvent.click(screen.getByTestId("mermaid-zoom-btn"));

  const viewport = screen.getByTestId("mermaid-modal-viewport");
  expect(viewport.className).toContain("overflow-auto");
});

test("弹窗内 SVG 容器通过拖拽可平移（cursor: grab）", async () => {
  render(<MermaidBlock code="graph TD\nA-->B" />);
  await screen.findByTestId("mermaid-svg", {}, { timeout: 3000 });
  fireEvent.click(screen.getByTestId("mermaid-zoom-btn"));

  const inner = screen.getByTestId("mermaid-modal-inner");
  const style = window.getComputedStyle(inner);
  expect(style.cursor).toBe("grab");
});

test("弹窗头部显示放大(+)和缩小(-)按钮", async () => {
  render(<MermaidBlock code="graph TD\nA-->B" />);
  await screen.findByTestId("mermaid-svg", {}, { timeout: 3000 });
  fireEvent.click(screen.getByTestId("mermaid-zoom-btn"));

  expect(screen.getByTestId("mermaid-zoom-in")).toBeTruthy();
  expect(screen.getByTestId("mermaid-zoom-out")).toBeTruthy();
});

test("点击 + 放大图表（scale 增大）", async () => {
  render(<MermaidBlock code="graph TD\nA-->B" />);
  await screen.findByTestId("mermaid-svg", {}, { timeout: 3000 });
  fireEvent.click(screen.getByTestId("mermaid-zoom-btn"));

  const inner = screen.getByTestId("mermaid-modal-inner");
  // 初始 transform 不含 scale（默认 scale=1）
  const before = inner.style.transform;

  fireEvent.click(screen.getByTestId("mermaid-zoom-in"));
  // 点击 + 后 transform 应包含 scale（>1）
  expect(inner.style.transform).not.toBe(before);
  expect(inner.style.transform).toContain("scale");
});

test("缩小不能低于最小比例", async () => {
  render(<MermaidBlock code="graph TD\nA-->B" />);
  await screen.findByTestId("mermaid-svg", {}, { timeout: 3000 });
  fireEvent.click(screen.getByTestId("mermaid-zoom-btn"));

  // 连续点击 - 多次，不应崩溃且 scale 不会变成负数
  for (let i = 0; i < 20; i++) {
    fireEvent.click(screen.getByTestId("mermaid-zoom-out"));
  }
  const inner = screen.getByTestId("mermaid-modal-inner");
  // 应该仍然有 transform（scale > 0）
  expect(inner.style.transform).toBeTruthy();
});

test("弹窗头部显示当前缩放百分比", async () => {
  render(<MermaidBlock code="graph TD\nA-->B" />);
  await screen.findByTestId("mermaid-svg", {}, { timeout: 3000 });
  fireEvent.click(screen.getByTestId("mermaid-zoom-btn"));

  // 初始 100%
  expect(screen.getByText("100%")).toBeTruthy();

  fireEvent.click(screen.getByTestId("mermaid-zoom-in"));
  fireEvent.click(screen.getByTestId("mermaid-zoom-in"));
  // 点了两次 +，比例 > 100%
  const label = screen.getByTestId("mermaid-scale-label");
  expect(label.textContent).not.toBe("100%");
});

test("滚轮放大缩小图表", async () => {
  render(<MermaidBlock code="graph TD\nA-->B" />);
  await screen.findByTestId("mermaid-svg", {}, { timeout: 3000 });
  fireEvent.click(screen.getByTestId("mermaid-zoom-btn"));

  const viewport = screen.getByTestId("mermaid-modal-viewport");
  const inner = screen.getByTestId("mermaid-modal-inner");
  const before = inner.style.transform;

  // 滚轮向上 = 放大
  fireEvent.wheel(viewport, { deltaY: -100 });
  expect(inner.style.transform).not.toBe(before);
  expect(inner.style.transform).toContain("scale");
});

test("弹窗头部显示复制 mermaid 代码按钮", async () => {
  render(<MermaidBlock code="graph TD\nA-->B" />);
  await screen.findByTestId("mermaid-svg", {}, { timeout: 3000 });
  fireEvent.click(screen.getByTestId("mermaid-zoom-btn"));

  const btn = screen.getByTestId("mermaid-copy-code");
  expect(btn).toBeTruthy();
});

test("点击复制代码按钮将 mermaid 源码写入剪贴板", async () => {
  let copied = "";
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: async (t: string) => { copied = t; } },
    writable: true,
    configurable: true,
  });

  const code = "graph TD\nA-->B";
  render(<MermaidBlock code={code} />);
  await screen.findByTestId("mermaid-svg", {}, { timeout: 3000 });
  fireEvent.click(screen.getByTestId("mermaid-zoom-btn"));

  fireEvent.click(screen.getByTestId("mermaid-copy-code"));
  await new Promise((r) => setTimeout(r, 0));
  expect(copied).toBe(code);
});

test("弹窗头部显示复制图片按钮", async () => {
  render(<MermaidBlock code="graph TD\nA-->B" />);
  await screen.findByTestId("mermaid-svg", {}, { timeout: 3000 });
  fireEvent.click(screen.getByTestId("mermaid-zoom-btn"));

  const btn = screen.getByTestId("mermaid-copy-image");
  expect(btn).toBeTruthy();
});
