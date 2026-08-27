import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { SidebarResizer } from "../src/components/SidebarResizer";

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", {
    value: 1000,
    configurable: true,
  });
});

// ── 通用 ──

test("渲染分隔条，cursor 为 ew-resize（mac 下 col-resize 字形非箭头）", () => {
  render(
    <SidebarResizer
      side="left"
      getWidth={() => 264}
      onResize={() => {}}
      testId="r"
    />,
  );
  const handle = screen.getByTestId("r");
  expect(handle).toBeTruthy();
  expect(window.getComputedStyle(handle).cursor).toBe("ew-resize");
});

test("视觉宽度 2px（改细）", () => {
  render(
    <SidebarResizer
      side="left"
      getWidth={() => 264}
      onResize={() => {}}
      testId="r"
    />,
  );
  expect(window.getComputedStyle(screen.getByTestId("r")).width).toBe("2px");
});

// ── 左侧（side=left）：向右拖增宽，宽度 = 起始宽 + 位移增量 ──

test("[left] mousedown + mousemove 向右拖 → 起始宽 + 增量", () => {
  const onResize = mock();
  render(
    <SidebarResizer
      side="left"
      getWidth={() => 264}
      onResize={onResize}
      testId="r"
    />,
  );
  fireEvent.mouseDown(screen.getByTestId("r"), { clientX: 264 });
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: 304 }));
  fireEvent.mouseUp(screen.getByTestId("r"));
  expect(onResize).toHaveBeenCalledWith(304);
});

test("[left] 拖超 40% → 钳制到 400（innerWidth=1000）", () => {
  const onResize = mock();
  render(
    <SidebarResizer
      side="left"
      getWidth={() => 264}
      onResize={onResize}
      testId="r"
    />,
  );
  fireEvent.mouseDown(screen.getByTestId("r"), { clientX: 264 });
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: 800 }));
  fireEvent.mouseUp(screen.getByTestId("r"));
  expect(onResize).toHaveBeenCalledWith(400);
});

test("[left] 拖低于 200 → 钳制到 200", () => {
  const onResize = mock();
  render(
    <SidebarResizer
      side="left"
      getWidth={() => 264}
      onResize={onResize}
      testId="r"
    />,
  );
  fireEvent.mouseDown(screen.getByTestId("r"), { clientX: 264 });
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: 50 }));
  fireEvent.mouseUp(screen.getByTestId("r"));
  expect(onResize).toHaveBeenCalledWith(200);
});

// ── 右侧（side=right）：向左拖增宽，宽度 = 起始宽 - 位移增量 ──

test("[right] mousedown + mousemove 向左拖 → 起始宽 - 增量", () => {
  const onResize = mock();
  render(
    <SidebarResizer
      side="right"
      getWidth={() => 320}
      onResize={onResize}
      testId="r"
    />,
  );
  // 面板宽 320，从 clientX=680 按下；向左拖到 clientX=650 → 宽度 320+30=350
  fireEvent.mouseDown(screen.getByTestId("r"), { clientX: 680 });
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: 650 }));
  fireEvent.mouseUp(screen.getByTestId("r"));
  expect(onResize).toHaveBeenCalledWith(350);
});

test("[right] 与绝对位置无关：面板右缘不在视口右缘（分屏场景）", () => {
  const onResize = mock();
  render(
    <SidebarResizer
      side="right"
      getWidth={() => 320}
      onResize={onResize}
      testId="r"
    />,
  );
  // 分屏后面板右缘在 clientX=400（旧实现按 innerWidth-clientX 会跳变到 600+）；
  // 增量计算只认位移：向左拖 60 → 320+60=380
  fireEvent.mouseDown(screen.getByTestId("r"), { clientX: 400 });
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: 340 }));
  fireEvent.mouseUp(screen.getByTestId("r"));
  expect(onResize).toHaveBeenCalledWith(380);
});

test("[right] 向右拖（缩小）→ 宽度减小", () => {
  const onResize = mock();
  render(
    <SidebarResizer
      side="right"
      getWidth={() => 320}
      onResize={onResize}
      testId="r"
    />,
  );
  fireEvent.mouseDown(screen.getByTestId("r"), { clientX: 680 });
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: 720 }));
  fireEvent.mouseUp(screen.getByTestId("r"));
  expect(onResize).toHaveBeenCalledWith(280);
});

test("[right] 拖超 40% → 钳制到 400", () => {
  const onResize = mock();
  render(
    <SidebarResizer
      side="right"
      getWidth={() => 320}
      onResize={onResize}
      testId="r"
    />,
  );
  fireEvent.mouseDown(screen.getByTestId("r"), { clientX: 680 });
  // 向左拖很远：起始 320 + 增量 480 = 800，超过 400 上限
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: 200 }));
  fireEvent.mouseUp(screen.getByTestId("r"));
  expect(onResize).toHaveBeenCalledWith(400);
});

test("[right] 拖低于 200 → 钳制到 200", () => {
  const onResize = mock();
  render(
    <SidebarResizer
      side="right"
      getWidth={() => 320}
      onResize={onResize}
      testId="r"
    />,
  );
  fireEvent.mouseDown(screen.getByTestId("r"), { clientX: 680 });
  // 向右拖很远：起始 320 - 增量 170 = 150，低于 200 下限
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: 850 }));
  fireEvent.mouseUp(screen.getByTestId("r"));
  expect(onResize).toHaveBeenCalledWith(200);
});

// ── mouseup 移除监听 ──

test("mouseup 后继续 mousemove 不再触发 onResize", () => {
  const onResize = mock();
  render(
    <SidebarResizer
      side="left"
      getWidth={() => 264}
      onResize={onResize}
      testId="r"
    />,
  );
  fireEvent.mouseDown(screen.getByTestId("r"), { clientX: 264 });
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: 300 }));
  fireEvent.mouseUp(screen.getByTestId("r"));
  onResize.mockClear();
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: 500 }));
  expect(onResize).not.toHaveBeenCalled();
});
