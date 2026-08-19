import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import { createRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { ComposerResizeHandle } from "../src/components/ui/ComposerResizeHandle";

beforeEach(() => {
    document.body.innerHTML = "";
});

afterEach(() => {
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
});

function renderHandle(opts: { onReset?: () => void } = {}) {
    const targetRef = createRef<HTMLDivElement>();
    const target = document.createElement("div");
    // happy-dom 下 getBoundingClientRect 恒为 0，mock 成起始高度 100
    target.getBoundingClientRect = () =>
        ({ height: 100, top: 0, left: 0, right: 0, bottom: 100, width: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    (targetRef as { current: HTMLDivElement | null }).current = target;
    const onResize = mock(() => {});
    const { unmount } = render(
        <ComposerResizeHandle targetRef={targetRef} onResize={onResize} onReset={opts.onReset} testId="resize-handle" />,
    );
    return { onResize, unmount };
}

test("渲染手柄（row-resize 光标 + data-testid）", () => {
    renderHandle();
    const handle = screen.getByTestId("resize-handle");
    expect(handle.className).toContain("cursor-row-resize");
});

test("向上拖 40px → onResize 收到 起始100+40", () => {
    const { onResize } = renderHandle();
    const handle = screen.getByTestId("resize-handle");
    fireEvent.mouseDown(handle, { clientY: 300 });
    fireEvent.mouseMove(window, { clientY: 260 });
    expect(onResize).toHaveBeenCalledWith(140);
    fireEvent.mouseUp(window);
});

test("拖拽中禁用文本选中，mouseup 后恢复", () => {
    renderHandle();
    const handle = screen.getByTestId("resize-handle");
    fireEvent.mouseDown(handle, { clientY: 300 });
    expect(document.body.style.userSelect).toBe("none");
    expect(document.body.style.cursor).toBe("row-resize");
    fireEvent.mouseUp(window);
    expect(document.body.style.userSelect).toBe("");
    expect(document.body.style.cursor).toBe("");
});

test("mouseup 后继续移动不再触发 onResize", () => {
    const { onResize } = renderHandle();
    const handle = screen.getByTestId("resize-handle");
    fireEvent.mouseDown(handle, { clientY: 300 });
    fireEvent.mouseUp(window);
    onResize.mockClear();
    fireEvent.mouseMove(window, { clientY: 100 });
    expect(onResize).not.toHaveBeenCalled();
});

test("拖拽中卸载：body 样式兜底恢复，mousemove 不再触发 onResize", () => {
    const { onResize, unmount } = renderHandle();
    const handle = screen.getByTestId("resize-handle");
    fireEvent.mouseDown(handle, { clientY: 300 });
    unmount();
    expect(document.body.style.userSelect).toBe("");
    expect(document.body.style.cursor).toBe("");
    fireEvent.mouseMove(window, { clientY: 100 });
    expect(onResize).not.toHaveBeenCalled();
});

test("双击手柄触发 onReset", () => {
    const onReset = mock(() => {});
    renderHandle({ onReset });
    fireEvent.doubleClick(screen.getByTestId("resize-handle"));
    expect(onReset).toHaveBeenCalledTimes(1);
});
